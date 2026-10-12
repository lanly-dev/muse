/* Muse player webview.
 *
 * Two sound sources:
 *   1. Built-in generative synth — three "stations" compose endless,
 *      loopable melodies. Because the synth knows every note it plays,
 *      the chroma (pitch-class) analysis is exact.
 *   2. Local audio files — decoded and run through a real FFT-based
 *      chromagram, spectral centroid and RMS energy analysis.
 *
 * Every ~90ms the current audio features are posted to the extension,
 * which maps them to workbench colors.
 */
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();

	// ---------------------------------------------------------------- stations

	/** Generative "radio stations". scale = semitone offsets (pentatonic). */
	const STATIONS = [
		{
			id: 'neon-rain',
			name: 'Neon Rain',
			desc: 'Rainy-night lofi · A minor',
			root: 45, // A2
			bpm: 92,
			scale: [0, 3, 5, 7, 10],
			prog: [0, 3, 1, 4], // scale-degree chord roots, 2 bars each
			brightness: 0.35,
			hatGain: 0.1,
			kick: false,
			leadWave: 'triangle',
			padWave: 'sine',
			bassWave: 'sine',
		},
		{
			id: 'solar-drift',
			name: 'Solar Drift',
			desc: 'Warm morning pads · C major',
			root: 48, // C3
			bpm: 76,
			scale: [0, 2, 4, 7, 9],
			prog: [0, 4, 3, 4 - 1], // I vi IV V-ish in scale degrees
			brightness: 0.62,
			hatGain: 0.05,
			kick: false,
			leadWave: 'sine',
			padWave: 'triangle',
			bassWave: 'sine',
		},
		{
			id: 'night-drive',
			name: 'Night Drive',
			desc: 'Synthwave pulse · G dorian',
			root: 43, // G2
			bpm: 104,
			scale: [0, 2, 3, 7, 9],
			prog: [0, 2, 4, 3],
			brightness: 0.72,
			hatGain: 0.14,
			kick: true,
			leadWave: 'sawtooth',
			padWave: 'sawtooth',
			bassWave: 'sawtooth',
		},
	];

	// ------------------------------------------------------------------- state

	let ctx = null;
	let master = null;
	let analyser = null;
	let freqData = null;
	let timeData = null;

	let mode = 'idle'; // 'idle' | 'synth' | 'file'
	let playing = false;
	let stationIndex = 0;
	let volume = 0.8;

	// synth scheduler state
	let schedTimer = null;
	let nextNoteTime = 0;
	let step = 0;
	let leadDegree = 5;
	let noiseBuf = null;

	// file playback state
	let fileSource = null;
	let fileName = '';
	let loopFile = false;

	// analysis state
	const chroma = new Float32Array(12);
	let energySmooth = 0;
	let brightSmooth = 0.5;
	let pulse = 0;
	let analysisTimer = null;

	let pendingAction = null; // transport requested while ctx suspended

	// ------------------------------------------------------------------- audio

	function ensureCtx() {
		if (ctx) {
			return ctx;
		}
		const AC = window.AudioContext || window.webkitAudioContext;
		ctx = new AC({ latencyHint: 'interactive' });
		master = ctx.createGain();
		master.gain.value = volume;
		const comp = ctx.createDynamicsCompressor();
		comp.threshold.value = -18;
		comp.ratio.value = 4;
		analyser = ctx.createAnalyser();
		analyser.fftSize = 2048;
		analyser.smoothingTimeConstant = 0.55;
		freqData = new Uint8Array(analyser.frequencyBinCount);
		timeData = new Uint8Array(analyser.fftSize);
		master.connect(comp);
		comp.connect(analyser);
		analyser.connect(ctx.destination);
		noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
		const d = noiseBuf.getChannelData(0);
		for (let i = 0; i < d.length; i++) {
			d[i] = Math.random() * 2 - 1;
		}
		return ctx;
	}

	function tryResume() {
		ensureCtx();
		if (ctx.state === 'suspended') {
			ctx.resume().then(checkGate).catch(checkGate);
		} else {
			checkGate();
		}
	}

	function checkGate() {
		document.getElementById('audio-gate').classList.toggle(
			'hidden',
			!ctx || ctx.state !== 'suspended' || !playing
		);
		if (ctx && ctx.state === 'running' && pendingAction) {
			const a = pendingAction;
			pendingAction = null;
			a();
		}
	}

	['pointerdown', 'keydown'].forEach((ev) =>
		window.addEventListener(ev, () => {
			if (ctx && ctx.state === 'suspended') {
				tryResume();
			}
		})
	);

	const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

	function addChroma(midi, vel) {
		const pc = ((Math.round(midi) % 12) + 12) % 12;
		chroma[pc] += vel;
		pulse += vel * 0.35;
	}

	// ------------------------------------------------------------------- synth

	function semis(station, degree) {
		const scale = station.scale;
		const n = scale.length;
		const oct = Math.floor(degree / n);
		const idx = ((degree % n) + n) % n;
		return oct * 12 + scale[idx];
	}

	function pluck(midi, t, dur, wave, gainVal, filterFreq) {
		const o = ctx.createOscillator();
		o.type = wave;
		o.frequency.value = midiHz(midi);
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.exponentialRampToValueAtTime(Math.max(0.001, gainVal), t + 0.008);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		const f = ctx.createBiquadFilter();
		f.type = 'lowpass';
		f.frequency.value = filterFreq || 3200;
		o.connect(f);
		f.connect(g);
		g.connect(master);
		o.start(t);
		o.stop(t + dur + 0.05);
		addChroma(midi, gainVal);
	}

	function pad(midiNotes, t, dur, wave, gainVal) {
		midiNotes.forEach((midi) => {
			const o = ctx.createOscillator();
			o.type = wave;
			o.frequency.value = midiHz(midi);
			const g = ctx.createGain();
			g.gain.setValueAtTime(0.0001, t);
			g.gain.linearRampToValueAtTime(gainVal, t + 0.9);
			g.gain.setValueAtTime(gainVal, t + dur - 0.6);
			g.gain.linearRampToValueAtTime(0.0001, t + dur);
			const f = ctx.createBiquadFilter();
			f.type = 'lowpass';
			f.frequency.value = 1400;
			o.connect(f);
			f.connect(g);
			g.connect(master);
			o.start(t);
			o.stop(t + dur + 0.05);
			addChroma(midi, gainVal * 1.4);
		});
	}

	function hat(t, gainVal) {
		const s = ctx.createBufferSource();
		s.buffer = noiseBuf;
		const f = ctx.createBiquadFilter();
		f.type = 'highpass';
		f.frequency.value = 7000;
		const g = ctx.createGain();
		g.gain.setValueAtTime(gainVal, t);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
		s.connect(f);
		f.connect(g);
		g.connect(master);
		s.start(t);
		s.stop(t + 0.06);
		pulse += gainVal * 0.4;
	}

	function kick(t) {
		const o = ctx.createOscillator();
		o.type = 'sine';
		o.frequency.setValueAtTime(130, t);
		o.frequency.exponentialRampToValueAtTime(42, t + 0.1);
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.5, t);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
		o.connect(g);
		g.connect(master);
		o.start(t);
		o.stop(t + 0.2);
		pulse += 0.3;
		addChroma(36, 0.2);
	}

	function scheduleStep(station, stepIdx, t) {
		const inBar = stepIdx % 16;
		const bar = Math.floor(stepIdx / 16);
		const chordDeg = station.prog[Math.floor(bar / 2) % station.prog.length];
		const chordRoot = station.root + semis(station, chordDeg);
		const spb = 60 / station.bpm;
		const barDur = spb * 4;

		// pad on chord change
		if (inBar === 0 && bar % 2 === 0) {
			pad(
				[chordRoot + 12, chordRoot + 12 + semis(station, 2), chordRoot + 12 + semis(station, 4)],
				t,
				barDur * 2,
				station.padWave,
				0.05
			);
		}
		// bass
		if (inBar === 0 || inBar === 8) {
			pluck(chordRoot - 12, t, spb * 1.6, station.bassWave, 0.22, 500);
		} else if (inBar === 14 && Math.random() < 0.5) {
			pluck(chordRoot - 12 + semis(station, 3), t, spb * 0.9, station.bassWave, 0.14, 500);
		}
		// kick
		if (station.kick && inBar % 4 === 0) {
			kick(t);
		}
		// hats on off-8ths
		if (inBar % 4 === 2) {
			hat(t, station.hatGain * (inBar % 8 === 2 ? 1 : 0.6));
		}
		// lead: random walk on 8ths
		if (inBar % 2 === 0 && Math.random() < 0.6) {
			leadDegree += [-2, -1, -1, 1, 1, 2][Math.floor(Math.random() * 6)];
			leadDegree = Math.max(2, Math.min(2 * station.scale.length + 1, leadDegree));
			const midi = station.root + 24 + semis(station, leadDegree);
			pluck(midi, t, spb * 1.1, station.leadWave, 0.11, 4200);
		}
	}

	function startScheduler() {
		stopScheduler();
		const station = STATIONS[stationIndex];
		const stepDur = 60 / station.bpm / 4;
		nextNoteTime = ctx.currentTime + 0.08;
		step = 0;
		schedTimer = setInterval(() => {
			while (nextNoteTime < ctx.currentTime + 0.18) {
				scheduleStep(station, step, nextNoteTime);
				nextNoteTime += stepDur;
				step++;
			}
		}, 45);
	}

	function stopScheduler() {
		if (schedTimer) {
			clearInterval(schedTimer);
			schedTimer = null;
		}
	}

	// -------------------------------------------------------------------- file

	async function playFile(fileUri, name) {
		ensureCtx();
		stopFileSource();
		stopScheduler();
		fileName = name || 'Audio file';
		try {
			const res = await fetch(fileUri);
			if (!res.ok) {
				throw new Error('fetch failed: ' + res.status);
			}
			const buf = await res.arrayBuffer();
			const audioBuf = await ctx.decodeAudioData(buf);
			const src = ctx.createBufferSource();
			src.buffer = audioBuf;
			src.loop = loopFile;
			src.connect(master);
			src.onended = () => {
				if (mode === 'file' && playing && !loopFile) {
					onTrackEnded();
				}
			};
			fileSource = src;
			mode = 'file';
			playing = true;
			src.start();
			reportTrack();
		} catch (err) {
			vscode.postMessage({
				type: 'error',
				message: 'Could not play file: ' + (err && err.message ? err.message : err),
			});
			mode = 'idle';
			playing = false;
			reportTrack();
		}
	}

	function stopFileSource() {
		if (fileSource) {
			try {
				fileSource.onended = null;
				fileSource.stop();
			} catch (e) { /* already stopped */ }
			try {
				fileSource.disconnect();
			} catch (e) { /* noop */ }
			fileSource = null;
		}
	}

	// ---------------------------------------------------------------- analysis

	function analyzeFileFrame() {
		// reset and rebuild a real chromagram from the FFT
		chroma.fill(0);
		analyser.getByteFrequencyData(freqData);
		const binHz = ctx.sampleRate / analyser.fftSize;
		let total = 0;
		for (let i = 1; i < freqData.length; i++) {
			const v = freqData[i];
			if (v < 4) {
				continue;
			}
			const f = i * binHz;
			if (f < 55 || f > 8000) {
				continue;
			}
			const midiF = 69 + 12 * Math.log2(f / 440);
			const pc = ((Math.round(midiF) % 12) + 12) % 12;
			chroma[pc] += v / 255;
			total += v / 255;
		}
		analyser.getByteTimeDomainData(timeData);
		let sum = 0;
		for (let i = 0; i < timeData.length; i++) {
			const s = (timeData[i] - 128) / 128;
			sum += s * s;
		}
		const rms = Math.sqrt(sum / timeData.length);
		// spectral centroid -> brightness
		analyser.getByteFrequencyData(freqData);
		let wSum = 0;
		let fSum = 0;
		for (let i = 1; i < freqData.length; i++) {
			const v = freqData[i] / 255;
			const f = i * binHz;
			if (f < 80 || f > 12000) {
				continue;
			}
			wSum += v * f;
			fSum += v;
		}
		const centroid = fSum > 0 ? wSum / fSum : 800;
		const brightness = Math.min(
			1,
			Math.max(0, Math.log2(centroid / 200) / Math.log2(6000 / 200))
		);
		return { energy: Math.min(1, rms * 3.2), brightness };
	}

	function startAnalysis() {
		stopAnalysis();
		analysisTimer = setInterval(() => {
			if (!playing) {
				return;
			}
			if (mode === 'synth') {
				for (let i = 0; i < 12; i++) {
					chroma[i] *= 0.9;
				}
				pulse *= 0.9;
			}
			let energy;
			let brightness;
			if (mode === 'file') {
				const a = analyzeFileFrame();
				energy = a.energy;
				brightness = a.brightness;
			} else {
				const station = STATIONS[stationIndex];
				energy = Math.min(1, pulse * 0.55);
				brightness = Math.min(1, Math.max(0, station.brightness + pulse * 0.12));
			}
			energySmooth += (energy - energySmooth) * 0.4;
			brightSmooth += (brightness - brightSmooth) * 0.25;
			vscode.postMessage({
				type: 'features',
				features: {
					chroma: Array.from(chroma),
					energy: energySmooth,
					brightness: brightSmooth,
				},
				track: currentTrackInfo(),
				playing: true,
			});
			drawViz();
		}, 90);
	}

	function stopAnalysis() {
		if (analysisTimer) {
			clearInterval(analysisTimer);
			analysisTimer = null;
		}
	}

	// ------------------------------------------------------------------- track

	function currentTrackInfo() {
		if (mode === 'synth') {
			const s = STATIONS[stationIndex];
			return { title: s.name, subtitle: s.desc + ' · generative', kind: 'synth' };
		}
		if (mode === 'file') {
			return { title: fileName, subtitle: 'local audio file', kind: 'file' };
		}
		return { title: 'Nothing playing', subtitle: 'Pick a station or open an audio file', kind: 'synth' };
	}

	function reportTrack(ended) {
		const info = currentTrackInfo();
		document.getElementById('track-title').textContent = info.title;
		document.getElementById('track-subtitle').textContent = info.subtitle;
		document.getElementById('btn-play').textContent = playing ? '⏸' : '▶';
		document.querySelectorAll('.station').forEach((el) => {
			el.classList.toggle(
				'active',
				mode === 'synth' && playing && el.dataset.station === STATIONS[stationIndex].id
			);
		});
		vscode.postMessage({
			type: 'track',
			track: mode === 'idle' ? undefined : info,
			playing,
			ended: !!ended,
		});
	}

	function onTrackEnded() {
		mode = 'idle';
		playing = false;
		stopAnalysis();
		checkGate();
		reportTrack(true);
	}

	// --------------------------------------------------------------- transport

	function doPlaySynth(stationId) {
		ensureCtx();
		if (ctx.state === 'suspended') {
			pendingAction = () => doPlaySynth(stationId === '__next' ? '__next' : STATIONS[stationIndex].id);
			tryResume();
			return;
		}
		if (stationId === '__next') {
			stationIndex = (stationIndex + 1) % STATIONS.length;
		} else if (stationId) {
			const i = STATIONS.findIndex((s) => s.id === stationId);
			if (i >= 0) {
				stationIndex = i;
			}
		}
		stopFileSource();
		mode = 'synth';
		playing = true;
		leadDegree = 5;
		chroma.fill(0);
		pulse = 0;
		startScheduler();
		startAnalysis();
		checkGate();
		reportTrack();
	}

	function doPause() {
		if (!ctx) {
			return;
		}
		playing = false;
		ctx.suspend().then(() => {
			checkGate();
			reportTrack();
		});
	}

	function doResume() {
		ensureCtx();
		if (mode === 'idle') {
			doPlaySynth(STATIONS[stationIndex].id);
			return;
		}
		if (ctx.state === 'suspended') {
			pendingAction = () => {
				playing = true;
				// re-anchor the scheduler so notes don't burst after suspend
				if (mode === 'synth') {
					const station = STATIONS[stationIndex];
					const stepDur = 60 / station.bpm / 4;
					nextNoteTime = ctx.currentTime + 0.08;
					void stepDur;
				}
				checkGate();
				reportTrack();
			};
			tryResume();
			return;
		}
		playing = true;
		checkGate();
		reportTrack();
	}

	function doToggle() {
		if (playing) {
			doPause();
		} else {
			doResume();
		}
	}

	function doStop() {
		playing = false;
		mode = 'idle';
		stopScheduler();
		stopFileSource();
		stopAnalysis();
		chroma.fill(0);
		if (ctx && ctx.state === 'running') {
			ctx.suspend();
		}
		checkGate();
		reportTrack();
	}

	// ------------------------------------------------------------------- viz

	const canvas = document.getElementById('viz');
	const g2d = canvas.getContext('2d');
	const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

	function chromaHue() {
		let x = 0;
		let y = 0;
		let total = 0;
		for (let pc = 0; pc < 12; pc++) {
			const w = chroma[pc];
			if (w <= 0) {
				continue;
			}
			const a = (pc / 12) * Math.PI * 2;
			x += w * Math.cos(a);
			y += w * Math.sin(a);
			total += w;
		}
		if (total <= 0) {
			return 210;
		}
		return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
	}

	function drawViz() {
		const W = canvas.width;
		const H = canvas.height;
		const hue = chromaHue();
		const grad = g2d.createLinearGradient(0, 0, 0, H);
		grad.addColorStop(0, `hsla(${hue}, 60%, 22%, 1)`);
		grad.addColorStop(1, '#101010');
		g2d.fillStyle = grad;
		g2d.fillRect(0, 0, W, H);
		const max = Math.max(0.001, ...chroma);
		const bw = W / 12;
		for (let pc = 0; pc < 12; pc++) {
			const v = chroma[pc] / max;
			const bh = Math.max(2, v * (H - 34));
			const pcHue = pc * 30;
			g2d.fillStyle = `hsla(${pcHue}, 75%, ${30 + v * 30}%, 0.95)`;
			g2d.fillRect(pc * bw + 3, H - 20 - bh, bw - 6, bh);
			g2d.fillStyle = 'rgba(255,255,255,0.45)';
			g2d.font = '10px sans-serif';
			g2d.textAlign = 'center';
			g2d.fillText(NOTE_NAMES[pc], pc * bw + bw / 2, H - 6);
		}
	}

	// --------------------------------------------------------------------- ui

	function renderStations() {
		const wrap = document.getElementById('stations');
		wrap.innerHTML = '';
		STATIONS.forEach((s) => {
			const b = document.createElement('button');
			b.className = 'station';
			b.dataset.station = s.id;
			const left = document.createElement('span');
			left.textContent = s.name;
			const right = document.createElement('span');
			right.className = 'desc';
			right.textContent = s.desc;
			b.appendChild(left);
			b.appendChild(right);
			b.addEventListener('click', () => {
				tryResume();
				doPlaySynth(s.id);
			});
			wrap.appendChild(b);
		});
	}

	document.getElementById('btn-play').addEventListener('click', () => {
		tryResume();
		doToggle();
	});
	document.getElementById('btn-next').addEventListener('click', () => {
		tryResume();
		doPlaySynth('__next');
	});
	document.getElementById('btn-file').addEventListener('click', () => {
		vscode.postMessage({ type: 'request-file' });
	});
	document.getElementById('btn-loop').addEventListener('click', (e) => {
		loopFile = !loopFile;
		e.currentTarget.classList.toggle('active', loopFile);
		if (fileSource) {
			fileSource.loop = loopFile;
		}
	});
	document.getElementById('btn-stop').addEventListener('click', doStop);
	document.getElementById('btn-rave').addEventListener('click', () => {
		vscode.postMessage({ type: 'toggle-rave' });
	});
	document.getElementById('volume').addEventListener('input', (e) => {
		volume = e.target.value / 100;
		if (master) {
			master.gain.value = volume;
		}
		vscode.postMessage({ type: 'set-volume', volume });
	});

	// ------------------------------------------------------- extension messages

	window.addEventListener('message', (event) => {
		const msg = event.data;
		switch (msg.cmd) {
			case 'transport':
				tryResume();
				if (msg.action === 'play-synth') {
					doPlaySynth(msg.station);
				} else if (msg.action === 'play-file') {
					if (ctx && ctx.state === 'suspended') {
						pendingAction = () => playFile(msg.fileUri, msg.fileName);
					} else {
						playFile(msg.fileUri, msg.fileName);
					}
				} else if (msg.action === 'pause') {
					doPause();
				} else if (msg.action === 'resume') {
					doResume();
				} else if (msg.action === 'toggle') {
					doToggle();
				} else if (msg.action === 'stop') {
					doStop();
				}
				break;
			case 'set-station': {
				const i = STATIONS.findIndex((s) => s.id === msg.station);
				if (i >= 0) {
					stationIndex = i;
				}
				renderStations();
				break;
			}
			case 'set-volume':
				volume = msg.volume;
				document.getElementById('volume').value = Math.round(volume * 100);
				if (master) {
					master.gain.value = volume;
				}
				break;
			case 'rave-mode':
				document.getElementById('btn-rave').classList.toggle('active', msg.enabled);
				break;
		}
	});

	renderStations();
	reportTrack();
	vscode.postMessage({ type: 'ready' });
})();
