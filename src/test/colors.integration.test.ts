import * as assert from 'assert';
import * as vscode from 'vscode';
import { ColorApplier } from '../colorApplier';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeContext(): vscode.ExtensionContext {
	const store = new Map<string, unknown>();
	return {
		globalState: {
			get: (key: string, def?: unknown) =>
				store.has(key) ? store.get(key) : def,
			update: async (key: string, value: unknown) => {
				store.set(key, value);
			},
		},
	} as unknown as vscode.ExtensionContext;
}

/** Pure pitch-class features: only `pc` active. */
function features(pc: number, energy: number) {
	return {
		chroma: Array.from({ length: 12 }, (_, i) => (i === pc ? 1 : 0)),
		energy,
		brightness: 0.5,
	};
}

suite('ColorApplier integration (real VS Code)', () => {
	test('applies melody colors at workspace scope and restores on stop', async function () {
		if (!vscode.workspace.workspaceFolders?.length) {
			this.skip(); // needs a folder: colors are workspace-scoped by design
			return;
		}
		const applier = new ColorApplier(fakeContext());

		applier.push(features(0, 0.9)); // strong C, high energy -> red-ish
		await sleep(1500);

		const applied = vscode.workspace
			.getConfiguration('workbench')
			.get<Record<string, string>>('colorCustomizations');
		const bg = applied?.['activityBar.background'];
		assert.ok(
			bg?.startsWith('#'),
			`activityBar.background should be set, got: ${JSON.stringify(applied)}`
		);

		await applier.stop();
		await sleep(400);

		const inspected = vscode.workspace
			.getConfiguration('workbench')
			.inspect<Record<string, string>>('colorCustomizations');
		assert.strictEqual(
			inspected?.workspaceValue,
			undefined,
			'workspace colorCustomizations should be removed after stop'
		);
	}).timeout(30000);
});
