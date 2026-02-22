import * as vscode from 'vscode';
import * as path from 'path';
import { CommandDefinition } from './types';
import { loadCommands } from './commandsProvider';

export class CommandsSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'commandsExtension.sidebarView';

	private _view?: vscode.WebviewView;

	constructor(private readonly _extensionUri: vscode.Uri) {}

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

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((message) => {
			this._handleMessage(message);
		});

		// Send initial commands after a short delay for the webview to initialize
		setTimeout(() => {
			this._sendCommands();
		}, 100);
	}

	public async refresh(): Promise<void> {
		if (this._view) {
			await this._sendCommands();
		}
	}

	private async _sendCommands(): Promise<void> {
		if (!this._view) {
			return;
		}

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return;
		}

		const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands.json');
		const groups = await loadCommands(workspaceRoot, configFile);
		this._view.webview.postMessage({ type: 'updateCommands', groups });
	}

	private _handleMessage(message: { type: string; name?: string; command?: string; shellType?: string; cwd?: string }): void {
		switch (message.type) {
			case 'runCommand': {
				if (!message.command || !message.shellType || !message.name) {
					return;
				}
				const cmd: CommandDefinition = {
					name: message.name,
					command: message.command,
					type: message.shellType as CommandDefinition['type'],
					group: '',
					cwd: message.cwd,
				};
				this._runCommand(cmd);
				this._view?.webview.postMessage({ type: 'commandStarted', name: message.name });
				break;
			}
			case 'refresh':
				this._sendCommands();
				break;
		}
	}

	private _runCommand(cmd: CommandDefinition): void {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		const terminalOptions: vscode.TerminalOptions = {
			name: `Cmd: ${cmd.name}`,
			cwd: cmd.cwd && workspaceRoot
				? path.join(workspaceRoot, cmd.cwd)
				: workspaceRoot,
		};

		if (cmd.type === 'pwsh') {
			terminalOptions.shellPath = 'pwsh';
		}

		const terminal = vscode.window.createTerminal(terminalOptions);
		terminal.show();

		if (cmd.type === 'node') {
			terminal.sendText(`node ${cmd.command}`);
		} else {
			terminal.sendText(cmd.command);
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css')
		);

		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleUri}" rel="stylesheet">
	<title>Commands</title>
</head>
<body>
	<div id="toolbar">
		<h2>Commands</h2>
		<button id="refreshBtn" title="Refresh commands">&#x21bb;</button>
	</div>
	<div id="commands-container">
		<p class="loading">Loading commands...</p>
	</div>
	<div id="empty-state">
		<p>No commands found.</p>
		<p>Add a <code>commands.json</code> file or <code>package.json</code> scripts to your workspace.</p>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
