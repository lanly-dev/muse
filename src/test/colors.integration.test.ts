import * as assert from 'assert';
import * as vscode from 'vscode';
import { ColorApplier, museManagedKeys } from '../colorApplier';

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

/**
 * Global settings writes can take a while to become visible in a headless
 * sandbox, so poll instead of sleeping a fixed amount.
 */
async function waitFor(
	cond: () => boolean,
	timeoutMs: number,
	label: string
): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (cond()) {
			return;
		}
		if (Date.now() - start > timeoutMs) {
			assert.ok(false, `timed out waiting for: ${label}`);
		}
		await sleep(250);
	}
}

function readGlobal(): Record<string, string> | undefined {
	return vscode.workspace
		.getConfiguration('workbench')
		.inspect<Record<string, string>>('colorCustomizations')?.globalValue;
}

suite('ColorApplier integration (real VS Code)', () => {
	test('applies melody colors at global scope and restores on stop', async () => {
		// No workspace folder needed: colors are written at the global scope.
		const applier = new ColorApplier(fakeContext());
		const managed = museManagedKeys();

		const before = readGlobal();

		// G, mid energy — a different color than any leftover from prior runs,
		// so the "changed" check below proves a real write happened.
		applier.push(features(7, 0.4));

		await waitFor(() => {
			const applied = readGlobal();
			return (
				!!applied && managed.every((k) => applied[k]?.startsWith('#'))
			);
		}, 25000, 'all managed color keys to be applied at global scope');

		const applied = readGlobal();
		assert.ok(
			managed.some((k) => applied?.[k] !== before?.[k]),
			'at least one managed key should have changed'
		);

		await applier.stop();

		await waitFor(() => {
			const restored = readGlobal();
			try {
				assert.deepStrictEqual(restored, before);
				return true;
			} catch {
				return false;
			}
		}, 25000, 'global colorCustomizations to be exactly restored');

		const restored = readGlobal();
		assert.deepStrictEqual(
			restored,
			before,
			'global colorCustomizations should be exactly restored after stop'
		);
	}).timeout(70000);
});
