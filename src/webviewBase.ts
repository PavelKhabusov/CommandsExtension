import * as vscode from 'vscode';
import { CommandDefinition } from './types';
import { loadCommands, addCommandToFile, moveCommandInFile, removeGroupFromFile, removeCommandFromFile, loadCombinedOps, saveCombinedOp, deleteCombinedOp } from './commandsProvider';
import { getMarketplaceTemplates } from './marketplace';
import { TerminalManager } from './terminalManager';
import { loadUploads, uploadKey, pickFilesAndAppend, addUploadItems, addUploadExcludes, pickExcludePatternsForUpload, ensureUploadsFile, resolveServer } from './uploadsProvider';
import { uploadRunner, uploadStalenessTracker, StalenessInfo, combinedOpRunner } from './extension';
import { UploadDefinition, ServerDefinition } from './uploadsTypes';
import { CombinedOpDefinition, CombinedOpProgress } from './combinedOpsTypes';
import { getPresetAvailability, soundCommand, notificationCommand, openCommand } from './platformHelpers';
import { loadAllHooks, saveHook, deleteHook, setHookEnabled, ALL_HOOK_EVENTS, MATCHER_EVENTS, HookEntry, HookEvent, HookTargetFile, getHookFilePaths } from './claudeHooksProvider';

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
	<div id="combined-wrapper"></div>
	<div id="uploads-wrapper"></div>
	<div id="hooks-wrapper"></div>
	<div id="marketplace-wrapper"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getConfigFile(): string {
	return vscode.workspace.getConfiguration('commandsExtension').get<string>('configFile', 'commands-list.json');
}

