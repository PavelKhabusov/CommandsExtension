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

	private constructor() {
		// Clean up terminals from the map when they are closed
		this._disposables.push(
			vscode.window.onDidCloseTerminal((closedTerminal) => {
				for (const [key, terminal] of this._terminals) {
					if (terminal === closedTerminal) {
						this._terminals.delete(key);
						break;
					}
				}
			})
		);
	}

	public static getInstance(): TerminalManager {
		if (!TerminalManager._instance) {
			TerminalManager._instance = new TerminalManager();
		}
		return TerminalManager._instance;
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
	}

	public getDisposables(): vscode.Disposable[] {
		return this._disposables;
	}
}
