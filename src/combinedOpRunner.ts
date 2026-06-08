import * as vscode from 'vscode';
import { spawn } from 'child_process';
import {
  CombinedOpDefinition,
  CombinedOpProgress,
  CombinedOpStatus,
  CombinedStep,
  stepLabel,
} from './combinedOpsTypes';
import { TerminalManager } from './terminalManager';
import { CommandDefinition } from './types';
import { playSoundNative, openAppNative } from './platformHelpers';

export type CombinedProgressCallback = (p: CombinedOpProgress) => void;

export interface CombinedRunnerDeps {
  /** Lookup terminal command by display name. Searches all groups. */
  getCommandByName: (name: string) => Promise<CommandDefinition | undefined>;
  /** Run an upload by key. Resolves when finished (success or error).
   *  Throws on error so the runner can react to `stopOnError`. */
  runUploadByKey: (uploadKey: string, fileFilter?: Set<string>) => Promise<void>;
  /** Returns the set-cover for a server display ("user@host") —
   *  array of (uploadKey, staleFiles). Empty array = nothing to upload. */
  resolveAutoUploadForServer: (server: string) => Promise<Array<{ uploadKey: string; staleFiles: Set<string> }>>;
}

export class CombinedOpRunner {
  private readonly _active = new Map<string, AbortController>();
  private readonly _lastStatus = new Map<string, CombinedOpProgress>();

  constructor(
    private readonly _onProgress: CombinedProgressCallback,
    private readonly _deps: CombinedRunnerDeps,
  ) {}

  public getLastStatuses(): CombinedOpProgress[] {
    return Array.from(this._lastStatus.values());
  }

  public isRunning(opName: string): boolean {
    return this._active.has(opName);
  }

  public cancel(opName: string): void {
    const c = this._active.get(opName);
    if (c) c.abort();
  }

