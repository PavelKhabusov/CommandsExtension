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

type StalenessListener = (key: string, staleness: 'clean' | 'stale') => void;

class UploadStalenessBus {
  private readonly _listeners = new Set<StalenessListener>();
  emit(key: string, staleness: 'clean' | 'stale'): void {
    for (const l of this._listeners) l(key, staleness);
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
  private readonly _stalenessState = new Map<string, boolean>();
  private readonly _reverseIndex = new Map<string, Set<string>>();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _bus: UploadStalenessBus
  ) {
    this._restore();
  }

  private _restore(): void {
    type Stored = Record<string, { snapshot: Record<string, number>; stale: boolean }>;
    const saved = this._context.workspaceState.get<Stored>('commandsExtension.uploadStaleness', {});
    for (const [key, data] of Object.entries(saved)) {
      const map = new Map<string, number>(Object.entries(data.snapshot));
      this._snapshots.set(key, map);
      this._stalenessState.set(key, data.stale);
      for (const p of map.keys()) {
        const s = this._reverseIndex.get(p) ?? new Set();
        s.add(key);
        this._reverseIndex.set(p, s);
      }
    }
  }

  public onUploadDone(key: string, filePaths: string[]): void {
    const old = this._snapshots.get(key);
    if (old) {
      for (const p of old.keys()) {
        const s = this._reverseIndex.get(p);
        if (s) { s.delete(key); if (!s.size) this._reverseIndex.delete(p); }
      }
    }
    const snap = new Map<string, number>();
    for (const p of filePaths) {
      try { snap.set(p, fs.statSync(p).mtimeMs); } catch { /* skip */ }
    }
    this._snapshots.set(key, snap);
    this._stalenessState.set(key, false);
    for (const p of snap.keys()) {
      const s = this._reverseIndex.get(p) ?? new Set();
      s.add(key);
      this._reverseIndex.set(p, s);
    }

    // If another stale upload's files are all covered by this upload, mark it clean too
    const uploadedSet = new Set(filePaths);
    for (const [otherKey, otherSnap] of this._snapshots) {
      if (otherKey === key) continue;
      if (!this._stalenessState.get(otherKey)) continue;
      let allCovered = true;
      for (const p of otherSnap.keys()) {
        if (!uploadedSet.has(p)) { allCovered = false; break; }
      }
      if (allCovered) {
        for (const p of otherSnap.keys()) {
          const mtime = snap.get(p);
          if (mtime !== undefined) otherSnap.set(p, mtime);
        }
        this._stalenessState.set(otherKey, false);
        this._bus.emit(otherKey, 'clean');
      }
    }

    this._persist();
    this._bus.emit(key, 'clean');
  }

  public onFileChanged(filePath: string): void {
    const keys = this._reverseIndex.get(filePath);
    if (!keys?.size) return;
    let currentMtime: number;
    try { currentMtime = fs.statSync(filePath).mtimeMs; } catch { return; }
    for (const key of keys) {
      const snap = this._snapshots.get(key);
      if (!snap) continue;
      const snapMtime = snap.get(filePath);
      if (snapMtime !== undefined && currentMtime > snapMtime && !this._stalenessState.get(key)) {
        this._stalenessState.set(key, true);
        this._persist();
        this._bus.emit(key, 'stale');
      }
    }
  }

  public getStalenessMap(): Record<string, 'clean' | 'stale'> {
    const result: Record<string, 'clean' | 'stale'> = {};
    for (const [key] of this._snapshots) {
      result[key] = this._stalenessState.get(key) ? 'stale' : 'clean';
    }
    return result;
  }

  private _persist(): void {
    type Stored = Record<string, { snapshot: Record<string, number>; stale: boolean }>;
    const saved: Stored = {};
    for (const [key, snap] of this._snapshots) {
      saved[key] = { snapshot: Object.fromEntries(snap), stale: this._stalenessState.get(key) || false };
    }
    this._context.workspaceState.update('commandsExtension.uploadStaleness', saved);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  uploadStalenessTracker = new UploadStalenessTracker(context, uploadStalenessBus);
  uploadRunner = new UploadRunner(
    (p) => uploadProgressBus.emit(p),
    (key, filePaths) => uploadStalenessTracker!.onUploadDone(key, filePaths)
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
