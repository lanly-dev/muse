import * as vscode from 'vscode';
import * as path from 'path';
import { ColorApplier } from './colorApplier';
import { AudioFeatures } from './colors';
import {
	DEFAULT_STATION,
	DEFAULT_VOLUME,
	VOLUME_STATE_KEY,
} from './constants';

export interface TrackInfo {
	title: string;
	subtitle: string;
	kind: 'synth' | 'file';
}

export type WebviewIn =
	| { type: 'ready' }
	| { type: 'features'; features: AudioFeatures; track: TrackInfo; playing: boolean }
	| { type: 'track'; track: TrackInfo | undefined; playing: boolean; ended?: boolean }
	| { type: 'request-file' }
	| { type: 'set-volume'; volume: number }
	| { type: 'toggle-rave' }
	| { type: 'error'; message: string };

export type WebviewOut =
	| { cmd: 'transport'; action: 'play-synth' | 'play-file' | 'pause' | 'resume' | 'toggle' | 'stop'; station?: string; fileUri?: string; fileName?: string }
	| { cmd: 'set-station'; station: string }
	| { cmd: 'set-volume'; volume: number }
	| { cmd: 'rave-mode'; enabled: boolean };

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];

export const PLAYER_VIEW_ID = 'muse.playerView';
export const PLAYER_CONTAINER_ID = 'muse-player';

/**
 * Extension-side player logic, independent of where the webview lives
 * (activity-bar view today). Owns file staging, forwards audio features
 * to the ColorApplier, and reports track state for the status bar.
 *
 * The webview may not be resolved yet when commands run (the view only
 * resolves once visible), so outbound messages queue until attach().
 */
export class PlayerController {
	private sender: ((msg: WebviewOut) => void) | undefined;
	private uriConverter: ((uri: vscode.Uri) => vscode.Uri) | undefined;
	private queue: WebviewOut[] = [];
	private uriWaiters: Array<(c: (uri: vscode.Uri) => vscode.Uri) => void> = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly applier: ColorApplier,
		private readonly onTrackChange: (
			track: TrackInfo | undefined,
			playing: boolean
		) => void
	) {}

	/**
	 * Called by the view provider once the webview exists. sender posts
	 * messages; uriConverter maps file URIs via webview.asWebviewUri.
	 */
	attach(
		sender: (msg: WebviewOut) => void,
		uriConverter: (uri: vscode.Uri) => vscode.Uri
	): void {
		this.sender = sender;
		this.uriConverter = uriConverter;
		for (const msg of this.queue) {
			sender(msg);
		}
		this.queue = [];
		for (const waiter of this.uriWaiters) {
			waiter(uriConverter);
		}
		this.uriWaiters = [];
	}

	/** Called when the webview is disposed; outbound messages queue again. */
	detach(): void {
		this.sender = undefined;
		this.uriConverter = undefined;
	}

	private post(msg: WebviewOut): void {
		if (this.sender) {
			this.sender(msg);
		} else {
			this.queue.push(msg);
		}
	}

	/** Reveal the player in the activity bar. */
	reveal(): void {
		void vscode.commands.executeCommand(`${PLAYER_CONTAINER_ID}.focus`);
	}

	playSynth(station?: string): void {
		this.reveal();
		this.post({ cmd: 'transport', action: 'play-synth', station });
	}

	pause(): void {
		this.post({ cmd: 'transport', action: 'pause' });
	}

	resume(): void {
		this.post({ cmd: 'transport', action: 'resume' });
	}

	toggle(): void {
		this.reveal();
		this.post({ cmd: 'transport', action: 'toggle' });
	}

	nextStation(): void {
		this.reveal();
		this.post({ cmd: 'transport', action: 'play-synth', station: '__next' });
	}

	/** Toggle rave mode and sync the player UI. Returns the new state. */
	toggleRaveMode(): boolean {
		const enabled = this.applier.toggleRaveMode();
		this.post({ cmd: 'rave-mode', enabled });
		return enabled;
	}

	async stopPlayback(): Promise<void> {
		this.post({ cmd: 'transport', action: 'stop' });
		await this.applier.stop();
		this.onTrackChange(undefined, false);
	}

	async playAudioFile(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: 'Play in Muse',
			filters: { Audio: AUDIO_EXTENSIONS },
		});
		if (!picked || picked.length === 0) {
			return;
		}
		const staged = await this.stageAudioFile(picked[0]);
		const fileName = path.basename(picked[0].fsPath);
		this.reveal();
		try {
			const webviewUri = await this.toWebviewUri(staged);
			this.post({
				cmd: 'transport',
				action: 'play-file',
				fileUri: webviewUri.toString(),
				fileName,
			});
		} catch {
			void vscode.window.showWarningMessage(
				'Muse: player view did not open in time.'
			);
		}
	}

	/** Map a file URI through webview.asWebviewUri, waiting for the view if needed. */
	private toWebviewUri(uri: vscode.Uri): Promise<vscode.Uri> {
		if (this.uriConverter) {
			return Promise.resolve(this.uriConverter(uri));
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error('player view did not open')),
				10000
			);
			this.uriWaiters.push((converter) => {
				clearTimeout(timer);
				resolve(converter(uri));
			});
		});
	}

	/** Copy a user-picked audio file into global storage so the webview can load it. */
	private async stageAudioFile(source: vscode.Uri): Promise<vscode.Uri> {
		const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'muse', 'audio');
		await vscode.workspace.fs.createDirectory(dir);
		const dest = vscode.Uri.joinPath(dir, path.basename(source.fsPath));
		await vscode.workspace.fs.copy(source, dest, { overwrite: true });
		return dest;
	}

	handleMessage(msg: WebviewIn): void {
		switch (msg.type) {
			case 'ready': {
				this.post({ cmd: 'set-station', station: DEFAULT_STATION });
				this.post({
					cmd: 'set-volume',
					volume: this.context.globalState.get<number>(
						VOLUME_STATE_KEY,
						DEFAULT_VOLUME
					),
				});
				this.post({ cmd: 'rave-mode', enabled: this.applier.isRaveMode });
				break;
			}
			case 'features':
				this.applier.push(msg.features);
				this.onTrackChange(msg.track, msg.playing);
				break;
			case 'track':
				this.onTrackChange(msg.track, msg.playing);
				if (msg.ended || (!msg.playing && !msg.track)) {
					// Stopped from the player UI, or natural end of a file:
					// restore the user's colors like the Stop command does.
					// (Pause keeps the track, so it never hits this branch.)
					void this.applier.stop();
				}
				break;
			case 'request-file':
				void this.playAudioFile().then(() => this.applier.start());
				break;
			case 'set-volume':
				// Persisted silently; no user-facing setting for this.
				void this.context.globalState.update(VOLUME_STATE_KEY, msg.volume);
				break;
			case 'toggle-rave':
				this.toggleRaveMode();
				break;
			case 'error':
				void vscode.window.showWarningMessage(`Muse: ${msg.message}`);
				break;
		}
	}
}
