import * as fs from 'fs';
import * as vscode from 'vscode';
import { CommandsPanel } from './webviewPanel';
import { CommandsSidebarProvider } from './sidebarProvider';
import { TerminalManager } from './terminalManager';
import { UploadRunner } from './uploadRunner';
import { UploadProgress } from './uploadsTypes';

type ProgressListener = (p: UploadProgress) => void;

class UploadProgressBus {
  private readonly _listeners = new Set<ProgressListener>();
  emit(p: UploadProgress): void {
    for (const l of this._listeners) l(p);
  }
  subscribe(l: ProgressListener): vscode.Disposable {
    this._listeners.add(l);
    return new vscode.Disposable(() => this._listeners.delete(l));
  }
}

export const uploadProgressBus = new UploadProgressBus();
export let uploadRunner: UploadRunner | undefined;

// ── Staleness tracking ────────────────────────────────────────────

export interface StalenessInfo {
  staleness: 'clean' | 'stale';
  staleCount: number;
  staleFiles: string[];
  trackedCount: number;
}

type StalenessListener = (key: string, info: StalenessInfo) => void;

class UploadStalenessBus {
  private readonly _listeners = new Set<StalenessListener>();
  emit(key: string, info: StalenessInfo): void {
    for (const l of this._listeners) l(key, info);
  }
  subscribe(l: StalenessListener): vscode.Disposable {
    this._listeners.add(l);
    return new vscode.Disposable(() => this._listeners.delete(l));
  }
}

export const uploadStalenessBus = new UploadStalenessBus();
export let uploadStalenessTracker: UploadStalenessTracker | undefined;

