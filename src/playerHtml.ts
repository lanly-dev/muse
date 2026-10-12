import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/** Webview options shared by the player view: scripts + local audio/file roots. */
export function playerWebviewOptions(
	context: vscode.ExtensionContext
): vscode.WebviewOptions {
	return {
		enableScripts: true,
		localResourceRoots: [
			vscode.Uri.joinPath(context.extensionUri, 'media'),
			vscode.Uri.joinPath(context.globalStorageUri, 'muse', 'audio'),
		],
	};
}

/**
 * Build the player HTML: player.html with player.css / player.js inlined
 * behind a single CSP nonce. Works for both WebviewPanel and WebviewView.
 */
export function buildPlayerHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri
): string {
	const nonce = nonce16();
	const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
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

function nonce16(): string {
	const chars =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 16; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}
