import * as vscode from 'vscode';
import { CommandDefinition } from './types';
import { loadCommands, addCommandToFile } from './commandsProvider';
import { TerminalManager } from './terminalManager';

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

	private _handleMessage(message: { type: string; name?: string; command?: string; shellType?: string; cwd?: string; cmdType?: string; group?: string }): void {
		switch (message.type) {
			case 'ready':
				this._sendCommands();
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
				this._view?.webview.postMessage({ type: 'commandStarted', name: message.name });
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
			case 'clearTerminals':
				TerminalManager.getInstance().disposeAll();
				break;
			case 'refresh':
				this._sendCommands();
				break;
		}
	}

	private _runCommand(cmd: CommandDefinition): void {
		TerminalManager.getInstance().runCommand(cmd);
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
		<div class="toolbar-actions">
			<button id="addBtn" class="toolbar-btn" title="Add command">+</button>
			<button id="clearBtn" class="toolbar-btn" title="Close all terminals"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 12.6l.7.7 1.6-1.6 1.6 1.6.8-.7L13 11l1.7-1.6-.8-.8-1.6 1.7-1.6-1.7-.7.8 1.6 1.6-1.6 1.6zM1 4h14V3H1v1zm0 3h14V6H1v1zm8 2.5V9H1v1h8v-.5zM9 13v-1H1v1h8z"/></svg></button>
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
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
