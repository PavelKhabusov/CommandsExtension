import * as vscode from 'vscode';
import { CommandDefinition } from './types';
import { loadCommands, addCommandToFile, moveCommandInFile, removeGroupFromFile, removeCommandFromFile } from './commandsProvider';
import { getMarketplaceTemplates } from './marketplace';
import { TerminalManager } from './terminalManager';

export function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export function showTimedInfo(message: string, timeout = 3000): void {
	vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: message },
		() => new Promise(resolve => setTimeout(resolve, timeout))
	);
}

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'main.js')
	);
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, 'media', 'main.css')
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
			<div id="search-bar">
				<svg class="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.242.156a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>
				<input type="text" id="searchInput" placeholder="Filter commands...">
				<button id="searchClearBtn" class="search-clear-btn" title="Clear search">&#x2715;</button>
			</div>
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

function getConfigFile(): string {
	return vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands-list.json');
}

export class WebviewMessageHandler {
	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _postMessage: (msg: unknown) => void,
		private readonly _refresh: () => void,
	) {}

	public async handleMessage(message: Record<string, unknown>): Promise<void> {
		switch (message.type) {
			case 'ready':
				this._refresh();
				break;
			case 'saveCollapsedGroups':
				if (message.collapsedGroups) {
					await this._setCollapsedGroups(message.collapsedGroups as string[]);
				}
				break;
			case 'toggleFavorite': {
				if (!message.commandKey) return;
				const favorites = this.getFavorites();
				const index = favorites.indexOf(message.commandKey as string);
				if (index === -1) {
					favorites.push(message.commandKey as string);
				} else {
					favorites.splice(index, 1);
				}
				await this._setFavorites(favorites);
				this._refresh();
				break;
			}
			case 'runCommand': {
				if (!message.command || !message.shellType || !message.name) return;
				const cmd: CommandDefinition = {
					name: message.name as string,
					command: message.command as string,
					type: message.shellType as CommandDefinition['type'],
					group: '',
					cwd: message.cwd as string | undefined,
				};
				TerminalManager.getInstance().runCommand(cmd);
				this._postMessage({ type: 'commandStarted', name: message.name });
				break;
			}
			case 'addCommand': {
				if (!message.name || !message.command) return;
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!workspaceRoot) {
					vscode.window.showWarningMessage('No workspace folder open. Cannot add command.');
					return;
				}
				await addCommandToFile(workspaceRoot, {
					name: message.name as string,
					command: message.command as string,
					type: (message.cmdType as string) || 'terminal',
					group: (message.group as string) || 'General',
				}, getConfigFile());
				break;
			}
			case 'addTemplateGroup': {
				if (!message.groupId) return;
				await this._addTemplateGroup(message.groupId as string);
				break;
			}
			case 'addTemplateCommand': {
				if (!message.groupId || !message.commandName) return;
				await this._addTemplateCommand(message.groupId as string, message.commandName as string);
				break;
			}
			case 'moveCommand': {
				if (!message.commandName || !message.sourceGroup || !message.targetGroup) return;
				const moveRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!moveRoot) {
					vscode.window.showWarningMessage('No workspace folder open.');
					return;
				}
				await moveCommandInFile(moveRoot, message.commandName as string, message.sourceGroup as string, message.targetGroup as string, getConfigFile());
				break;
			}
			case 'deleteCommand': {
				if (!message.commandName || !message.sourceGroup) return;
				const delRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!delRoot) {
					vscode.window.showWarningMessage('No workspace folder open.');
					return;
				}
				await removeCommandFromFile(delRoot, message.commandName as string, message.sourceGroup as string, getConfigFile());
				break;
			}
			case 'deleteGroup': {
				if (!message.group) return;
				await this._deleteGroup(message.group as string);
				break;
			}
			case 'toggleConfirm': {
				if (!message.commandKey) return;
				const confirms = this.getConfirmCommands();
				const cIdx = confirms.indexOf(message.commandKey as string);
				if (cIdx === -1) {
					confirms.push(message.commandKey as string);
				} else {
					confirms.splice(cIdx, 1);
				}
				await this._setConfirmCommands(confirms);
				this._postMessage({ type: 'updateConfirmCommands', confirmCommands: confirms });
				break;
			}
			case 'confirmRun': {
				if (!message.command || !message.shellType || !message.name) return;
				const answer = await vscode.window.showWarningMessage(
					`Run "${message.name}"?`,
					{ modal: true, detail: `Command: ${message.command}` },
					'Run'
				);
				if (answer !== 'Run') return;
				const confirmCmd: CommandDefinition = {
					name: message.name as string,
					command: message.command as string,
					type: message.shellType as CommandDefinition['type'],
					group: '',
					cwd: message.cwd as string | undefined,
				};
				TerminalManager.getInstance().runCommand(confirmCmd);
				this._postMessage({ type: 'commandStarted', name: message.name });
				break;
			}
			case 'closeTerminal':
				if (message.name) TerminalManager.getInstance().closeTerminal(message.name as string);
				break;
			case 'clearTerminals':
				TerminalManager.getInstance().disposeAll();
				break;
			case 'refresh':
				this._refresh();
				break;
		}
	}

	public getFavorites(): string[] {
		return this._context.workspaceState.get<string[]>('commandsExtension.favorites', []);
	}

	public getCollapsedGroups(): string[] {
		return this._context.workspaceState.get<string[]>('commandsExtension.collapsedGroups', []);
	}

	public getConfirmCommands(): string[] {
		return this._context.workspaceState.get<string[]>('commandsExtension.confirmCommands', []);
	}

	private async _setFavorites(favorites: string[]): Promise<void> {
		await this._context.workspaceState.update('commandsExtension.favorites', favorites);
	}

	private async _setCollapsedGroups(groups: string[]): Promise<void> {
		await this._context.workspaceState.update('commandsExtension.collapsedGroups', groups);
	}

	private async _setConfirmCommands(commands: string[]): Promise<void> {
		await this._context.workspaceState.update('commandsExtension.confirmCommands', commands);
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

		const configFile = getConfigFile();
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

		await addCommandToFile(workspaceRoot, {
			name: cmd.name,
			command: cmd.command,
			type: cmd.type,
			group: cmd.group,
		}, getConfigFile());
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

		const removed = await removeGroupFromFile(workspaceRoot, groupName, getConfigFile());
		if (removed > 0) {
			showTimedInfo(`Deleted ${removed} command(s) from "${groupName}"`);
		}
	}
}

export async function sendCommandsToWebview(
	postMessage: (msg: unknown) => void,
	handler: WebviewMessageHandler
): Promise<void> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) return;

	const configFile = getConfigFile();
	const groups = await loadCommands(workspaceRoot, configFile);
	const favorites = handler.getFavorites();
	const collapsedGroups = handler.getCollapsedGroups();
	const confirmCommands = handler.getConfirmCommands();
	const activeTerminals = TerminalManager.getInstance().getActiveCommandNames();
	postMessage({ type: 'updateCommands', groups, favorites, collapsedGroups, confirmCommands, activeTerminals });
	postMessage({ type: 'updateMarketplace', templates: getMarketplaceTemplates() });
}

export function sendActiveTerminals(postMessage: (msg: unknown) => void): void {
	const activeTerminals = TerminalManager.getInstance().getActiveCommandNames();
	postMessage({ type: 'updateActiveTerminals', activeTerminals });
}
