import * as vscode from 'vscode';
import { CommandDefinition } from './types';
import { loadCommands, addCommandToFile, moveCommandInFile, removeGroupFromFile } from './commandsProvider';
import { getMarketplaceTemplates } from './marketplace';
import { TerminalManager } from './terminalManager';

export class CommandsPanel {
	public static currentPanel: CommandsPanel | undefined;
	private static readonly viewType = 'commandsExtension.panel';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _extensionUri: vscode.Uri;
	private readonly _context: vscode.ExtensionContext;
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

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
		this._panel = panel;
		this._extensionUri = extensionUri;
		this._context = context;

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

		const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands-list.json');
		const groups = await loadCommands(workspaceRoot, configFile);

		if (!this._htmlSet) {
			// Set HTML only once on first creation
			// The webview JS will send a 'ready' message when initialized,
			// which triggers _sendInitialCommands via the message handler
			this._panel.webview.html = this._getHtmlForWebview();
			this._htmlSet = true;
		} else {
			// Subsequent updates: only send data via postMessage
			const favorites = this._getFavorites();
			this._panel.webview.postMessage({ type: 'updateCommands', groups, favorites });
			this._panel.webview.postMessage({ type: 'updateMarketplace', templates: getMarketplaceTemplates() });
		}
	}

	private _handleMessage(message: { type: string; name?: string; command?: string; shellType?: string; cwd?: string; cmdType?: string; group?: string; groupId?: string; commandName?: string; commandKey?: string; sourceGroup?: string; targetGroup?: string }): void {
		switch (message.type) {
			case 'ready':
				this._update();
				break;
			case 'toggleFavorite': {
				if (!message.commandKey) return;
				const favorites = this._getFavorites();
				const index = favorites.indexOf(message.commandKey);
				if (index === -1) {
					favorites.push(message.commandKey);
				} else {
					favorites.splice(index, 1);
				}
				this._setFavorites(favorites);
				this._update();
				break;
			}
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
				const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands-list.json');
				addCommandToFile(workspaceRoot, {
					name: message.name,
					command: message.command,
					type: message.cmdType || 'terminal',
					group: message.group || 'General',
				}, configFile);
				break;
			}
			case 'addTemplateGroup': {
				if (!message.groupId) return;
				this._addTemplateGroup(message.groupId);
				break;
			}
			case 'addTemplateCommand': {
				if (!message.groupId || !message.commandName) return;
				this._addTemplateCommand(message.groupId, message.commandName);
				break;
			}
			case 'moveCommand': {
				if (!message.commandName || !message.sourceGroup || !message.targetGroup) return;
				const moveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!moveRoot) {
					vscode.window.showWarningMessage('No workspace folder open.');
					return;
				}
				const moveConfig = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands-list.json');
				moveCommandInFile(moveRoot, message.commandName, message.sourceGroup, message.targetGroup, moveConfig);
				break;
			}
			case 'deleteGroup': {
				if (!message.group) return;
				this._deleteGroup(message.group);
				break;
			}
			case 'clearTerminals':
				TerminalManager.getInstance().disposeAll();
				break;
			case 'refresh':
				this._update();
				break;
		}
	}

	private async _addTemplateGroup(groupId: string): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showWarningMessage('No workspace folder open.');
			return;
		}
		const templates = getMarketplaceTemplates();
		const group = templates.find(t => t.id === groupId);
		if (!group) return;

		const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands-list.json');
		for (const cmd of group.commands) {
			await addCommandToFile(workspaceRoot, {
				name: cmd.name,
				command: cmd.command,
				type: cmd.type,
				group: cmd.group,
			}, configFile);
		}
		showTimedInfo(`Added ${group.commands.length} commands from "${group.name}"`);
	}

	private async _addTemplateCommand(groupId: string, commandName: string): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showWarningMessage('No workspace folder open.');
			return;
		}
		const templates = getMarketplaceTemplates();
		const group = templates.find(t => t.id === groupId);
		if (!group) return;

		const cmd = group.commands.find(c => c.name === commandName);
		if (!cmd) return;

		const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands-list.json');
		await addCommandToFile(workspaceRoot, {
			name: cmd.name,
			command: cmd.command,
			type: cmd.type,
			group: cmd.group,
		}, configFile);
		showTimedInfo(`Added "${cmd.name}" command`);
	}

	private async _deleteGroup(groupName: string): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) return;

		const confirm = await vscode.window.showWarningMessage(
			`Delete group "${groupName}" and all its commands?`,
			{ modal: true },
			'Delete'
		);
		if (confirm !== 'Delete') return;

		const configFile = vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands-list.json');
		const removed = await removeGroupFromFile(workspaceRoot, groupName, configFile);
		if (removed > 0) {
			showTimedInfo(`Deleted ${removed} command(s) from "${groupName}"`);
		}
	}

	private _getFavorites(): string[] {
		return this._context.workspaceState.get<string[]>('commandsExtension.favorites', []);
	}

	private async _setFavorites(favorites: string[]): Promise<void> {
		await this._context.workspaceState.update('commandsExtension.favorites', favorites);
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
	<div id="main-content">
		<div id="toolbar">
			<h2>Commands</h2>
			<div class="toolbar-actions">
				<button id="addBtn" class="toolbar-btn" title="Add command">+</button>
				<button id="collapseBtn" class="toolbar-btn" title="Collapse/Expand all groups"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L5.5 3.5l1 1L8 3l1.5 1.5 1-1L8 1zM4 6h8v1H4V6zm0 3h8v1H4V9zM8 15l2.5-2.5-1-1L8 13l-1.5-1.5-1 1L8 15z"/></svg></button>
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
				<label for="cmdGroupSelect">Group</label>
				<select id="cmdGroupSelect"><option value="">General</option><option value="__new__">+ New group...</option></select>
				<input type="text" id="cmdGroupInput" placeholder="New group name" style="display:none;margin-top:4px;">
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
			<p>Add a <code>commands-list.json</code> file or <code>package.json</code> scripts to your workspace.</p>
		</div>
	</div>
	<div id="marketplace-wrapper"></div>
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

function showTimedInfo(message: string, timeout = 3000): void {
	vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: message },
		() => new Promise(resolve => setTimeout(resolve, timeout))
	);
}
