import * as vscode from 'vscode';
import * as path from 'path';
import { CommandDefinition, CommandGroup } from './types';
import { loadCommands } from './commandsProvider';

export class CommandsPanel {
	public static currentPanel: CommandsPanel | undefined;
	private static readonly viewType = 'commandsExtension.panel';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];

	public static createOrShow(extensionUri: vscode.Uri): void {
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

		CommandsPanel.currentPanel = new CommandsPanel(panel, extensionUri);
	}

	public static refresh(): void {
		if (CommandsPanel.currentPanel) {
			CommandsPanel.currentPanel._update();
		}
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this._panel = panel;
		this._extensionUri = extensionUri;

		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.onDidReceiveMessage(
			(message) => this._handleMessage(message),
			null,
			this._disposables
		);

		this._update();
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

		const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands.json');
		const groups = await loadCommands(workspaceRoot, configFile);

		// Always set HTML first so the webview JS is loaded before we postMessage
		this._panel.webview.html = this._getHtmlForWebview();

		// Small delay to ensure the webview script has initialized
		setTimeout(() => {
			this._panel.webview.postMessage({ type: 'updateCommands', groups });
		}, 100);
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
				this._panel.webview.postMessage({ type: 'commandStarted', name: message.name });
				break;
			}
			case 'refresh':
				this._update();
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

	private _getHtmlForWebview(): string {
		const webview = this._panel.webview;

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

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
