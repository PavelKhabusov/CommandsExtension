import * as vscode from 'vscode';
import { getWebviewHtml, WebviewMessageHandler, sendCommandsToWebview, sendActiveTerminals } from './webviewBase';
import { TerminalManager } from './terminalManager';

export class CommandsPanel {
	public static currentPanel: CommandsPanel | undefined;
	private static readonly viewType = 'commandsExtension.panel';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _handler: WebviewMessageHandler;
	private _disposables: vscode.Disposable[] = [];
	private _htmlSet = false;
	private static _context: vscode.ExtensionContext;

	public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext): void {
		CommandsPanel._context = context;
		const column = vscode.ViewColumn.Beside;

		if (CommandsPanel.currentPanel) {
			CommandsPanel.currentPanel._panel.reveal(column);
			CommandsPanel.currentPanel._update();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			CommandsPanel.viewType,
			'Commands',
			column,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
				retainContextWhenHidden: true,
			}
		);

		CommandsPanel.currentPanel = new CommandsPanel(panel, extensionUri, CommandsPanel._context);
	}

	public static refresh(): void {
		if (CommandsPanel.currentPanel) {
			CommandsPanel.currentPanel._update();
		}
	}

	private constructor(panel: vscode.WebviewPanel, private readonly _extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
		this._panel = panel;

		const postMessage = (msg: unknown) => this._panel.webview.postMessage(msg);
		this._handler = new WebviewMessageHandler(context, postMessage, () => this._update());

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.onDidReceiveMessage(
			(message) => this._handler.handleMessage(message),
			null,
			this._disposables
		);

		this._update();

		TerminalManager.getInstance().onDidChange(() => {
			sendActiveTerminals((msg) => this._panel.webview.postMessage(msg));
		});
	}

	public dispose(): void {
		CommandsPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) {
			const d = this._disposables.pop();
			if (d) {
				d.dispose();
			}
		}
	}

	private async _update(): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			this._panel.webview.html = this._getNoWorkspaceHtml();
			return;
		}

		if (!this._htmlSet) {
			this._panel.webview.html = getWebviewHtml(this._panel.webview, this._extensionUri);
			this._htmlSet = true;
		} else {
			await sendCommandsToWebview(
				(msg) => this._panel.webview.postMessage(msg),
				this._handler
			);
		}
	}

	private _getNoWorkspaceHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Commands</title>
</head>
<body>
	<p>No workspace folder is open. Please open a folder to use Commands Extension.</p>
</body>
</html>`;
	}
}
