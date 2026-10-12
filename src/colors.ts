/**
 * Pure melody -> color mapping for Muse.
 *
 * The webview analyzes audio into per-frame features (a 12-bin chroma vector,
 * overall energy, spectral brightness). This module turns those features into
 * UI colors with no dependency on the vscode API, so it can be unit tested.
 *
 * Mapping:
 *   dominant pitch class -> hue        (C = red, chromatic walk around the wheel)
 *   energy              -> saturation  (louder/denser = more vivid)
 *   brightness          -> lightness   (brighter timbre = lighter UI)
 */

export interface AudioFeatures {
	/** 12 pitch-class energies, index 0 = C. Values >= 0. */
	chroma: number[];
	/** 0..1 overall loudness / rhythmic density. */
	energy: number;
	/** 0..1 spectral centroid; higher = brighter timbre. */
	brightness: number;
}

export interface Hsl {
	h: number; // 0..360
	s: number; // 0..1
	l: number; // 0..1
}

export function clamp01(v: number): number {
	return Math.min(1, Math.max(0, v));
}

/**
 * Circular weighted mean of the chroma vector, in degrees.
 * Pitch class 0 (C) maps to 0 degrees (red), each semitone +30 degrees.
 * Returns 0 when the vector is silent.
 */
export function chromaToHue(chroma: number[]): number {
	let x = 0;
	let y = 0;
	let total = 0;
	for (let pc = 0; pc < 12; pc++) {
		const w = Math.max(0, chroma[pc] ?? 0);
		if (w <= 0) {
			continue;
		}
		const angle = (pc / 12) * Math.PI * 2;
		x += w * Math.cos(angle);
		y += w * Math.sin(angle);
		total += w;
	}
	if (total <= 0) {
		return 0;
	}
	const deg = (Math.atan2(y, x) * 180) / Math.PI;
	return (deg + 360) % 360;
}

/** Shortest-path interpolation between two angles in degrees. */
export function lerpAngle(a: number, b: number, t: number): number {
	let d = (b - a) % 360;
	if (d > 180) {
		d -= 360;
	}
	if (d < -180) {
		d += 360;
	}
	return (a + d * t + 360) % 360;
}

/**
 * Map audio features to an HSL color.
 * intensity (0..1) scales how far saturation/lightness swing from neutral.
 */
export function featuresToHsl(f: AudioFeatures, intensity: number): Hsl {
	const k = clamp01(intensity);
	const hue = chromaToHue(f.chroma);
	const energy = clamp01(f.energy);
	const brightness = clamp01(f.brightness);
	// Neutral gray-blue at rest, vivid at full energy.
	const s = 0.25 + 0.55 * energy * k + 0.1 * k;
	const l = 0.3 + 0.22 * brightness * k + 0.06 * energy * k;
	return { h: hue, s: clamp01(s), l: clamp01(l) };
}

/** Foreground color (white or near-black) that stays readable on the given lightness. */
export function foregroundForLightness(l: number): string {
	return l < 0.55 ? '#ffffff' : '#1a1a1a';
}

export function hslToHex(h: number, s: number, l: number): string {
	h = ((h % 360) + 360) % 360;
	s = clamp01(s);
	l = clamp01(l);
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = h / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r = 0;
	let g = 0;
	let b = 0;
	if (hp < 1) {
		r = c;
		g = x;
	} else if (hp < 2) {
		r = x;
		g = c;
	} else if (hp < 3) {
		g = c;
		b = x;
	} else if (hp < 4) {
		g = x;
		b = c;
	} else if (hp < 5) {
		r = x;
		b = c;
	} else {
		r = c;
		b = x;
	}
	const m = l - c / 2;
	const to255 = (v: number) => Math.round((v + m) * 255);
	const hex = (v: number) => to255(v).toString(16).padStart(2, '0');
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Full feature -> {background, foreground} pair for a UI surface. */
export function featuresToColors(
	f: AudioFeatures,
	intensity: number
): { background: string; foreground: string } {
	const hsl = featuresToHsl(f, intensity);
	const background = hslToHex(hsl.h, hsl.s, hsl.l);
	return { background, foreground: foregroundForLightness(hsl.l) };
}
