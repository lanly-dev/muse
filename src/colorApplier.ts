import * as vscode from 'vscode';
import {
	AudioFeatures,
	chromaToHue,
	clamp01,
	featuresToColors,
	lerpAngle,
} from './colors';

/**
 * Applies melody-driven colors to the workbench and restores the user's
 * own colors when playback stops.
 *
 * - Smooths hue (circular), energy and brightness so colors glide instead of jump.
 * - Throttles settings writes and skips imperceptible changes.
 * - Snapshots workbench.colorCustomizations on first apply; restores on stop.
 */
export class ColorApplier {
	private timer: NodeJS.Timeout | undefined;
	private lastWrite = 0;
	private lastHue: number | undefined;
	private lastSat = 0;
	private lastLight = 0;
	private snapshot: Record<string, string> | undefined;
	private snapshotTaken = false;
	private pending: AudioFeatures | undefined;
	private active = false;

	get isActive(): boolean {
		return this.active;
	}

	/** Begin accepting features. Call once when playback starts. */
	start(): void {
		this.active = true;
	}

	/** Feed fresh audio features from the webview (~10-15 fps is plenty). */
	push(features: AudioFeatures): void {
		if (!this.active) {
			return;
		}
		this.pending = features;
		if (!this.timer) {
			this.timer = setInterval(() => void this.tick(), 120);
		}
	}

	private async tick(): Promise<void> {
		const features = this.pending;
		this.pending = undefined;
		if (!features || !this.active) {
			return;
		}
		const cfg = vscode.workspace.getConfiguration('muse');
		if (!cfg.get<boolean>('reactiveColors', true)) {
			return;
		}
		const intensity = clamp01(cfg.get<number>('intensity', 0.7));
		const intervalMs = Math.max(120, cfg.get<number>('updateIntervalMs', 300));
		const now = Date.now();
		if (now - this.lastWrite < intervalMs) {
			// Hold this frame for the next tick; keep smoothing state fresh.
			this.pending = features;
			return;
		}

		// Smooth: fast attack on energy, slow release; hue glides circularly.
		const hue = chromaToHue(features.chroma);
		this.lastHue =
			this.lastHue === undefined ? hue : lerpAngle(this.lastHue, hue, 0.35);
		const e = clamp01(features.energy);
		this.lastSat += (e - this.lastSat) * (e > this.lastSat ? 0.5 : 0.12);
		const b = clamp01(features.brightness);
		this.lastLight += (b - this.lastLight) * 0.25;

		const smoothed: AudioFeatures = {
			chroma: hueToChromaHint(this.lastHue),
			energy: this.lastSat,
			brightness: this.lastLight,
		};
		const { background, foreground } = featuresToColors(smoothed, intensity);

		const targets = cfg.get<string[]>('colorTargets', [
			'statusBar',
			'titleBar',
			'activityBar',
		]);
		const customizations = this.readCustomizations();
		let changed = false;
		for (const target of targets) {
			const bgKey = `${target}.background`;
			const fgKey = `${target}.foreground`;
			if (customizations[bgKey] !== background) {
				customizations[bgKey] = background;
				changed = true;
			}
			if (customizations[fgKey] !== foreground) {
				customizations[fgKey] = foreground;
				changed = true;
			}
		}
		if (!changed) {
			return;
		}
		if (!this.snapshotTaken) {
			this.snapshot = this.readCustomizations();
			this.snapshotTaken = true;
		}
		this.lastWrite = now;
		try {
			await vscode.workspace
				.getConfiguration('workbench')
				.update(
					'colorCustomizations',
					customizations,
					vscode.ConfigurationTarget.Global
				);
		} catch (err) {
			console.error('[muse] failed to apply colors', err);
		}
	}

	private readCustomizations(): Record<string, string> {
		const raw = vscode.workspace
			.getConfiguration('workbench')
			.get<Record<string, string>>('colorCustomizations');
		return { ...(raw ?? {}) };
	}

	/** Stop applying colors and restore the user's own colorCustomizations. */
	async stop(): Promise<void> {
		this.active = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.pending = undefined;
		this.lastHue = undefined;
		this.lastSat = 0;
		this.lastLight = 0;
		if (this.snapshotTaken) {
			const snapshot = this.snapshot ?? {};
			this.snapshot = undefined;
			this.snapshotTaken = false;
			try {
				await vscode.workspace
					.getConfiguration('workbench')
					.update(
						'colorCustomizations',
						snapshot,
						vscode.ConfigurationTarget.Global
					);
			} catch (err) {
				console.error('[muse] failed to restore colors', err);
			}
		}
	}
}

/**
 * Rebuild a chroma vector concentrated on the given hue so the shared
 * featuresToColors mapping can consume a smoothed hue. Splits weight between
 * the two nearest pitch classes for continuity.
 */
function hueToChromaHint(hue: number): number[] {
	const chroma = new Array<number>(12).fill(0);
	const pos = (((hue % 360) + 360) % 360) / 30; // 0..12 in semitone space
	const lo = Math.floor(pos) % 12;
	const hi = (lo + 1) % 12;
	const frac = pos - Math.floor(pos);
	chroma[lo] = 1 - frac;
	chroma[hi] = frac;
	return chroma;
}
