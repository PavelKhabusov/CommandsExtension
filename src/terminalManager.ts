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
		const { terminal, commandText, created } = this._prepareTerminal(cmd);
		terminal.show();
		terminal.sendText(commandText);
		if (created) this._notifyChange();
	}

	/**
	 * Run a command and wait for it to complete via VS Code Shell Integration.
	 * - If SI is available: resolves with `{ exitCode, tracked: true }` when the
	 *   command exits.
	 * - If SI is unavailable (custom shell, etc.): falls back to fire-and-go via
	 *   `sendText` and resolves immediately with `{ tracked: false }`.
	 *
	 * Used by `CombinedOpRunner` to chain steps reliably. `signal` aborts the
	 * wait (the terminal stays open — there's no clean cancel for an in-flight
	 * shell command, so we just stop waiting and let it run).
	 */
	public async runCommandTracked(
		cmd: CommandDefinition,
		signal?: AbortSignal,
		shellIntegrationTimeoutMs = 1500,
	): Promise<{ exitCode: number | undefined; tracked: boolean }> {
		const { terminal, commandText, created } = this._prepareTerminal(cmd);
		terminal.show();
		if (created) this._notifyChange();

		const si = await waitForShellIntegration(terminal, shellIntegrationTimeoutMs, signal);
		if (signal?.aborted) {
			// Don't even send text — the run was cancelled before we could start.
			return { exitCode: undefined, tracked: false };
		}
		if (!si) {
			terminal.sendText(commandText);
			return { exitCode: undefined, tracked: false };
		}
		const exec = si.executeCommand(commandText);
		return new Promise((resolve) => {
			const onAbort = () => {
				sub.dispose();
				if (signal) signal.removeEventListener('abort', onAbort);
				resolve({ exitCode: undefined, tracked: false });
			};
			const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
				if (e.execution !== exec) return;
				sub.dispose();
				if (signal) signal.removeEventListener('abort', onAbort);
				resolve({ exitCode: e.exitCode, tracked: true });
			});
			if (signal) signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private _prepareTerminal(cmd: CommandDefinition): { terminal: vscode.Terminal; commandText: string; created: boolean } {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const terminalName = `Cmd: ${cmd.name}`;
		const commandText = cmd.type === 'node'
			? `node ${cmd.command}`
			: cmd.type === 'pwsh'
				? `pwsh -Command ${cmd.command}`
				: cmd.command;

		let existing = this._terminals.get(terminalName);
		if (existing && !this._isTerminalAlive(existing)) {
			this._terminals.delete(terminalName);
			existing = undefined;
		}
		// Fallback: a pre-existing terminal with the same name may not have been
		// adopted yet (e.g. SSE subscriber firing before onDidOpenTerminal). Look
		// at live terminals to avoid spawning a duplicate `Cmd: deploy`.
		if (!existing) {
			for (const t of vscode.window.terminals) {
				if (t.name === terminalName) {
					existing = t;
					this._terminals.set(terminalName, t);
					break;
				}
			}
		}
		if (existing) {
			return { terminal: existing, commandText, created: false };
		}
		const terminal = vscode.window.createTerminal({
			name: terminalName,
			cwd: cmd.cwd && workspaceRoot ? path.join(workspaceRoot, cmd.cwd) : workspaceRoot,
		});
		this._terminals.set(terminalName, terminal);
		return { terminal, commandText, created: true };
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

async function waitForShellIntegration(
	terminal: vscode.Terminal,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<vscode.TerminalShellIntegration | undefined> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (signal?.aborted) return undefined;
		if (terminal.shellIntegration) return terminal.shellIntegration;
		await new Promise((r) => setTimeout(r, 100));
	}
	return undefined;
}
