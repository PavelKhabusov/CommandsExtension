/**
 * Combined Operation = ordered sequence of steps that mix:
 *   - regular terminal commands (from commands-list.json / package.json scripts)
 *   - server uploads (full or auto / set-cover)
 *   - native helpers (wait, open, sound, notification)
 *
 * Stored in commands-list.json under the top-level `combined` field.
 */

type CombinedStepBase =
  | CommandStep
  | UploadStep
  | AutoUploadStep
  | WaitStep
  | OpenStep
  | SoundStep
  | NotificationStep
  | VscodeCmdStep;

/** All steps share an optional `enabled` flag (default true) so the user can
 *  quickly skip/include individual steps without removing them from the op. */
export type CombinedStep = CombinedStepBase & { enabled?: boolean };

export interface CommandStep {
  type: 'command';
  /** Name of an existing command in commands-list.json / package.json / *.ps1. */
  name: string;
  /** When true (default), block until shell-integration reports completion. */
  wait?: boolean;
}

export interface UploadStep {
  type: 'upload';
  /** "<groupName>:<uploadName>" — same key format as elsewhere. */
  uploadKey: string;
}

export interface AutoUploadStep {
  type: 'auto-upload';
  /** "user@host" — matches the `display` field of UploadRecommendation. */
  server: string;
}

export interface WaitStep {
  type: 'wait';
  seconds: number;
}

export interface OpenStep {
  type: 'open';
  target: string;
  kind: 'url' | 'file' | 'app';
}

export interface SoundStep {
  type: 'sound';
  clip?: 'complete' | 'alert' | 'error';
}

export interface NotificationStep {
  type: 'notification';
  message: string;
  level?: 'info' | 'warn' | 'error';
}

export interface VscodeCmdStep {
  type: 'vscode-cmd';
  commandId: string;
  /** Human-readable label (defaults to commandId). */
  title?: string;
  /** Optional positional args forwarded to executeCommand. */
  args?: unknown[];
}

export interface CombinedOpDefinition {
  name: string;
  steps: CombinedStep[];
  stopOnError?: boolean;
}

export type CombinedOpStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface CombinedOpProgress {
  opName: string;
  status: CombinedOpStatus;
  /** 1-based current step index, or 0 when not started yet. */
  step: number;
  total: number;
  currentLabel: string;
  /** When the current step is an upload, this echoes the underlying uploadKey
   *  so the webview can attach the standard upload progress bar inline. */
  currentUploadKey?: string;
  message?: string;
  finishedAt?: number;
}

export function isUploadStep(s: CombinedStep): s is UploadStep {
  return s.type === 'upload';
}

export function isAutoUploadStep(s: CombinedStep): s is AutoUploadStep {
  return s.type === 'auto-upload';
}

export function stepLabel(s: CombinedStep): string {
  switch (s.type) {
    case 'command': return s.name;
    case 'upload': return s.uploadKey.split(':').slice(1).join(':') || s.uploadKey;
    case 'auto-upload': return `Auto → ${s.server}`;
    case 'wait': return `Wait ${s.seconds}s`;
    case 'open': return `Open ${s.kind}: ${s.target}`;
    case 'sound': return `Sound: ${s.clip || 'complete'}`;
    case 'notification': return `Notify: ${s.message}`;
    case 'vscode-cmd': return s.title || s.commandId;
  }
}

export function stepIcon(s: CombinedStep): string {
  switch (s.type) {
    case 'command': return '▶';
    case 'upload': return '⬆';
    case 'auto-upload': return '⚡';
    case 'wait': return '⏱';
    case 'open': return '↗';
    case 'sound': return '🔊';
    case 'notification': return '🔔';
    case 'vscode-cmd': return '⚙';
  }
}
