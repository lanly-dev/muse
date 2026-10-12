import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ColorApplier } from './colorApplier';
import { AudioFeatures } from './colors';

export interface TrackInfo {
	title: string;
	subtitle: string;
	kind: 'synth' | 'file';
}

type WebviewIn =
	| { type: 'ready' }
	| { type: 'features'; features: AudioFeatures; track: TrackInfo; playing: boolean }
	| { type: 'track'; track: TrackInfo | undefined; playing: boolean; ended?: boolean }
	| { type: 'request-file' }
	| { type: 'set-volume'; volume: number }
	| { type: 'error'; message: string };

type WebviewOut =
	| { cmd: 'transport'; action: 'play-synth' | 'play-file' | 'pause' | 'resume' | 'toggle' | 'stop'; station?: string; fileUri?: string; fileName?: string }
	| { cmd: 'set-station'; station: string }
	| { cmd: 'set-volume'; volume: number };

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];

/**
 * Owns the Muse player WebviewPanel: HTML shell, message protocol, local
 * audio file staging, and forwarding audio features to the ColorApplier.
 */
export class PlayerPanel {
	private panel: vscode.WebviewPanel | undefined;
	private currentTrack: TrackInfo | undefined;
	private playing = false;
	private onTrackChange: (track: TrackInfo | undefined, playing: boolean) => void;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly applier: ColorApplier,
		onTrackChange: (track: TrackInfo | undefined, playing: boolean) => void
	) {
		this.onTrackChange = onTrackChange;
	}

	reveal(): void {
		this.ensurePanel().reveal(vscode.ViewColumn.Beside);
	}

	get visible(): boolean {
		return this.panel?.visible ?? false;
	}

	playSynth(station?: string): void {
		const p = this.ensurePanel();
		p.reveal(vscode.ViewColumn.Beside);
		void p.webview.postMessage({
			cmd: 'transport',
			action: 'play-synth',
			station,
		} satisfies WebviewOut);
	}

	pause(): void {
		void this.panel?.webview.postMessage({
			cmd: 'transport',
			action: 'pause',
		} satisfies WebviewOut);
	}

	resume(): void {
		void this.panel?.webview.postMessage({
			cmd: 'transport',
			action: 'resume',
		} satisfies WebviewOut);
	}

	toggle(): void {
		const p = this.ensurePanel();
		p.reveal(vscode.ViewColumn.Beside);
		void p.webview.postMessage({
			cmd: 'transport',
			action: 'toggle',
		} satisfies WebviewOut);
	}

	nextStation(): void {
		void this.panel?.webview.postMessage({
			cmd: 'transport',
			action: 'play-synth',
			station: '__next',
		} satisfies WebviewOut);
	}

	async stopPlayback(): Promise<void> {
		void this.panel?.webview.postMessage({
			cmd: 'transport',
			action: 'stop',
		} satisfies WebviewOut);
		await this.applier.stop();
		this.setTrack(undefined, false);
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
		const uri = await this.stageAudioFile(picked[0]);
		const fileName = path.basename(picked[0].fsPath);
		const p = this.ensurePanel();
		p.reveal(vscode.ViewColumn.Beside);
		void p.webview.postMessage({
			cmd: 'transport',
			action: 'play-file',
			fileUri: p.webview.asWebviewUri(uri).toString(),
			fileName,
		} satisfies WebviewOut);
	}

	/** Copy a user-picked audio file into global storage so the webview can load it. */
	private async stageAudioFile(source: vscode.Uri): Promise<vscode.Uri> {
		const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'muse', 'audio');
		await vscode.workspace.fs.createDirectory(dir);
		const dest = vscode.Uri.joinPath(dir, path.basename(source.fsPath));
		await vscode.workspace.fs.copy(source, dest, { overwrite: true });
		return dest;
	}

	private setTrack(track: TrackInfo | undefined, playing: boolean): void {
		this.currentTrack = track;
		this.playing = playing;
		this.onTrackChange(track, playing);
	}

	get statusText(): string {
		if (this.playing && this.currentTrack) {
			return `$(note) ${this.currentTrack.title}`;
		}
		return '$(note) Muse';
	}

	private ensurePanel(): vscode.WebviewPanel {
		if (this.panel) {
			return this.panel;
		}
		const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		const audioDir = vscode.Uri.joinPath(
			this.context.globalStorageUri,
			'muse',
			'audio'
		);
		const panel = vscode.window.createWebviewPanel(
			'muse.player',
			'Muse Player',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [mediaRoot, audioDir],
			}
		);
		panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icon.svg');
		panel.webview.html = this.buildHtml(panel.webview, mediaRoot);
		panel.webview.onDidReceiveMessage((msg: WebviewIn) =>
			this.handleMessage(msg)
		);
		panel.onDidDispose(() => {
			this.panel = undefined;
			void this.applier.stop();
			this.setTrack(undefined, false);
		});
		this.panel = panel;
		return panel;
	}

	private handleMessage(msg: WebviewIn): void {
		switch (msg.type) {
			case 'ready': {
				const cfg = vscode.workspace.getConfiguration('muse');
				const station = cfg.get<string>('defaultStation', 'neon-rain');
				void this.panel?.webview.postMessage({
					cmd: 'set-station',
					station,
				} satisfies WebviewOut);
				void this.panel?.webview.postMessage({
					cmd: 'set-volume',
					volume: cfg.get<number>('volume', 0.8),
				} satisfies WebviewOut);
				break;
			}
			case 'features':
				this.applier.push(msg.features);
				this.setTrack(msg.track, msg.playing);
				break;
			case 'track':
				this.setTrack(msg.track, msg.playing);
				if (msg.ended) {
					// Natural end of a file: behave like Stop.
					void this.applier.stop();
				}
				break;
			case 'request-file':
				void this.playAudioFile().then(() => this.applier.start());
				break;
			case 'set-volume':
				void vscode.workspace
					.getConfiguration('muse')
					.update('volume', msg.volume, vscode.ConfigurationTarget.Global);
				break;
			case 'error':
				void vscode.window.showWarningMessage(`Muse: ${msg.message}`);
				break;
		}
	}

	private buildHtml(
		webview: vscode.Webview,
		mediaRoot: vscode.Uri
	): string {
		const nonce = nonce16();
		// player.html references player.css / player.js via placeholders; inline
		// the file contents so a single CSP nonce covers everything.
		const htmlPath = path.join(mediaRoot.fsPath, 'player.html');
		const cssPath = path.join(mediaRoot.fsPath, 'player.css');
		const jsPath = path.join(mediaRoot.fsPath, 'player.js');
		let html = '';
		try {
			html = fs.readFileSync(htmlPath, 'utf8');
			const css = fs.readFileSync(cssPath, 'utf8');
			const js = fs.readFileSync(jsPath, 'utf8');
			html = html
				.replace('<!--MUSE_CSS-->', `<style nonce="${nonce}">${css}</style>`)
				.replace('<!--MUSE_JS-->', `<script nonce="${nonce}">${js}</script>`);
		} catch (err) {
			console.error('[muse] failed to read player assets', err);
			html = `<body><p>Muse player failed to load.</p></body>`;
		}
		const csp = [
			`default-src 'none'`,
			`style-src 'nonce-${nonce}'`,
			`script-src 'nonce-${nonce}'`,
			`connect-src ${webview.cspSource} data: blob:`,
			`media-src ${webview.cspSource} data: blob:`,
			`img-src ${webview.cspSource} data:`,
			`font-src ${webview.cspSource}`,
		].join('; ');
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head>${html}</html>`;
	}
}

function nonce16(): string {
	const chars =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 16; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}
