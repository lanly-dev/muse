import * as vscode from 'vscode';
import { ColorApplier } from './colorApplier';
import { PlayerController } from './playerController';
import { MuseViewProvider } from './playerViewProvider';

let applierRef: ColorApplier | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const applier = new ColorApplier();
	applierRef = applier;

	const statusBar = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	statusBar.command = 'muse.openPlayer';
	context.subscriptions.push(statusBar);

	let lastStatusText = '';
	const player = new PlayerController(context, applier, (track, playing) => {
		const text = track ? `$(note) ${track.title}` : '$(note) Muse';
		const tooltip = track
			? `${track.title} — ${track.subtitle}\n${
					playing ? 'Playing' : 'Paused'
				} — click to open Muse player`
			: 'Muse — music that colors your editor\nClick to open player';
		// 'features' messages arrive ~11x/sec; don't churn the status bar.
		if (text !== lastStatusText) {
			statusBar.text = text;
			lastStatusText = text;
		}
		statusBar.tooltip = tooltip;
		statusBar.show();
	});
	statusBar.text = '$(note) Muse';
	statusBar.tooltip = 'Muse — music that colors your editor\nClick to open player';
	statusBar.show();

	MuseViewProvider.register(context, player);

	context.subscriptions.push(
		vscode.commands.registerCommand('muse.openPlayer', () => {
			player.reveal();
		}),
		vscode.commands.registerCommand('muse.play', () => {
			player.playSynth();
			applier.start();
		}),
		vscode.commands.registerCommand('muse.togglePlay', () => {
			player.toggle();
			applier.start();
		}),
		vscode.commands.registerCommand('muse.nextStation', () => {
			player.nextStation();
			applier.start();
		}),
		vscode.commands.registerCommand('muse.playAudioFile', () => {
			void player.playAudioFile().then(() => applier.start());
		}),
		vscode.commands.registerCommand('muse.stop', () => {
			void player.stopPlayback();
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('muse.reactiveColors')) {
				const enabled = vscode.workspace
					.getConfiguration('muse')
					.get<boolean>('reactiveColors', true);
				if (!enabled) {
					void applier.stop();
				} else {
					applier.start();
				}
			}
		})
	);
}

export function deactivate(): void {
	// Best-effort: restore the user's own colors if VS Code closes mid-play.
	void applierRef?.stop();
	applierRef = undefined;
}