class UploadStalenessTracker {
  private readonly _snapshots = new Map<string, Map<string, number>>();
  private readonly _staleFiles = new Map<string, Set<string>>();
  private readonly _reverseIndex = new Map<string, Set<string>>();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _bus: UploadStalenessBus
  ) {
    this._restore();
  }

  private _restore(): void {
    type Stored = Record<string, { snapshot: Record<string, number> }>;
    const saved = this._context.workspaceState.get<Stored>('commandsExtension.uploadStaleness', {});
    for (const [key, data] of Object.entries(saved)) {
      const snap = new Map<string, number>(Object.entries(data.snapshot));
      this._snapshots.set(key, snap);
      const stale = new Set<string>();
      for (const [p, snapMtime] of snap) {
        try { if (fs.statSync(p).mtimeMs > snapMtime) stale.add(p); } catch { /* deleted */ }
      }
      this._staleFiles.set(key, stale);
      for (const p of snap.keys()) {
        const s = this._reverseIndex.get(p) ?? new Set();
        s.add(key);
        this._reverseIndex.set(p, s);
      }
    }
  }

  private _info(key: string): StalenessInfo {
    const stale = this._staleFiles.get(key) ?? new Set();
    const trackedCount = this._snapshots.get(key)?.size ?? 0;
    return { staleness: stale.size > 0 ? 'stale' : 'clean', staleCount: stale.size, staleFiles: Array.from(stale), trackedCount };
  }

  private _emitKeys(keys: Iterable<string>): void {
    for (const key of keys) this._bus.emit(key, this._info(key));
  }

  public onUploadDone(key: string, filePaths: string[], partial = false): void {
    const freshMtimes = new Map<string, number>();
    for (const p of filePaths) {
      try { freshMtimes.set(p, fs.statSync(p).mtimeMs); } catch { /* skip */ }
    }

    const changedKeys = new Set<string>([key]);

    if (!partial) {
      const old = this._snapshots.get(key);
      if (old) {
        for (const p of old.keys()) {
          const s = this._reverseIndex.get(p);
          if (s) { s.delete(key); if (!s.size) this._reverseIndex.delete(p); }
        }
      }
      this._snapshots.set(key, new Map(freshMtimes));
      this._staleFiles.set(key, new Set());
      for (const p of freshMtimes.keys()) {
        const s = this._reverseIndex.get(p) ?? new Set();
        s.add(key);
        this._reverseIndex.set(p, s);
      }
    } else {
      const snap = this._snapshots.get(key);
      if (!snap) { this.onUploadDone(key, filePaths, false); return; }
      const stale = this._staleFiles.get(key) ?? new Set();
      for (const [p, mtime] of freshMtimes) {
        if (snap.has(p)) { snap.set(p, mtime); stale.delete(p); }
      }
      this._staleFiles.set(key, stale);
    }

    // Cross-update: remove uploaded files from other uploads' stale sets
    for (const [otherKey, otherSnap] of this._snapshots) {
      if (otherKey === key) continue;
      const otherStale = this._staleFiles.get(otherKey);
      if (!otherStale?.size) continue;
      for (const [p, mtime] of freshMtimes) {
        if (!otherSnap.has(p)) continue;
        otherSnap.set(p, mtime);
        if (otherStale.delete(p)) changedKeys.add(otherKey);
      }
    }

    this._persist();
    this._emitKeys(changedKeys);
  }

  public onFileChanged(filePath: string): void {
    const keys = this._reverseIndex.get(filePath);
    if (!keys?.size) return;
    let currentMtime: number;
    try { currentMtime = fs.statSync(filePath).mtimeMs; } catch { return; }
    const changedKeys: string[] = [];
    for (const key of keys) {
      const snap = this._snapshots.get(key);
      if (!snap) continue;
      const snapMtime = snap.get(filePath);
      if (snapMtime === undefined || currentMtime <= snapMtime) continue;
      const stale = this._staleFiles.get(key) ?? new Set();
      if (stale.has(filePath)) continue;
      stale.add(filePath);
      this._staleFiles.set(key, stale);
      changedKeys.push(key);
    }
    if (changedKeys.length) this._emitKeys(changedKeys);
  }

  public markSynced(key: string): void {
    const snap = this._snapshots.get(key);
    if (!snap) return;
    for (const p of snap.keys()) {
      try { snap.set(p, fs.statSync(p).mtimeMs); } catch { /* skip */ }
    }
    this._staleFiles.set(key, new Set());

    const changedKeys = new Set<string>([key]);
    for (const [otherKey, otherSnap] of this._snapshots) {
      if (otherKey === key) continue;
      const otherStale = this._staleFiles.get(otherKey);
      if (!otherStale?.size) continue;
      for (const [p, mtime] of snap) {
        if (!otherSnap.has(p)) continue;
        otherSnap.set(p, mtime);
        if (otherStale.delete(p)) changedKeys.add(otherKey);
      }
    }

    this._persist();
    this._emitKeys(changedKeys);
  }

  public getStalenessMap(): Record<string, StalenessInfo> {
    const result: Record<string, StalenessInfo> = {};
    for (const [key] of this._snapshots) result[key] = this._info(key);
    return result;
  }

  private _persist(): void {
    type Stored = Record<string, { snapshot: Record<string, number> }>;
    const saved: Stored = {};
    for (const [key, snap] of this._snapshots) {
      saved[key] = { snapshot: Object.fromEntries(snap) };
    }
    this._context.workspaceState.update('commandsExtension.uploadStaleness', saved);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  uploadStalenessTracker = new UploadStalenessTracker(context, uploadStalenessBus);
  uploadRunner = new UploadRunner(
    (p) => uploadProgressBus.emit(p),
    (key, filePaths, partial) => uploadStalenessTracker!.onUploadDone(key, filePaths, partial)
  );

  const openPanelCommand = vscode.commands.registerCommand(
    'commandsExtension.openPanel',
    () => {
      CommandsPanel.createOrShow(context.extensionUri, context);
    }
  );
  context.subscriptions.push(openPanelCommand);

  const sidebarProvider = new CommandsSidebarProvider(context.extensionUri, context);
  const sidebarRegistration = vscode.window.registerWebviewViewProvider(
    CommandsSidebarProvider.viewType,
    sidebarProvider
  );
  context.subscriptions.push(sidebarRegistration);

  context.subscriptions.push(...TerminalManager.getInstance().getDisposables());

  if (vscode.workspace.workspaceFolders) {
    const config = vscode.workspace.getConfiguration('commandsExtension');
    const configFile = config.get<string>('configFile', 'commands-list.json');
    const uploadsFile = config.get<string>('uploadsFile', 'server-uploads.local.json');

    const commandsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], configFile)
    );
    const packageWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], 'package.json')
    );
    const uploadsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], uploadsFile)
    );
    const ps1Watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '*.ps1')
    );

    const onFileChange = () => {
      CommandsPanel.refresh();
      sidebarProvider.refresh();
    };

    for (const w of [commandsWatcher, packageWatcher, uploadsWatcher, ps1Watcher]) {
      w.onDidChange(onFileChange);
      w.onDidCreate(onFileChange);
      w.onDidDelete(onFileChange);
    }

    const staleWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '**/*')
    );
    staleWatcher.onDidChange((uri) => {
      if (!uri.fsPath.includes('.git')) uploadStalenessTracker!.onFileChanged(uri.fsPath);
    });
    staleWatcher.onDidCreate((uri) => {
      if (!uri.fsPath.includes('.git')) uploadStalenessTracker!.onFileChanged(uri.fsPath);
    });

    context.subscriptions.push(commandsWatcher, packageWatcher, uploadsWatcher, ps1Watcher, staleWatcher);
  }
}

export function deactivate(): void {}
