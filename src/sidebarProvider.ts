import * as vscode from 'vscode';
import { getWebviewHtml, WebviewMessageHandler, sendCommandsToWebview, sendActiveTerminals, sendUploadProgress, sendUploadStaleness } from './webviewBase';
import { TerminalManager } from './terminalManager';
import { uploadProgressBus, uploadStalenessBus } from './extension';

export class CommandsSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'commandsExtension.sidebarView';

	private _view?: vscode.WebviewView;
	private _handler?: WebviewMessageHandler;

	constructor(private readonly _extensionUri: vscode.Uri, private readonly _context: vscode.ExtensionContext) {}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
		};

		webviewView.webview.html = getWebviewHtml(webviewView.webview, this._extensionUri);

		const postMessage = (msg: unknown) => this._view?.webview.postMessage(msg);
		this._handler = new WebviewMessageHandler(this._context, postMessage, () => this._sendCommands());

		webviewView.webview.onDidReceiveMessage((message) => {
			this._handler?.handleMessage(message);
		});

		TerminalManager.getInstance().onDidChange(() => {
			if (this._view) {
				sendActiveTerminals((msg) => this._view!.webview.postMessage(msg));
			}
		});

		const progressSub = uploadProgressBus.subscribe((p) => {
			if (this._view) {
				sendUploadProgress((msg) => this._view!.webview.postMessage(msg), p);
			}
		});
		const stalenessSub = uploadStalenessBus.subscribe((key, info) => {
			if (this._view) {
				sendUploadStaleness((msg) => this._view!.webview.postMessage(msg), key, info);
			}
		});
		webviewView.onDidDispose(() => { progressSub.dispose(); stalenessSub.dispose(); });
	}

	public async refresh(): Promise<void> {
		if (this._view && this._handler) {
			await this._sendCommands();
		}
	}

	private async _sendCommands(): Promise<void> {
		if (!this._view || !this._handler) return;
		await sendCommandsToWebview(
			(msg) => this._view!.webview.postMessage(msg),
			this._handler
		);
	}
}
