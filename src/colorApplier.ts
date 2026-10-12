import * as vscode from 'vscode';
import {
	AudioFeatures,
	chromaToHue,
	clamp01,
	featuresToColors,
	lerpAngle,
} from './colors';
import {
	COLOR_TARGETS,
	DEFAULT_INTENSITY,
	UPDATE_INTERVAL_MS,
} from './constants';

/** globalState key holding the saved pre-play color profile. */
const PROFILE_KEY = 'muse.colorProfile';

/**
 * Persisted pre-play profile. The v1 wrapper distinguishes "the user had
 * no prior global value" (previous: null) from "no profile saved".
 */
interface ColorProfile {
	v: 1;
	/** The user's exact global colorCustomizations before Muse touched them. */
	previous: Record<string, string> | null;
}

/**
 * Applies melody-driven colors to the workbench and restores the user's
 * own colors when playback stops.
 *
 * - Colors are written to the **global** configuration scope, so they work
 *   with or without a workspace folder open.
 * - Before the first write, the user's global colorCustomizations are
 *   saved as a "profile" (in memory and persisted to globalState). Stop
 *   removes every key Muse managed and puts the user's own values back,
 *   so user preferences are never lost — a leftover profile is restored
 *   on next activation.
 * - Smoothing: hue glides circularly, energy has fast attack / slow
 *   release, so colors flow instead of jumping.
 * - Settings writes are throttled and imperceptible changes are skipped.
 */
export class ColorApplier {
	private timer: NodeJS.Timeout | undefined;
	private lastWrite = 0;
	private lastHue: number | undefined;
	private lastSat = 0;
	private lastLight = 0;
	/** The global-scope colorCustomizations from before we touched them. */
	private snapshot: Record<string, string> | undefined;
	private snapshotTaken = false;
	private pending: AudioFeatures | undefined;
	private active = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	get isActive(): boolean {
		return this.active;
	}

	/** Begin accepting features. Call once when playback starts. */
	start(): void {
		this.active = true;
	}

	/**
	 * Feed fresh audio features from the webview (~10-15 fps is plenty).
	 * Auto-starts the applier: features only flow while music is playing,
	 * no matter whether playback began from a command or the player UI.
	 */
	push(features: AudioFeatures): void {
		if (!this.active) {
			this.start();
		}
		this.pending = features;
		if (!this.timer) {
			this.timer = setInterval(() => void this.tick(), 120);
		}
	}

	/**
	 * Restore a color profile left behind by a previous session that
	 * ended (or crashed) mid-play. Safe to call on every activation.
	 */
	async restoreLeftoverProfile(): Promise<void> {
		const raw = this.context.globalState.get<unknown>(PROFILE_KEY);
		if (!raw || typeof raw !== 'object' || (raw as ColorProfile).v !== 1) {
			// Nothing saved, or a stale pre-v1 profile — don't let it linger.
			if (raw) {
				void this.context.globalState.update(PROFILE_KEY, undefined);
			}
			return;
		}
		// Clear first so a failed restore doesn't retry forever.
		await this.context.globalState.update(PROFILE_KEY, undefined);
		await restoreGlobalColors((raw as ColorProfile).previous);
	}

