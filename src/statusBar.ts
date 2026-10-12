import * as vscode from 'vscode';
import { TrackInfo } from './playerController';

/**
 * Status-bar track indicator. Click opens the player.
 * Update is cheap: text is only rewritten when it actually changes,
 * since 'features' messages arrive ~11x/sec.
 */
export class MuseStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private lastText = '';

	constructor() {
		this.item = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100
		);
		this.item.command = 'muse.openPlayer';
		this.update(undefined, false);
	}

	update(track: TrackInfo | undefined, playing: boolean): void {
		const text = track ? `$(note) ${track.title}` : '$(note) Muse';
		const tooltip = track
			? `${track.title} — ${track.subtitle}\n${
					playing ? 'Playing' : 'Paused'
				} — click to open Muse player`
			: 'Muse — music that colors your editor\nClick to open player';
		if (text !== this.lastText) {
			this.item.text = text;
			this.lastText = text;
		}
		this.item.tooltip = tooltip;
		this.item.show();
	}

	dispose(): void {
		this.item.dispose();
	}
}
