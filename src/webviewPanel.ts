import * as vscode from 'vscode';
import { CommandDefinition } from './types';
import { loadCommands, addCommandToFile } from './commandsProvider';
import { TerminalManager } from './terminalManager';

export class CommandsPanel {
	public static currentPanel: CommandsPanel | undefined;
	private static readonly viewType = 'commandsExtension.panel';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private _disposables: vscode.Disposable[] = [];
	private _htmlSet = false;

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

		if (!this._htmlSet) {
			// Set HTML only once on first creation
			// The webview JS will send a 'ready' message when initialized,
			// which triggers _sendInitialCommands via the message handler
			this._panel.webview.html = this._getHtmlForWebview();
			this._htmlSet = true;
		} else {
			// Subsequent updates: only send data via postMessage
			this._panel.webview.postMessage({ type: 'updateCommands', groups });
		}
	}

	private _handleMessage(message: { type: string; name?: string; command?: string; shellType?: string; cwd?: string; cmdType?: string; group?: string }): void {
		switch (message.type) {
			case 'ready':
				this._update();
				break;
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
			case 'addCommand': {
				if (!message.name || !message.command) {
					return;
				}
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!workspaceRoot) {
					vscode.window.showWarningMessage('No workspace folder open. Cannot add command.');
					return;
				}
				const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands.json');
				addCommandToFile(workspaceRoot, {
					name: message.name,
					command: message.command,
					type: message.cmdType || 'terminal',
					group: message.group || 'General',
				}, configFile);
				break;
			}
			case 'refresh':
				this._update();
				break;
		}
	}

	private _runCommand(cmd: CommandDefinition): void {
		TerminalManager.getInstance().runCommand(cmd);
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
		<div class="toolbar-actions">
			<button id="addBtn" class="toolbar-btn" title="Add command">+</button>
			<button id="refreshBtn" class="toolbar-btn" title="Refresh commands">&#x21bb;</button>
		</div>
	</div>
	<div id="add-command-form">
		<div class="form-group">
			<label for="cmdNameInput">Name</label>
			<input type="text" id="cmdNameInput" placeholder="Build Project">
		</div>
		<div class="form-group">
			<label for="cmdCommandInput">Command</label>
			<input type="text" id="cmdCommandInput" placeholder="npm run build">
		</div>
		<div class="form-group">
			<label for="cmdTypeSelect">Type</label>
			<select id="cmdTypeSelect">
				<option value="terminal">terminal</option>
				<option value="node">node</option>
				<option value="pwsh">pwsh</option>
			</select>
		</div>
		<div class="form-group">
			<label for="cmdGroupInput">Group</label>
			<input type="text" id="cmdGroupInput" placeholder="General">
		</div>
		<div class="form-actions">
			<button id="saveCommandBtn" class="btn-primary">Save</button>
			<button id="cancelCommandBtn" class="btn-secondary">Cancel</button>
		</div>
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