	private async tick(): Promise<void> {
		const features = this.pending;
		this.pending = undefined;
		if (!features || !this.active) {
			return;
		}
		const reactive = vscode.workspace
			.getConfiguration('muse')
			.get<boolean>('reactiveColors', true);
		if (!reactive) {
			return;
		}
		const intensity = clamp01(DEFAULT_INTENSITY);
		const intervalMs = Math.max(120, UPDATE_INTERVAL_MS);
		const now = Date.now();
		if (now - this.lastWrite < intervalMs) {
			// Hold this frame for the next tick; keep smoothing state fresh.
			this.pending = features;
			return;
		}

		// Smooth: fast attack on energy, quick release; hue tracks briskly.
		const hue = chromaToHue(features.chroma);
		this.lastHue =
			this.lastHue === undefined ? hue : lerpAngle(this.lastHue, hue, 0.55);
		const e = clamp01(features.energy);
		this.lastSat += (e - this.lastSat) * (e > this.lastSat ? 0.6 : 0.25);
		const b = clamp01(features.brightness);
		this.lastLight += (b - this.lastLight) * 0.35;

		const smoothed: AudioFeatures = {
			chroma: hueToChromaHint(this.lastHue),
			energy: this.lastSat,
			brightness: this.lastLight,
		};
		const { background, foreground } = featuresToColors(smoothed, intensity);

		const customizations = readGlobalCustomizations();
		let changed = false;
		const set = (key: string, value: string): void => {
			if (customizations[key] !== value) {
				customizations[key] = value;
				changed = true;
			}
		};
		for (const target of COLOR_TARGETS) {
			if (target === 'titleBar') {
				set('titleBar.activeBackground', background);
				set('titleBar.activeForeground', foreground);
				set('titleBar.inactiveBackground', background);
				set('titleBar.inactiveForeground', foreground);
			} else {
				set(`${target}.background`, background);
				set(`${target}.foreground`, foreground);
			}
		}
		if (!changed) {
			return;
		}
		if (!this.snapshotTaken) {
			this.takeSnapshot();
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

	/**
	 * Save the user's pre-play global colors as the restore profile,
	 * in memory and persisted so a mid-play shutdown can still restore.
	 */
	private takeSnapshot(): void {
		const inspected = vscode.workspace
			.getConfiguration('workbench')
			.inspect<Record<string, string>>('colorCustomizations');
		this.snapshot = inspected?.globalValue
			? { ...inspected.globalValue }
			: undefined;
		this.snapshotTaken = true;
		const profile: ColorProfile = { v: 1, previous: this.snapshot ?? null };
		void this.context.globalState.update(PROFILE_KEY, profile);
	}

	/** Stop applying colors and restore the user's own global colors. */
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
			const snapshot = this.snapshot;
			this.snapshot = undefined;
			this.snapshotTaken = false;
			void this.context.globalState.update(PROFILE_KEY, undefined);
			await restoreGlobalColors(snapshot);
		}
	}
}

/** Every workbench.colorCustomizations key Muse manages. */
export function museManagedKeys(): string[] {
	const keys: string[] = [];
	for (const target of COLOR_TARGETS) {
		if (target === 'titleBar') {
			keys.push(
				'titleBar.activeBackground',
				'titleBar.activeForeground',
				'titleBar.inactiveBackground',
				'titleBar.inactiveForeground'
			);
		} else {
			keys.push(`${target}.background`, `${target}.foreground`);
		}
	}
	return keys;
}

/** The global-scope colorCustomizations, without touching other scopes. */
function readGlobalCustomizations(): Record<string, string> {
	const inspected = vscode.workspace
		.getConfiguration('workbench')
		.inspect<Record<string, string>>('colorCustomizations');
	return { ...(inspected?.globalValue ?? {}) };
}

/**
 * Remove every key Muse manages from the global colorCustomizations,
 * then put back exactly what the user had before (`previous`).
 */
async function restoreGlobalColors(
	previous: Record<string, string> | null | undefined
): Promise<void> {
	const managed = new Set(museManagedKeys());
	const restored: Record<string, string> = {};
	for (const [key, value] of Object.entries(readGlobalCustomizations())) {
		if (!managed.has(key)) {
			restored[key] = value;
		}
	}
	if (previous) {
		Object.assign(restored, previous);
	}
	try {
		await vscode.workspace
			.getConfiguration('workbench')
			.update(
				'colorCustomizations',
				Object.keys(restored).length > 0 ? restored : undefined,
				vscode.ConfigurationTarget.Global
			);
	} catch (err) {
		console.error('[muse] failed to restore colors', err);
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
