import * as vscode from 'vscode';
import {
	AudioFeatures,
	chromaToHue,
	clamp01,
	featuresToColors,
	lerpAngle,
} from './colors';

/** globalState key holding the saved pre-play color profile. */
const PROFILE_KEY = 'muse.colorProfile';

/**
 * Applies melody-driven colors to the workbench and restores the user's
 * own colors when playback stops.
 *
 * - Colors are written to the **workspace** configuration scope only;
 *   the user's global preferences are never touched.
 * - The pre-play workspace colors are saved as a "profile" (in memory
 *   and persisted to globalState), so restore works even if the window
 *   closes mid-play — a leftover profile is restored on next activation.
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
	/** The workspace-scope colorCustomizations from before we touched them. */
	private snapshot: Record<string, string> | undefined;
	private snapshotTaken = false;
	private pending: AudioFeatures | undefined;
	private active = false;
	private warnedNoWorkspace = false;

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
		const saved = this.context.globalState.get<Record<string, string> | null>(
			PROFILE_KEY
		);
		if (!saved) {
			return;
		}
		// Clear first so a failed restore doesn't retry forever.
		await this.context.globalState.update(PROFILE_KEY, null);
		if (!this.hasWorkspace()) {
			return;
		}
		try {
			await vscode.workspace
				.getConfiguration('workbench')
				.update(
					'colorCustomizations',
					saved,
					vscode.ConfigurationTarget.Workspace
				);
		} catch (err) {
			console.error('[muse] failed to restore leftover color profile', err);
		}
	}

	private hasWorkspace(): boolean {
		return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
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
		if (!this.hasWorkspace()) {
			if (!this.warnedNoWorkspace) {
				this.warnedNoWorkspace = true;
				void vscode.window.showWarningMessage(
					'Muse: open a workspace folder for the melody-reactive colors — Muse never touches your user settings.'
				);
			}
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
		const customizations = this.readWorkspaceCustomizations();
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
			this.takeSnapshot();
		}
		this.lastWrite = now;
		try {
			await vscode.workspace
				.getConfiguration('workbench')
				.update(
					'colorCustomizations',
					customizations,
					vscode.ConfigurationTarget.Workspace
				);
		} catch (err) {
			console.error('[muse] failed to apply colors', err);
		}
	}

	/** The workspace-scope colorCustomizations, without touching other scopes. */
	private readWorkspaceCustomizations(): Record<string, string> {
		const inspected = vscode.workspace
			.getConfiguration('workbench')
			.inspect<Record<string, string>>('colorCustomizations');
		return { ...(inspected?.workspaceValue ?? {}) };
	}

	/**
	 * Save the user's pre-play workspace colors as the restore profile,
	 * in memory and persisted so a mid-play shutdown can still restore.
	 */
	private takeSnapshot(): void {
		const inspected = vscode.workspace
			.getConfiguration('workbench')
			.inspect<Record<string, string>>('colorCustomizations');
		this.snapshot = inspected?.workspaceValue
			? { ...inspected.workspaceValue }
			: undefined;
		this.snapshotTaken = true;
		void this.context.globalState.update(PROFILE_KEY, this.snapshot ?? null);
	}

	/** Stop applying colors and restore the saved profile to the workspace scope. */
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
			// undefined snapshot removes our workspace-level keys entirely.
			const snapshot = this.snapshot;
			this.snapshot = undefined;
			this.snapshotTaken = false;
			await this.context.globalState.update(PROFILE_KEY, null);
			if (this.hasWorkspace()) {
				try {
					await vscode.workspace
						.getConfiguration('workbench')
						.update(
							'colorCustomizations',
							snapshot,
							vscode.ConfigurationTarget.Workspace
						);
				} catch (err) {
					console.error('[muse] failed to restore colors', err);
				}
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