  public async run(op: CombinedOpDefinition): Promise<void> {
    if (this._active.has(op.name)) {
      vscode.window.showInformationMessage(`Combined op "${op.name}" is already running.`);
      return;
    }
    const ctrl = new AbortController();
    this._active.set(op.name, ctrl);

    const total = op.steps.length;
    const emit = (patch: Partial<CombinedOpProgress> & { status: CombinedOpStatus; step: number; currentLabel: string }) => {
      const merged: CombinedOpProgress = { opName: op.name, total, ...patch };
      this._lastStatus.set(op.name, merged);
      this._onProgress(merged);
    };

    const stopOnError = op.stopOnError !== false;

    try {
      for (let i = 0; i < op.steps.length; i++) {
        if (ctrl.signal.aborted) {
          emit({ status: 'cancelled', step: i + 1, currentLabel: 'cancelled', finishedAt: Date.now() });
          return;
        }
        const step = op.steps[i];
        // Per-step toggle — skip without aborting the rest of the op.
        if (step.enabled === false) {
          emit({ status: 'running', step: i + 1, currentLabel: 'skipped: ' + stepLabel(step), message: 'step disabled' });
          continue;
        }
        const label = stepLabel(step);
        emit({ status: 'running', step: i + 1, currentLabel: label, currentUploadKey: this._stepUploadKey(step) });

        try {
          await this._runStep(step, ctrl.signal, (msg) => emit({
            status: 'running', step: i + 1, currentLabel: label, message: msg,
            currentUploadKey: this._stepUploadKey(step),
          }));
        } catch (err) {
          if (ctrl.signal.aborted) {
            emit({ status: 'cancelled', step: i + 1, currentLabel: label, finishedAt: Date.now() });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          if (stopOnError) {
            emit({ status: 'error', step: i + 1, currentLabel: label, message, finishedAt: Date.now() });
            return;
          } else {
            emit({ status: 'running', step: i + 1, currentLabel: label, message: `step failed (continuing): ${message}` });
          }
        }
      }
      emit({ status: 'done', step: total, currentLabel: 'done', finishedAt: Date.now() });
    } finally {
      this._active.delete(op.name);
    }
  }

  private _stepUploadKey(step: CombinedStep): string | undefined {
    if (step.type === 'upload') return step.uploadKey;
    return undefined;
  }

  private async _runStep(
    step: CombinedStep,
    signal: AbortSignal,
    progress: (msg: string) => void,
  ): Promise<void> {
    switch (step.type) {
      case 'command':
        return this._runCommandStep(step.name, step.wait !== false, signal);
      case 'upload':
        return this._deps.runUploadByKey(step.uploadKey);
      case 'auto-upload': {
        const plan = await this._deps.resolveAutoUploadForServer(step.server);
        if (!plan.length) {
          progress('nothing modified for this server — skipped');
          return;
        }
        for (const item of plan) {
          if (signal.aborted) throw new Error('cancelled');
          await this._deps.runUploadByKey(item.uploadKey, item.staleFiles);
        }
        return;
      }
      case 'wait':
        return abortableSleep((step.seconds || 0) * 1000, signal, progress);
      case 'open': {
        if (step.kind === 'app') {
          if (!openAppNative(step.target)) {
            throw new Error('no `open` utility found for "app" target on this OS');
          }
          return;
        }
        try {
          await vscode.env.openExternal(vscode.Uri.parse(step.target));
        } catch (e) {
          throw new Error(`openExternal failed: ${e instanceof Error ? e.message : e}`);
        }
        return;
      }
      case 'sound':
        if (!playSoundNative(step.clip || 'complete')) {
          throw new Error('no sound utility found on this OS');
        }
        return;
      case 'notification': {
        const msg = step.message;
        const show =
          step.level === 'error' ? vscode.window.showErrorMessage
          : step.level === 'warn' ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;
        void show(msg);
        return;
      }
      case 'vscode-cmd': {
        try {
          await vscode.commands.executeCommand(step.commandId, ...(step.args || []));
        } catch (e) {
          throw new Error(`VS Code command "${step.commandId}" failed: ${e instanceof Error ? e.message : e}`);
        }
        return;
      }
    }
  }

  private async _runCommandStep(name: string, wait: boolean, signal: AbortSignal): Promise<void> {
    const def = await this._deps.getCommandByName(name);
    if (!def) throw new Error(`command "${name}" not found`);

    if (!wait) {
      TerminalManager.getInstance().runCommand(def);
      return;
    }

    const { exitCode, tracked } = await TerminalManager.getInstance().runCommandTracked(def, signal);
    if (signal.aborted) throw new Error('cancelled');
    if (!tracked) {
      // Shell Integration unavailable — we already fired the command via
      // sendText; treat it as success and let the next step start.
      return;
    }
    if (exitCode !== undefined && exitCode !== 0) {
      throw new Error(`command "${name}" exited with code ${exitCode}`);
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal, onTick?: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    let remaining = ms;
    const interval = 1000;
    const tick = () => {
      if (signal.aborted) {
        clearInterval(timer);
        return reject(new Error('cancelled'));
      }
      remaining -= interval;
      if (remaining <= 0) {
        clearInterval(timer);
        return resolve();
      }
      if (onTick) onTick(`${Math.ceil(remaining / 1000)}s remaining`);
    };
    const timer = setInterval(tick, interval);
    const onAbort = () => { clearInterval(timer); reject(new Error('cancelled')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait up to `timeoutMs` for `terminal.shellIntegration` to populate. Returns
 * the SI object if it became available, otherwise undefined.
 */
async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (terminal.shellIntegration) return terminal.shellIntegration;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

/**
 * Spawn a detached shell command and resolve when it exits. Used internally
 * for misc shell-based steps (we mostly avoid this in favor of native APIs).
 * Currently unused — kept for future steps that genuinely need a child process.
 */
export function _spawnAwait(cmd: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: 'ignore' });
    const onAbort = () => { try { child.kill(); } catch { /* ignore */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolve(code ?? 0);
    });
  });
}
