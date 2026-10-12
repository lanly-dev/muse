import {
	commands,
	ConfigurationChangeEvent,
	ExtensionContext,
	workspace,
} from 'vscode';

import { ColorApplier } from './colorApplier';
import { PlayerController } from './playerController';
import { MuseStatusBar } from './statusBar';
import { MuseViewProvider } from './playerViewProvider';

let applierRef: ColorApplier | undefined;

export function activate(context: ExtensionContext) {
	const rc = commands.registerCommand;

	const applier = new ColorApplier(context);
	applierRef = applier;
	// Restore a color profile left behind if the last session ended mid-play.
	void applier.restoreLeftoverProfile();
	const statusBar = new MuseStatusBar();
	const player = new PlayerController(context, applier, (track, playing) =>
		statusBar.update(track, playing)
	);

	const d0 = MuseViewProvider.register(context, player);
	const d1 = rc('muse.openPlayer', () => player.reveal());
	const d2 = rc('muse.play', () => {
		player.playSynth();
		applier.start();
	});
	const d3 = rc('muse.togglePlay', () => {
		player.toggle();
		applier.start();
	});
	const d4 = rc('muse.nextStation', () => {
		player.nextStation();
		applier.start();
	});
	const d5 = rc('muse.playAudioFile', () => {
		void player.playAudioFile().then(() => applier.start());
	});
	const d6 = rc('muse.stop', () => {
		void player.stopPlayback();
	});

	// Restore the user's colors when reactive colors are toggled off
	const d7 = workspace.onDidChangeConfiguration(
		(event: ConfigurationChangeEvent) => {
			if (!event.affectsConfiguration('muse.reactiveColors')) {
				return;
			}
			const enabled = workspace
				.getConfiguration('muse')
				.get<boolean>('reactiveColors', true);
			if (enabled) {
				applier.start();
			} else {
				void applier.stop();
			}
		}
	);

	context.subscriptions.push(d0, d1, d2, d3, d4, d5, d6, d7, statusBar);
}

export function deactivate() {
	// Best-effort: restore the user's own colors if VS Code closes mid-play.
	void applierRef?.stop();
	applierRef = undefined;
}
