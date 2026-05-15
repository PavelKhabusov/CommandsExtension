import * as vscode from 'vscode';
import * as path from 'path';
import { CommandDefinition } from './types';

/**
 * Manages terminal instances for command execution, reusing existing terminals
 * when the same command is run again instead of creating new ones every time.
 */
export class TerminalManager {
	private static _instance: TerminalManager | undefined;
	private readonly _terminals = new Map<string, vscode.Terminal>();
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _onChangeListeners = new Set<() => void>();

	private constructor() {
		// Clean up terminals from the map when they are closed.
		this._disposables.push(
			vscode.window.onDidCloseTerminal((closedTerminal) => {
				for (const [key, terminal] of this._terminals) {
					if (terminal === closedTerminal) {
						this._terminals.delete(key);
						break;
					}
				}
				this._notifyChange();
			})
		);
		// Pick up terminals that were created outside runCommand() — e.g. the
		// user manually opened `Cmd: foo` in VS Code's terminal UI, or another
		// extension recreated one after a reload.
		this._disposables.push(
			vscode.window.onDidOpenTerminal((t) => {
				if (!t.name.startsWith('Cmd: ')) return;
				if (!this._terminals.has(t.name)) {
					this._terminals.set(t.name, t);
					this._notifyChange();
				}
			})
		);
		// On boot, adopt any pre-existing matching terminals.
		for (const t of vscode.window.terminals) {
			if (t.name.startsWith('Cmd: ') && !this._terminals.has(t.name)) {
				this._terminals.set(t.name, t);
			}
		}
	}

	public static getInstance(): TerminalManager {
		if (!TerminalManager._instance) {
			TerminalManager._instance = new TerminalManager();
		}
		return TerminalManager._instance;
	}

	/**
	 * Subscribe to terminal-set changes. Returns a disposer.
	 * Multiple listeners are supported — older code that called this once just
	 * registers a single subscription.
	 */
	public onDidChange(listener: () => void): vscode.Disposable {
		this._onChangeListeners.add(listener);
		return new vscode.Disposable(() => {
			this._onChangeListeners.delete(listener);
		});
	}

	private _notifyChange(): void {
		for (const fn of this._onChangeListeners) {
			try { fn(); } catch { /* don't let one listener kill others */ }
		}
	}

	/**
	 * Returns command names (without "Cmd: " prefix) that have a live terminal.
	 * Looks at BOTH our managed map and `vscode.window.terminals` so user-opened
	 * terminals named "Cmd: foo" are also reported.
	 */
	public getActiveCommandNames(): string[] {
		const names = new Set<string>();
		for (const [terminalName, terminal] of this._terminals) {
			if (this._isTerminalAlive(terminal)) {
				names.add(terminalName.replace(/^Cmd: /, ''));
			}
		}
		for (const t of vscode.window.terminals) {
			if (t.name.startsWith('Cmd: ')) {
				names.add(t.name.replace(/^Cmd: /, ''));
			}
		}
		return [...names];
	}

	public closeTerminal(commandName: string): void {
		const terminalName = `Cmd: ${commandName}`;
		const terminal = this._terminals.get(terminalName);
		if (terminal) {
			terminal.dispose();
			this._terminals.delete(terminalName);
		}
	}

	public runCommand(cmd: CommandDefinition): void {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const terminalName = `Cmd: ${cmd.name}`;

		const commandText = cmd.type === 'node'
			? `node ${cmd.command}`
			: cmd.type === 'pwsh'
				? `pwsh -Command ${cmd.command}`
				: cmd.command;

		// Check if we already have a terminal for this command that is still alive
		const existing = this._terminals.get(terminalName);
		if (existing && this._isTerminalAlive(existing)) {
			existing.show();
			existing.sendText(commandText);
			return;
		}

		// Terminal was closed or doesn't exist — remove stale entry and create new
		this._terminals.delete(terminalName);

		const terminalOptions: vscode.TerminalOptions = {
			name: terminalName,
			cwd: cmd.cwd && workspaceRoot
				? path.join(workspaceRoot, cmd.cwd)
				: workspaceRoot,
		};

		const terminal = vscode.window.createTerminal(terminalOptions);
		this._terminals.set(terminalName, terminal);
		terminal.show();
		terminal.sendText(commandText);
		this._notifyChange();
	}

	private _isTerminalAlive(terminal: vscode.Terminal): boolean {
		return vscode.window.terminals.includes(terminal);
	}

	public disposeAll(): void {
		// Close all tracked terminals
		for (const terminal of this._terminals.values()) {
			terminal.dispose();
		}
		this._terminals.clear();

		// Also close any orphaned terminals created by this extension
		for (const terminal of vscode.window.terminals) {
			if (terminal.name.startsWith('Cmd: ')) {
				terminal.dispose();
			}
		}
		this._notifyChange();
	}

	public getDisposables(): vscode.Disposable[] {
		return this._disposables;
	}
}