function getUploadsFile(): string {
	return vscode.workspace.getConfiguration('commandsExtension').get<string>('uploadsFile', 'server-uploads.local.json');
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
			case 'setMarketplaceCollapsed':
				await this._context.workspaceState.update('commandsExtension.marketplaceCollapsed', !!message.value);
				break;
			case 'setUploadsCollapsed':
				await this._context.workspaceState.update('commandsExtension.uploadsCollapsed', !!message.value);
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
			case 'runUpload': {
				const upload = this._findUpload(message.uploadName as string, message.uploadGroup as string);
				if (!upload || !uploadRunner) return;
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot) return;
				const resolved = resolveServer(upload, this._cachedServers);
				if (!resolved) {
					vscode.window.showErrorMessage(
						`Upload "${upload.name}" is missing server config. Define inline (host/user/protocol) or reference a "servers" entry.`
					);
					return;
				}
				uploadRunner.run(wsRoot, resolved).catch((e) => {
					vscode.window.showErrorMessage(`Upload failed: ${e instanceof Error ? e.message : e}`);
				});
				break;
			}
			case 'cancelUpload': {
				if (!uploadRunner) return;
				const key = `${(message.uploadGroup as string) || 'Uploads'}:${message.uploadName as string}`;
				uploadRunner.cancel(key);
				break;
			}
			case 'pickUploadItems': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot) return;
				const newItems = await pickFilesAndAppend(wsRoot);
				if (newItems.length === 0) return;
				await addUploadItems(
					wsRoot,
					getUploadsFile(),
					message.uploadName as string,
					(message.uploadGroup as string) || 'Uploads',
					newItems
				);
				this._refresh();
				break;
			}
			case 'pickUploadExcludes': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot) return;
				const upload = this._findUpload(message.uploadName as string, message.uploadGroup as string);
				if (!upload) return;
				const patterns = await pickExcludePatternsForUpload(wsRoot, upload);
				if (patterns.length === 0) return;
				await addUploadExcludes(
					wsRoot,
					getUploadsFile(),
					upload.name,
					upload.group || 'Uploads',
					patterns
				);
				this._refresh();
				break;
			}
			case 'markUploadSynced': {
				if (message.uploadKey) uploadStalenessTracker?.markSynced(message.uploadKey as string);
				break;
			}
			case 'runAutoUpload': {
				const uploadKeys = message.uploadKeys as string[];
				if (!uploadKeys?.length || !uploadRunner) return;
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot) return;
				const stalenessMap = uploadStalenessTracker?.getStalenessMap() ?? {};
				for (const uKey of uploadKeys) {
					const sep = uKey.indexOf(':');
					if (sep === -1) continue;
					const groupName = uKey.substring(0, sep);
					const uploadName = uKey.substring(sep + 1);
					const upload = this._findUpload(uploadName, groupName);
					if (!upload) continue;
					const resolved = resolveServer(upload, this._cachedServers);
					if (!resolved) continue;
					const info = stalenessMap[uKey];
					const fileFilter = info?.staleFiles.length ? new Set(info.staleFiles) : undefined;
					if (!fileFilter?.size) continue;
					uploadRunner.run(wsRoot, resolved, fileFilter).catch((e) => {
						vscode.window.showErrorMessage(`Upload failed: ${e instanceof Error ? e.message : e}`);
					});
				}
				break;
			}
			case 'editUploadsFile': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot) return;
				const uri = await ensureUploadsFile(wsRoot, getUploadsFile());
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc);
				break;
			}
			case 'setCombinedCollapsed':
				await this._context.workspaceState.update('commandsExtension.combinedCollapsed', !!message.value);
				break;
			case 'runCombinedOp': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot || !combinedOpRunner) return;
				const ops = await loadCombinedOps(wsRoot, getConfigFile());
				const op = ops.find((o) => o.name === message.opName);
				if (!op) {
					vscode.window.showWarningMessage(`Combined op "${message.opName}" not found.`);
					return;
				}
				void combinedOpRunner.run(op).catch((e) => {
					vscode.window.showErrorMessage(`Combined op failed: ${e instanceof Error ? e.message : e}`);
				});
				break;
			}
			case 'cancelCombinedOp': {
				if (!combinedOpRunner || !message.opName) return;
				combinedOpRunner.cancel(message.opName as string);
				break;
			}
			case 'saveCombinedOp': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot || !message.op) return;
				const op = message.op as CombinedOpDefinition;
				const originalName = message.originalName as string | undefined;
				await saveCombinedOp(wsRoot, op, originalName, getConfigFile());
				this._refresh();
				break;
			}
			case 'rpcInputBox': {
				const result = await vscode.window.showInputBox({
					title: message.title as string | undefined,
					value: message.defaultValue as string | undefined,
					placeHolder: message.placeholder as string | undefined,
					prompt: message.prompt as string | undefined,
				});
				this._postMessage({ type: 'rpcResult', _reqId: message._reqId, result });
				break;
			}
			case 'rpcQuickPick': {
				const result = await vscode.window.showQuickPick(message.items as string[], {
					title: message.title as string | undefined,
					placeHolder: message.placeholder as string | undefined,
				});
				this._postMessage({ type: 'rpcResult', _reqId: message._reqId, result });
				break;
			}
			case 'pickVscodeCommand': {
				// Native quickPick — there can be 1000+ command IDs registered,
				// so we feed them all and let VS Code's built-in fuzzy filter do
				// the heavy lifting instead of transferring everything to the
				// webview.
				const all = await vscode.commands.getCommands(true);
				all.sort();
				const pick = await vscode.window.showQuickPick(all, {
					title: 'Pick a VS Code command',
					placeHolder: 'Search by ID (e.g. workbench.action.reloadWindow)',
					matchOnDescription: true,
				});
				if (!pick) return;
				this._postMessage({ type: 'vscodeCommandPicked', commandId: pick });
				break;
			}
			case 'deleteCombinedOp': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot || !message.opName) return;
				const confirm = await vscode.window.showWarningMessage(
					`Delete combined operation "${message.opName}"?`,
					{ modal: true },
					'Delete'
				);
				if (confirm !== 'Delete') return;
				await deleteCombinedOp(wsRoot, message.opName as string, getConfigFile());
				this._refresh();
				break;
			}
			case 'setHooksCollapsed':
				await this._context.workspaceState.update('commandsExtension.hooksCollapsed', !!message.value);
				break;
			case 'setHooksShowGlobal':
				await this._context.workspaceState.update('commandsExtension.hooksShowGlobal', !!message.value);
				break;
			case 'saveClaudeHook': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot || !message.hook) return;
				try {
					await saveHook(wsRoot, message.hook as HookEntry, message.originalId as string | undefined, this._context);
					this._refresh();
				} catch (e) {
					vscode.window.showWarningMessage(`Failed to save hook: ${e instanceof Error ? e.message : e}`);
				}
				break;
			}
			case 'deleteClaudeHook': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot || !message.id) return;
				const confirm = await vscode.window.showWarningMessage(
					'Delete this hook?',
					{ modal: true },
					'Delete'
				);
				if (confirm !== 'Delete') return;
				await deleteHook(wsRoot, message.id as string, this._context);
				this._refresh();
				break;
			}
			case 'toggleClaudeHook': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot || !message.id) return;
				await setHookEnabled(wsRoot, message.id as string, !!message.enabled, this._context);
				this._refresh();
				break;
			}
			case 'copyClaudeHook': {
				if (!message.hook) return;
				const h = message.hook as HookEntry;
				const exported = {
					event: h.event,
					matcher: h.matcher,
					command: h.command,
					timeout: h.timeout,
				};
				await vscode.env.clipboard.writeText(JSON.stringify(exported, null, 2));
				vscode.window.showInformationMessage('Hook copied to clipboard.');
				break;
			}
			case 'pasteClaudeHook': {
				try {
					const text = await vscode.env.clipboard.readText();
					const parsed = JSON.parse(text);
					if (!parsed.event || !parsed.command) {
						vscode.window.showWarningMessage('Clipboard JSON missing event/command fields.');
						return;
					}
					this._postMessage({ type: 'openHookEditorFromPaste', hook: parsed });
				} catch {
					vscode.window.showWarningMessage('Clipboard is not valid JSON hook spec.');
				}
				break;
			}
			case 'openClaudeHookFile': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!wsRoot || !message.target) return;
				const paths = getHookFilePaths(wsRoot);
				const filePath = paths[message.target as HookTargetFile];
				try {
					const doc = await vscode.workspace.openTextDocument(filePath);
					await vscode.window.showTextDocument(doc);
				} catch (e) {
					vscode.window.showWarningMessage(`Cannot open ${filePath}: ${e instanceof Error ? e.message : e}`);
				}
				break;
			}
			case 'openHookScript': {
				const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				let p = String(message.path || '');
				if (!p) return;
				// Strip stray quotes first — shells let `"$VAR"/path` exist as one
				// concatenated token, so the captured string can be mixed-quoted.
				p = p.replace(/["']/g, '');
				// Expand $CLAUDE_PROJECT_DIR / ${CLAUDE_PROJECT_DIR}
				if (wsRoot) {
					p = p.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, wsRoot);
				}
				// Expand ~
				if (p.startsWith('~/') || p === '~') {
					const homedir = require('os').homedir();
					p = require('path').join(homedir, p.slice(1));
				}
				try {
					const doc = await vscode.workspace.openTextDocument(p);
					await vscode.window.showTextDocument(doc);
				} catch (e) {
					vscode.window.showWarningMessage(`Cannot open ${p}: ${e instanceof Error ? e.message : e}`);
				}
				break;
			}
		}
	}

	private _cachedUploads: UploadDefinition[] = [];
	private _cachedServers: ServerDefinition[] = [];

	public setCachedUploads(uploads: UploadDefinition[], servers: ServerDefinition[]): void {
		this._cachedUploads = uploads;
		this._cachedServers = servers;
	}

	private _findUpload(name: string, group: string): UploadDefinition | undefined {
		const groupName = group || 'Uploads';
		return this._cachedUploads.find(
			(u) => u.name === name && (u.group || 'Uploads') === groupName
		);
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

	public getMarketplaceCollapsed(): boolean | undefined {
		return this._context.workspaceState.get<boolean>('commandsExtension.marketplaceCollapsed');
	}

	public getUploadsCollapsed(): boolean | undefined {
		return this._context.workspaceState.get<boolean>('commandsExtension.uploadsCollapsed');
	}

	public getCombinedCollapsed(): boolean | undefined {
		return this._context.workspaceState.get<boolean>('commandsExtension.combinedCollapsed');
	}

	public getHooksCollapsed(): boolean | undefined {
		return this._context.workspaceState.get<boolean>('commandsExtension.hooksCollapsed');
	}

	public getHooksShowGlobal(): boolean {
		return this._context.workspaceState.get<boolean>('commandsExtension.hooksShowGlobal', false);
	}

	public getContext(): vscode.ExtensionContext {
		return this._context;
	}

	private async _setFavorites(favorites: string[]): Promise<void> {
		await this._context.workspaceState.update('commandsExtension.favorites', favorites);
		// Notify the external hub immediately — without this, the new favorite
		// state only reaches downstream UIs (home-kit-dash etc.) on the next
		// unrelated publish trigger (terminal open/close, file edit, etc.).
		void vscode.commands.executeCommand('commandsExtension._republishExternal');
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

	const { groups: uploadGroups, servers } = await loadUploads(workspaceRoot, getUploadsFile());
	const flatUploads: UploadDefinition[] = [];
	for (const g of uploadGroups) for (const u of g.uploads) flatUploads.push(u);
	handler.setCachedUploads(flatUploads, servers);

	const displayGroups = uploadGroups.map((g) => ({
		name: g.name,
		uploads: g.uploads.map((u) => {
			const resolved = resolveServer(u, servers);
			if (!resolved) {
				return { ...u, _unresolved: true };
			}
			return {
				...u,
				protocol: resolved.protocol,
				host: resolved.host,
				port: resolved.port,
				user: resolved.user,
			};
		}),
	}));

	const lastStatuses = uploadRunner ? uploadRunner.getLastStatuses() : [];
	const activeKeys: string[] = [];
	if (uploadRunner) {
		for (const u of flatUploads) {
			const key = uploadKey(u);
			if (uploadRunner.isRunning(key)) activeKeys.push(key);
		}
	}
	const stalenessMap = uploadStalenessTracker ? uploadStalenessTracker.getStalenessMap() : {};
	const marketplaceCollapsed = handler.getMarketplaceCollapsed();
	const uploadsCollapsed = handler.getUploadsCollapsed();
	postMessage({
		type: 'updateUploads',
		groups: displayGroups,
		statuses: lastStatuses,
		activeKeys,
		uploadsCollapsed,
		stalenessMap,
	});
	postMessage({
		type: 'updateSectionCollapse',
		marketplaceCollapsed,
		uploadsCollapsed,
	});

	// Combined operations — feed both the ops themselves AND the picker context
	// (server list + command list) so the editor modal can populate dropdowns
	// without round-trips.
	const combinedOps = await loadCombinedOps(workspaceRoot, configFile);
	const lastCombinedStatuses = combinedOpRunner ? combinedOpRunner.getLastStatuses() : [];
	const activeCombinedOps: string[] = combinedOpRunner
		? combinedOps.filter((op) => combinedOpRunner!.isRunning(op.name)).map((op) => op.name)
		: [];
	const combinedCollapsed = handler.getCombinedCollapsed();

	// Distinct server displays from uploads — used for the auto-upload step
	// dropdown in the editor.
	const serverDisplays = Array.from(new Set(
		flatUploads.map((u) => {
			const r = resolveServer(u, servers);
			return r ? `${r.user}@${r.host}` : `${u.user ?? ''}@${u.host ?? ''}`;
		}).filter((s) => s && s !== '@')
	));

	const commandNames = groups.flatMap((g) => g.commands.map((c) => ({ name: c.name, group: g.name })));
	const uploadKeys = flatUploads.map((u) => ({
		key: `${u.group || 'Uploads'}:${u.name}`,
		name: u.name,
		group: u.group || 'Uploads',
	}));

	postMessage({
		type: 'updateCombined',
		ops: combinedOps,
		statuses: lastCombinedStatuses,
		activeOps: activeCombinedOps,
		combinedCollapsed,
		pickContext: {
			commands: commandNames,
			uploads: uploadKeys,
			servers: serverDisplays,
			presetAvailability: getPresetAvailability(),
		},
	});

	// Claude hooks
	const hooks = await loadAllHooks(workspaceRoot, handler.getContext());
	const hookFilePaths = getHookFilePaths(workspaceRoot);
	// For the "Existing command" picker — name + actual script body so the hook
	// stores the runnable string, not just the human-readable name.
	const commandsForHooks = groups.flatMap((g) => g.commands.map((c) => ({
		name: c.name,
		command: c.command,
		group: g.name,
	})));
	postMessage({
		type: 'updateClaudeHooks',
		hooks,
		filePaths: hookFilePaths,
		events: ALL_HOOK_EVENTS,
		matcherEvents: Array.from(MATCHER_EVENTS),
		commands: commandsForHooks,
		presetTemplates: {
			sound: soundCommand(),
			notification: notificationCommand('{event} fired'),
			open: openCommand('https://example.com', 'url'),
			waitSeconds: 5,
			appendTimestamp: 'echo "$(date \'+%F %T\') [{event}]" >> .claude/event.log',
		},
		presetAvailability: getPresetAvailability(),
		hooksCollapsed: handler.getHooksCollapsed(),
		hooksShowGlobal: handler.getHooksShowGlobal(),
	});
}

export function sendActiveTerminals(postMessage: (msg: unknown) => void): void {
	const activeTerminals = TerminalManager.getInstance().getActiveCommandNames();
	postMessage({ type: 'updateActiveTerminals', activeTerminals });
}

export function sendUploadProgress(postMessage: (msg: unknown) => void, progress: unknown): void {
	postMessage({ type: 'uploadProgress', progress });
}

export function sendUploadStaleness(
	postMessage: (msg: unknown) => void,
	key: string,
	info: StalenessInfo
): void {
	postMessage({ type: 'uploadStaleness', uploadKey: key, ...info });
}

export function sendCombinedOpProgress(
	postMessage: (msg: unknown) => void,
	progress: CombinedOpProgress,
): void {
	postMessage({ type: 'combinedOpProgress', progress });
}
