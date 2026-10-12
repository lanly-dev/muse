import * as vscode from 'vscode';
import { PlayerController, PLAYER_VIEW_ID } from './playerController';
import { buildPlayerHtml, playerWebviewOptions } from './playerHtml';

/**
 * Hosts the Muse player as a webview view inside the activity-bar
 * container. The view resolves lazily (first time it becomes visible);
 * until then the controller queues outbound messages.
 */
export class MuseViewProvider implements vscode.WebviewViewProvider {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly controller: PlayerController
	) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		webviewView.title = 'Muse Player';
		webviewView.webview.options = playerWebviewOptions(this.context);
		webviewView.webview.html = buildPlayerHtml(
			webviewView.webview,
			this.context.extensionUri
		);
		webviewView.webview.onDidReceiveMessage((msg) =>
			this.controller.handleMessage(msg)
		);
		webviewView.onDidDispose(() => this.controller.detach());
		this.controller.attach(
			(msg) => {
				void webviewView.webview.postMessage(msg);
			},
			(uri) => webviewView.webview.asWebviewUri(uri)
		);
	}

	static register(
		context: vscode.ExtensionContext,
		controller: PlayerController
	): vscode.Disposable {
		const provider = new MuseViewProvider(context, controller);
		return vscode.window.registerWebviewViewProvider(
			PLAYER_VIEW_ID,
			provider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		);
	}
}
