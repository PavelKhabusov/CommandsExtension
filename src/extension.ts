import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandsPanel } from './webviewPanel';
import { CommandsSidebarProvider } from './sidebarProvider';
import { TerminalManager } from './terminalManager';
import { UploadRunner } from './uploadRunner';
import { UploadProgress, ResolvedUpload } from './uploadsTypes';
import { isPathInUploadScope, resolveItems, loadUploads, resolveServer } from './uploadsProvider';
import { loadCommands, loadCombinedOps } from './commandsProvider';
import { CombinedOpDefinition, CombinedOpProgress } from './combinedOpsTypes';
import { CombinedOpRunner } from './combinedOpRunner';

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

type CombinedProgressListener = (p: CombinedOpProgress) => void;

class CombinedOpProgressBus {
  private readonly _listeners = new Set<CombinedProgressListener>();
  emit(p: CombinedOpProgress): void { for (const l of this._listeners) l(p); }
  subscribe(l: CombinedProgressListener): vscode.Disposable {
    this._listeners.add(l);
    return new vscode.Disposable(() => this._listeners.delete(l));
  }
}

export const combinedOpProgressBus = new CombinedOpProgressBus();
export let combinedOpRunner: CombinedOpRunner | undefined;

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

interface UploadScope {
  workspaceRoot: string;
  items: string[];
  exclude: string[];
}

class UploadStalenessTracker {
  private readonly _snapshots = new Map<string, Map<string, number>>();
  private readonly _staleFiles = new Map<string, Set<string>>();
  private readonly _newFiles = new Map<string, Set<string>>();
  private readonly _scopes = new Map<string, UploadScope>();
  private readonly _reverseIndex = new Map<string, Set<string>>();

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _bus: UploadStalenessBus
  ) {
    this._restore();
  }

  private _restore(): void {
    type Stored = Record<string, {
      snapshot: Record<string, number>;
      scope?: UploadScope;
      newFiles?: string[];
    }>;
    const saved = this._context.workspaceState.get<Stored>('commandsExtension.uploadStaleness', {});
    for (const [key, data] of Object.entries(saved)) {
      const snap = new Map<string, number>(Object.entries(data.snapshot));
      this._snapshots.set(key, snap);
      const stale = new Set<string>();
      for (const [p, snapMtime] of snap) {
        try { if (fs.statSync(p).mtimeMs > snapMtime) stale.add(p); } catch { /* deleted */ }
      }
      this._staleFiles.set(key, stale);
      if (data.scope) this._scopes.set(key, data.scope);
      const newFiles = new Set<string>();
      if (Array.isArray(data.newFiles)) {
        for (const p of data.newFiles) {
          try { if (fs.statSync(p).isFile()) newFiles.add(p); } catch { /* deleted */ }
        }
      }
      this._newFiles.set(key, newFiles);
      for (const p of snap.keys()) {
        const s = this._reverseIndex.get(p) ?? new Set();
        s.add(key);
        this._reverseIndex.set(p, s);
      }
    }
  }

  private _info(key: string): StalenessInfo {
    const stale = this._staleFiles.get(key) ?? new Set();
    const newFiles = this._newFiles.get(key) ?? new Set();
    const trackedCount = this._snapshots.get(key)?.size ?? 0;
    const allChanged = new Set<string>();
    for (const f of stale) allChanged.add(f);
    for (const f of newFiles) allChanged.add(f);
    return {
      staleness: allChanged.size > 0 ? 'stale' : 'clean',
      staleCount: allChanged.size,
      staleFiles: Array.from(allChanged),
      trackedCount,
    };
  }

  private _emitKeys(keys: Iterable<string>): void {
    for (const key of keys) this._bus.emit(key, this._info(key));
  }

  private _addToSnapshot(key: string, p: string, mtime: number): void {
    const snap = this._snapshots.get(key);
    if (!snap) return;
    snap.set(p, mtime);
    const s = this._reverseIndex.get(p) ?? new Set();
    s.add(key);
    this._reverseIndex.set(p, s);
  }

  public onUploadDone(key: string, filePaths: string[], partial = false, scope?: UploadScope): void {
    const freshMtimes = new Map<string, number>();
    for (const p of filePaths) {
      try { freshMtimes.set(p, fs.statSync(p).mtimeMs); } catch { /* skip */ }
    }

    const changedKeys = new Set<string>([key]);

    if (scope) this._scopes.set(key, scope);

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
      this._newFiles.set(key, new Set());
      for (const p of freshMtimes.keys()) {
        const s = this._reverseIndex.get(p) ?? new Set();
        s.add(key);
        this._reverseIndex.set(p, s);
      }
    } else {
      if (!this._snapshots.has(key)) { this.onUploadDone(key, filePaths, false, scope); return; }
      const snap = this._snapshots.get(key)!;
      const stale = this._staleFiles.get(key) ?? new Set();
      const newFiles = this._newFiles.get(key) ?? new Set();
      for (const [p, mtime] of freshMtimes) {
        if (!snap.has(p)) {
          this._addToSnapshot(key, p, mtime);
        } else {
          snap.set(p, mtime);
        }
        stale.delete(p);
        newFiles.delete(p);
      }
      this._staleFiles.set(key, stale);
      this._newFiles.set(key, newFiles);
    }

    // Cross-update: uploaded files clear stale/newFiles in other uploads
    for (const [otherKey, otherSnap] of this._snapshots) {
      if (otherKey === key) continue;
      const otherStale = this._staleFiles.get(otherKey) ?? new Set();
      const otherNew = this._newFiles.get(otherKey) ?? new Set();
      const otherScope = this._scopes.get(otherKey);
      for (const [p, mtime] of freshMtimes) {
        if (otherSnap.has(p)) {
          otherSnap.set(p, mtime);
          if (otherStale.delete(p)) changedKeys.add(otherKey);
        } else if (otherNew.has(p)) {
          this._addToSnapshot(otherKey, p, mtime);
          otherNew.delete(p);
          changedKeys.add(otherKey);
        } else if (otherScope && isPathInUploadScope(p, otherScope.workspaceRoot, otherScope.items, otherScope.exclude)) {
          this._addToSnapshot(otherKey, p, mtime);
          changedKeys.add(otherKey);
        }
      }
      this._staleFiles.set(otherKey, otherStale);
      this._newFiles.set(otherKey, otherNew);
    }

    this._persist();
    this._emitKeys(changedKeys);
  }

  public onFileChanged(filePath: string): void {
    let currentMtime: number;
    let exists = false;
    try { const st = fs.statSync(filePath); currentMtime = st.mtimeMs; exists = st.isFile(); } catch { return; }
    if (!exists) return;

    const changedKeys = new Set<string>();

    // 1. Tracked files: check mtime vs snapshot
    const keys = this._reverseIndex.get(filePath);
    if (keys?.size) {
      for (const key of keys) {
        const snap = this._snapshots.get(key);
        if (!snap) continue;
        const snapMtime = snap.get(filePath);
        if (snapMtime === undefined || currentMtime <= snapMtime) continue;
        const stale = this._staleFiles.get(key) ?? new Set();
        if (stale.has(filePath)) continue;
        stale.add(filePath);
        this._staleFiles.set(key, stale);
        changedKeys.add(key);
      }
    }

    // 2. New-in-scope files: check uploads whose scope covers this file but snapshot doesn't have it
    for (const [key, scope] of this._scopes) {
      const snap = this._snapshots.get(key);
      if (snap?.has(filePath)) continue; // already tracked above
      const newFiles = this._newFiles.get(key) ?? new Set();
      if (newFiles.has(filePath)) continue;
      if (!isPathInUploadScope(filePath, scope.workspaceRoot, scope.items, scope.exclude)) continue;
      newFiles.add(filePath);
      this._newFiles.set(key, newFiles);
      changedKeys.add(key);
    }

    if (changedKeys.size) {
      this._persist();
      this._emitKeys(changedKeys);
    }
  }

  public onFileDeleted(filePath: string): void {
    const changedKeys = new Set<string>();
    for (const [key, newFiles] of this._newFiles) {
      if (newFiles.delete(filePath)) changedKeys.add(key);
    }
    if (changedKeys.size) {
      this._persist();
      this._emitKeys(changedKeys);
    }
  }

  public markSynced(key: string): void {
    let snap = this._snapshots.get(key);
    if (!snap) {
      snap = new Map<string, number>();
      this._snapshots.set(key, snap);
    }
    for (const p of snap.keys()) {
      try { snap.set(p, fs.statSync(p).mtimeMs); } catch { /* skip */ }
    }
    // Also pull in any newFiles as tracked now
    const newFiles = this._newFiles.get(key) ?? new Set();
    for (const p of newFiles) {
      try { this._addToSnapshot(key, p, fs.statSync(p).mtimeMs); } catch { /* skip */ }
    }
    this._staleFiles.set(key, new Set());
    this._newFiles.set(key, new Set());

    const changedKeys = new Set<string>([key]);
    // Propagate: any file now tracked by this key should also clear from others
    for (const [otherKey, otherSnap] of this._snapshots) {
      if (otherKey === key) continue;
      const otherStale = this._staleFiles.get(otherKey) ?? new Set();
      const otherNew = this._newFiles.get(otherKey) ?? new Set();
      for (const [p, mtime] of snap) {
        if (otherSnap.has(p)) {
          otherSnap.set(p, mtime);
          if (otherStale.delete(p)) changedKeys.add(otherKey);
        } else if (otherNew.has(p)) {
          this._addToSnapshot(otherKey, p, mtime);
          otherNew.delete(p);
          changedKeys.add(otherKey);
        }
      }
      this._staleFiles.set(otherKey, otherStale);
      this._newFiles.set(otherKey, otherNew);
    }

    this._persist();
    this._emitKeys(changedKeys);
  }

  public async refreshScopesFromConfig(workspaceRoot: string, configFileName: string): Promise<void> {
    const { groups } = await loadUploads(workspaceRoot, configFileName);
    const seenKeys = new Set<string>();
    for (const g of groups) {
      for (const u of g.uploads) {
        const key = `${u.group || 'Uploads'}:${u.name}`;
        seenKeys.add(key);
        this._scopes.set(key, {
          workspaceRoot,
          items: u.items || [],
          exclude: u.exclude || [],
        });
      }
    }
    // Remove orphan entries (uploads removed/renamed in config)
    const allKeys = new Set<string>([
      ...this._scopes.keys(),
      ...this._snapshots.keys(),
      ...this._newFiles.keys(),
      ...this._staleFiles.keys(),
    ]);
    for (const key of allKeys) {
      if (seenKeys.has(key)) continue;
      this._scopes.delete(key);
      this._snapshots.delete(key);
      this._newFiles.delete(key);
      this._staleFiles.delete(key);
      for (const [p, keys] of Array.from(this._reverseIndex)) {
        keys.delete(key);
        if (!keys.size) this._reverseIndex.delete(p);
      }
    }
    this._persist();
    await this.rescanAllScopes();
  }

  public async rescanAllScopes(): Promise<void> {
    const changedKeys = new Set<string>();
    for (const [key, scope] of this._scopes) {
      try {
        const items = await resolveItems(scope.workspaceRoot, scope.items, scope.exclude);
        const snap = this._snapshots.get(key) ?? new Map<string, number>();
        const newFiles = this._newFiles.get(key) ?? new Set<string>();
        const before = newFiles.size;
        for (const item of items) {
          if (snap.has(item.absolutePath)) continue;
          if (newFiles.has(item.absolutePath)) continue;
          newFiles.add(item.absolutePath);
        }
        if (newFiles.size !== before) {
          this._newFiles.set(key, newFiles);
          changedKeys.add(key);
        }
      } catch { /* skip */ }
    }
    if (changedKeys.size) {
      this._persist();
      this._emitKeys(changedKeys);
    }
  }

  public getStalenessMap(): Record<string, StalenessInfo> {
    const result: Record<string, StalenessInfo> = {};
    const allKeys = new Set<string>();
    for (const k of this._snapshots.keys()) allKeys.add(k);
    for (const k of this._newFiles.keys()) allKeys.add(k);
    for (const k of this._scopes.keys()) allKeys.add(k);
    for (const key of allKeys) result[key] = this._info(key);
    return result;
  }

  private _persist(): void {
    type Stored = Record<string, {
      snapshot: Record<string, number>;
      scope?: UploadScope;
      newFiles?: string[];
    }>;
    const saved: Stored = {};
    for (const [key, snap] of this._snapshots) {
      saved[key] = {
        snapshot: Object.fromEntries(snap),
        scope: this._scopes.get(key),
        newFiles: Array.from(this._newFiles.get(key) ?? []),
      };
    }
    this._context.workspaceState.update('commandsExtension.uploadStaleness', saved);
  }
}

// ── External API hook ─────────────────────────────────────────────
// When the user sets `commandsExtension.externalApiUrl`, the extension fires
// lightweight POSTs so other local tools (dashboards, automations, etc.) can
// react to upload progress and pick up the current command list. Nothing is
// sent unless the URL is explicitly configured.

function externalApiBase(): string {
  const cfg = vscode.workspace.getConfiguration('commandsExtension');
  return (cfg.get<string>('externalApiUrl') ?? '').replace(/\/+$/, '');
}

function externalApiPost(path: string, payload: unknown): void {
  const base = externalApiBase();
  if (!base) return;
  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    return;
  }
  const body = JSON.stringify(payload);
  const req = http.request({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  });
  req.on('error', () => { /* endpoint may be down — ignore */ });
  req.write(body);
  req.end();
}

function installExternalApiSubscriber(context: vscode.ExtensionContext): vscode.Disposable {
  // Subscribe to /panel/events on the external hub so it can trigger our
  // commands natively inside VS Code (instead of spawning detached).
  let stopped = false;
  let abort: AbortController | null = null;

  async function loop(): Promise<void> {
    while (!stopped) {
      const base = externalApiBase();
      if (!base) {
        await sleep(2000);
        continue;
      }
      try {
        abort = new AbortController();
        const r = await fetch(`${base}/commands/events`, {
          headers: { accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!r.ok || !r.body) {
          await sleep(2000);
          continue;
        }
        // We just connected (or reconnected after a hub restart) — its in-
        // memory commands cache is empty, so push the current snapshot now.
        // Otherwise the desktop/mini-app sees an empty list (no favorites,
        // no recommendations) until an unrelated trigger fires.
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (wsRoot) {
          const cf = vscode.workspace
            .getConfiguration('commandsExtension')
            .get<string>('configFile', 'commands-list.json');
          void publishCommandsToExternalApi(wsRoot, cf);
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const m = frame.match(/^data:\s*(.*)$/m);
            if (!m) continue;
            try {
              const ev = JSON.parse(m[1]) as {
                type?: string;
                workspacePath?: string;
                name?: string;
                stale?: boolean;
              };
              if (ev.type === 'run-command' && ev.workspacePath && ev.name) {
                handleRunCommand(ev.workspacePath, ev.name, ev.stale === true);
              }
            } catch {
              /* ignore non-json frame */
            }
          }
        }
      } catch {
        if (stopped) return;
      }
      await sleep(1500);
    }
  }

  void loop();

  return new vscode.Disposable(() => {
    stopped = true;
    abort?.abort();
  });
}

async function handleRunCommand(
  workspacePath: string,
  name: string,
  stale = false,
): Promise<void> {
  // Only react when this VS Code window IS the one for that workspace.
  const myRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!myRoot || myRoot !== workspacePath) return;

  const cfg = vscode.workspace.getConfiguration('commandsExtension');
  const configFile = cfg.get<string>('configFile', 'commands-list.json');

  // Combined operations take priority — they may share a name with a regular
  // command but the user clicked the combined card specifically.
  try {
    const ops = await loadCombinedOps(myRoot, configFile);
    const op = ops.find((o) => o.name === name);
    if (op && combinedOpRunner) {
      void combinedOpRunner.run(op);
      return;
    }
  } catch {
    /* fall through to commands / uploads */
  }

  const { loadCommands } = await import('./commandsProvider');
  const groups = await loadCommands(myRoot, configFile);
  for (const g of groups) {
    for (const c of g.commands) {
      if (c.name === name) {
        TerminalManager.getInstance().runCommand(c);
        return;
      }
    }
  }

  // Also check uploads — trigger them through the runner. When `stale` is set,
  // pass a fileFilter of the currently-tracked modified files so the runner
  // only ships changes since the last clean upload.
  try {
    const uploadsFile = cfg.get<string>('uploadsFile', 'server-uploads.local.json');
    const { loadUploads, resolveServer } = await import('./uploadsProvider');
    const ud = await loadUploads(myRoot, uploadsFile);
    for (const g of ud.groups) {
      for (const u of g.uploads) {
        if (u.name === name) {
          if (!uploadRunner) return;
          const resolved = resolveServer(u, ud.servers);
          if (!resolved) return;
          let fileFilter: Set<string> | undefined;
          if (stale) {
            const key = `${g.name || 'Uploads'}:${u.name}`;
            const info = uploadStalenessTracker?.getStalenessMap()[key];
            if (info && info.staleness === 'stale' && info.staleFiles.length > 0) {
              fileFilter = new Set(info.staleFiles);
            } else {
              // Nothing modified — bail out silently instead of running a
              // full upload, otherwise "Modified" silently behaves like "All".
              return;
            }
          }
          await uploadRunner.run(myRoot, resolved, fileFilter);
          return;
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function installExternalApiForwarder(): vscode.Disposable {
  return uploadProgressBus.subscribe((p) => externalApiPost('/events/upload-progress', p));
}

let extensionContext: vscode.ExtensionContext | null = null;

interface UploadRecommendation {
  display: string;
  uploadKeys: string[];
  staleCount: number;
  staleFiles: string[];
}

/**
 * Set-cover over per-server upload candidates. Mirrors computeAutoUploadCmds()
 * in media/main.js so the hub sees the same recommendations the local panel
 * shows in its "auto upload" cards.
 */
function computeUploadRecommendations(
  uploadsData: { groups: { name: string; uploads: { name: string; protocol?: string; user?: string; host?: string; port?: number }[] }[] },
  stalenessMap: Record<string, StalenessInfo>,
): UploadRecommendation[] {
  const serverMap = new Map<string, {
    display: string;
    candidates: { key: string; staleFiles: Set<string>; trackedCount: number }[];
  }>();
  for (const g of uploadsData.groups) {
    for (const u of g.uploads) {
      const key = `${g.name || 'Uploads'}:${u.name}`;
      const info = stalenessMap[key];
      if (!info || info.staleness !== 'stale' || !info.staleCount) continue;
      const serverKey = `${u.protocol ?? ''}://${u.user ?? ''}@${u.host ?? ''}:${u.port ?? ''}`;
      let entry = serverMap.get(serverKey);
      if (!entry) {
        entry = { display: `${u.user ?? ''}@${u.host ?? ''}`, candidates: [] };
        serverMap.set(serverKey, entry);
      }
      entry.candidates.push({
        key,
        staleFiles: new Set(info.staleFiles ?? []),
        trackedCount: info.trackedCount ?? 0,
      });
    }
  }

  const result: UploadRecommendation[] = [];
  for (const entry of serverMap.values()) {
    const sorted = entry.candidates.slice().sort(
      (a, b) => (b.staleFiles.size - a.staleFiles.size) || (a.trackedCount - b.trackedCount),
    );
    const remaining = new Set<string>();
    for (const c of entry.candidates) for (const f of c.staleFiles) remaining.add(f);
    const chosen: typeof sorted = [];
    for (const c of sorted) {
      if (!remaining.size) break;
      let covers = false;
      for (const f of c.staleFiles) { if (remaining.has(f)) { covers = true; break; } }
      if (!covers) continue;
      chosen.push(c);
      for (const f of c.staleFiles) remaining.delete(f);
    }
    if (!chosen.length) continue;
    const combined = new Set<string>();
    for (const c of chosen) for (const f of c.staleFiles) combined.add(f);
    result.push({
      display: entry.display,
      uploadKeys: chosen.map((c) => c.key),
      staleCount: combined.size,
      staleFiles: Array.from(combined),
    });
  }
  return result;
}

async function publishCommandsToExternalApi(
  workspaceRoot: string,
  configFile: string,
): Promise<void> {
  if (!externalApiBase()) return;
  try {
    const { loadCommands } = await import('./commandsProvider');
    const groups = await loadCommands(workspaceRoot, configFile);
    const favorites = new Set<string>(
      extensionContext?.workspaceState.get<string[]>('commandsExtension.favorites', []) ?? [],
    );
    const running = new Set(TerminalManager.getInstance().getActiveCommandNames());
    const commands: Array<Record<string, unknown>> = groups.flatMap((g) =>
      g.commands.map((c) => ({
        name: c.name,
        command: c.command,
        type: c.type,
        group: g.name,
        cwd: c.cwd,
        detail: c.detail,
        favorite: favorites.has(`${g.name}:${c.name}`),
        running: running.has(c.name),
      })),
    );

    // Also publish server-uploads as commands of type="upload".
    let uploadRecommendations: UploadRecommendation[] = [];
    try {
      const cfg = vscode.workspace.getConfiguration('commandsExtension');
      const uploadsFile = cfg.get<string>('uploadsFile', 'server-uploads.local.json');
      const { loadUploads } = await import('./uploadsProvider');
      const uploadsData = await loadUploads(workspaceRoot, uploadsFile);
      const stalenessMap = uploadStalenessTracker?.getStalenessMap() ?? {};
      for (const g of uploadsData.groups) {
        for (const u of g.uploads) {
          const groupName = g.name || 'Uploads';
          const key = `${groupName}:${u.name}`;
          const info = stalenessMap[key];
          commands.push({
            name: u.name,
            command: `[upload] ${u.name}`,
            type: 'upload',
            group: groupName,
            cwd: undefined,
            detail: `${u.server ?? u.host ?? 'server'} → ${u.remoteDir ?? ''}`,
            favorite: favorites.has(`${groupName}:${u.name}`),
            running: false,
            uploadKey: key,
            staleness: info
              ? {
                  staleness: info.staleness,
                  staleCount: info.staleCount,
                  staleFiles: info.staleFiles,
                  trackedCount: info.trackedCount,
                }
              : undefined,
          });
        }
      }
      uploadRecommendations = computeUploadRecommendations(uploadsData, stalenessMap);
    } catch {
      /* no uploads file or parse error — skip */
    }

    // Combined operations from commands-list.json — read-only on the hub side.
    let combined: Array<Record<string, unknown>> = [];
    try {
      const ops = await loadCombinedOps(workspaceRoot, configFile);
      const lastStatuses = combinedOpRunner?.getLastStatuses() ?? [];
      const statusByName = new Map(lastStatuses.map((s) => [s.opName, s]));
      combined = ops.map((op) => ({
        name: op.name,
        steps: op.steps,
        stopOnError: op.stopOnError !== false,
        running: combinedOpRunner?.isRunning(op.name) ?? false,
        progress: statusByName.get(op.name) ?? null,
      }));
    } catch {
      /* missing or invalid combined field — skip */
    }

    externalApiPost('/events/commands', {
      workspacePath: workspaceRoot,
      commands,
      uploadRecommendations,
      combined,
    });
  } catch {
    /* ignore — endpoint may be offline or extension may not be ready */
  }
}

/**
 * Toggle the `commandsExtension.hasServerUploads` context key so the
 * "Upload to Server" right-click command only appears in projects that
 * actually define server uploads.
 */
async function refreshServerUploadsContext(workspaceRoot: string, uploadsFile: string): Promise<void> {
  let hasUploads = false;
  try {
    const { groups } = await loadUploads(workspaceRoot, uploadsFile);
    hasUploads = groups.some((g) => g.uploads.length > 0);
  } catch {
    hasUploads = false;
  }
  await vscode.commands.executeCommand('setContext', 'commandsExtension.hasServerUploads', hasUploads);
}

/**
 * Right-click handler: upload one or more tracked files to a server. VS Code
 * calls explorer/context handlers as `(uri, uris)` where `uris` is the full
 * multi-selection; editor/context only passes a single uri. Files are sent
 * to the exact remote locations they map to; when several uploads cover the
 * selection, the user picks a single target that covers all of them.
 */
async function uploadFilesToServer(resource?: vscode.Uri, resources?: vscode.Uri[]): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Commands Extension: no workspace folder open.');
    return;
  }

  // Collect candidate URIs: prefer the multi-selection from explorer/context,
  // fall back to the single arg, then to the active editor.
  const candidateUris: vscode.Uri[] = Array.isArray(resources) && resources.length > 0
    ? resources
    : resource
      ? [resource]
      : vscode.window.activeTextEditor
        ? [vscode.window.activeTextEditor.document.uri]
        : [];

  // Keep only file:// regular files (skip dirs — they'd need recursion which
  // the upload definition's own walker already does, so passing the dir would
  // double-up).
  const filePaths: string[] = [];
  for (const u of candidateUris) {
    if (u.scheme !== 'file') continue;
    try {
      if (fs.statSync(u.fsPath).isFile()) filePaths.push(u.fsPath);
    } catch { /* skip missing */ }
  }
  if (filePaths.length === 0) {
    vscode.window.showWarningMessage('Commands Extension: no files selected to upload.');
    return;
  }

  const uploadsFile = vscode.workspace
    .getConfiguration('commandsExtension')
    .get<string>('uploadsFile', 'server-uploads.local.json');
  const { groups, servers } = await loadUploads(workspaceRoot, uploadsFile);

  // For each selected file, list every upload whose scope covers it.
  type Match = { resolved: ResolvedUpload; key: string };
  const fileMatches = new Map<string, Match[]>();
  for (const f of filePaths) {
    const matches: Match[] = [];
    for (const g of groups) {
      for (const u of g.uploads) {
        if (!isPathInUploadScope(f, workspaceRoot, u.items, u.exclude || [])) continue;
        const r = resolveServer(u, servers);
        if (!r) continue;
        matches.push({ resolved: r, key: `${u.group || 'Uploads'}:${u.name}` });
      }
    }
    fileMatches.set(f, matches);
  }
  const tracked = filePaths.filter((f) => fileMatches.get(f)!.length > 0);
  const untrackedCount = filePaths.length - tracked.length;
  if (tracked.length === 0) {
    vscode.window.showWarningMessage(
      `Commands Extension: ${filePaths.length === 1
        ? `"${path.relative(workspaceRoot, filePaths[0]) || path.basename(filePaths[0])}"`
        : 'none of the selected files'
      } not tracked by any server upload.`
    );
    return;
  }
  if (untrackedCount > 0) {
    vscode.window.showInformationMessage(
      `Commands Extension: ${untrackedCount} file(s) not tracked by any upload — skipped.`
    );
  }

  // Intersection of matches across all tracked files — uploads that can cover
  // the whole selection in a single batch.
  const matchSets = tracked.map((f) => new Set(fileMatches.get(f)!.map((m) => m.key)));
  const intersection = new Set(matchSets[0]);
  for (let i = 1; i < matchSets.length; i++) {
    for (const k of Array.from(intersection)) {
      if (!matchSets[i].has(k)) intersection.delete(k);
    }
  }

  if (intersection.size === 0) {
    vscode.window.showWarningMessage(
      `Commands Extension: no single upload covers all ${tracked.length} selected file(s). ` +
      'Group your selection by upload scope and try again.'
    );
    return;
  }

  // Resolve intersection keys back to ResolvedUpload (de-duped).
  const intersectionResolved: ResolvedUpload[] = [];
  const seen = new Set<string>();
  for (const f of tracked) {
    for (const m of fileMatches.get(f)!) {
      if (intersection.has(m.key) && !seen.has(m.key)) {
        seen.add(m.key);
        intersectionResolved.push(m.resolved);
      }
    }
  }

  let chosen = intersectionResolved[0];
  if (intersectionResolved.length > 1) {
    const pick = await vscode.window.showQuickPick(
      intersectionResolved.map((m) => ({
        label: m.name,
        description: `${m.user}@${m.host} → ${m.remoteDir}`,
        resolved: m,
      })),
      {
        title: tracked.length === 1
          ? `Upload "${path.basename(tracked[0])}" to…`
          : `Upload ${tracked.length} file(s) to…`,
        placeHolder: 'Select the destination server',
      }
    );
    if (!pick) return;
    chosen = pick.resolved;
  }

  if (!uploadRunner) return;

  // Wrap in a progress notification so the user sees stages
  // (connecting → uploading → done) and the toast auto-closes when the
  // promise resolves. Without this the right-click flow is silent and
  // looks like nothing happened.
  const chosenForRun = chosen;
  const titleBase = tracked.length === 1
    ? `Commands Extension: Upload ${path.basename(tracked[0])}`
    : `Commands Extension: Upload ${tracked.length} files`;
  const targetLabel = `${chosenForRun.user}@${chosenForRun.host}${chosenForRun.remoteDir ? ' → ' + chosenForRun.remoteDir : ''}`;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${titleBase} → ${targetLabel}`, cancellable: true },
    async (progress, cancelToken) => {
      const key = `${chosenForRun.group}:${chosenForRun.name}`;
      const progressSub = uploadProgressBus.subscribe((p) => {
        if (p.uploadKey !== key) return;
        if (p.status === 'connecting') {
          progress.report({ message: p.message ?? 'Connecting…' });
        } else if (p.status === 'running') {
          const pct = typeof p.percent === 'number' ? `${Math.round(p.percent)}%` : '';
          const done = typeof p.filesDone === 'number' && typeof p.filesTotal === 'number'
            ? ` (${p.filesDone}/${p.filesTotal})` : '';
          const file = p.currentFile ? ` · ${p.currentFile}` : '';
          progress.report({ message: `${pct}${done}${file}`.trim() || 'Uploading…' });
        } else if (p.status === 'done') {
          progress.report({ message: p.message ?? 'Done' });
        } else if (p.status === 'error') {
          progress.report({ message: `✗ ${p.message ?? 'Failed'}` });
        } else if (p.status === 'cancelled') {
          progress.report({ message: 'Cancelled' });
        }
      });
      cancelToken.onCancellationRequested(() => uploadRunner!.cancel(key));
      try {
        await uploadRunner!.run(workspaceRoot, chosenForRun, new Set(tracked));
      } finally {
        progressSub.dispose();
      }
    }
  );
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;

  // Re-publish commands whenever terminals open/close so 'running' badges
  // in the mini-app/panel stay live.
  TerminalManager.getInstance().onDidChange(() => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;
    const configFile = vscode.workspace
      .getConfiguration('commandsExtension')
      .get<string>('configFile', 'commands-list.json');
    void publishCommandsToExternalApi(root, configFile);
  });

  uploadStalenessTracker = new UploadStalenessTracker(context, uploadStalenessBus);
  uploadRunner = new UploadRunner(
    (p) => uploadProgressBus.emit(p),
    (key, filePaths, partial, scope) => uploadStalenessTracker!.onUploadDone(key, filePaths, partial, scope)
  );

  combinedOpRunner = new CombinedOpRunner(
    (p) => combinedOpProgressBus.emit(p),
    {
      getCommandByName: async (name) => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return undefined;
        const cfgFile = vscode.workspace
          .getConfiguration('commandsExtension')
          .get<string>('configFile', 'commands-list.json');
        const groups = await loadCommands(wsRoot, cfgFile);
        for (const g of groups) {
          const c = g.commands.find((cc) => cc.name === name);
          if (c) return c;
        }
        return undefined;
      },
      runUploadByKey: async (key, fileFilter) => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot || !uploadRunner) throw new Error('no workspace or upload runner');
        const sep = key.indexOf(':');
        const groupName = sep === -1 ? 'Uploads' : key.slice(0, sep);
        const uploadName = sep === -1 ? key : key.slice(sep + 1);
        const uploadsFile = vscode.workspace
          .getConfiguration('commandsExtension')
          .get<string>('uploadsFile', 'server-uploads.local.json');
        const ud = await loadUploads(wsRoot, uploadsFile);
        for (const g of ud.groups) {
          if ((g.name || 'Uploads') !== groupName) continue;
          const u = g.uploads.find((uu) => uu.name === uploadName);
          if (!u) continue;
          const resolved = resolveServer(u, ud.servers);
          if (!resolved) throw new Error(`upload "${key}" has unresolved server`);
          await uploadRunner.run(wsRoot, resolved, fileFilter);
          return;
        }
        throw new Error(`upload "${key}" not found`);
      },
      resolveAutoUploadForServer: async (server) => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) return [];
        const uploadsFile = vscode.workspace
          .getConfiguration('commandsExtension')
          .get<string>('uploadsFile', 'server-uploads.local.json');
        const ud = await loadUploads(wsRoot, uploadsFile);
        const stalenessMap = uploadStalenessTracker?.getStalenessMap() ?? {};
        const recommendations = computeUploadRecommendations(ud, stalenessMap);
        const match = recommendations.find((r) => r.display === server);
        if (!match) return [];
        return match.uploadKeys.map((uk) => ({
          uploadKey: uk,
          staleFiles: new Set(stalenessMap[uk]?.staleFiles ?? []),
        }));
      },
    },
  );

  context.subscriptions.push(installExternalApiForwarder());
  context.subscriptions.push(installExternalApiSubscriber(context));

  // Forward combined-op progress to the hub (no-op when externalApiUrl unset).
  context.subscriptions.push(
    combinedOpProgressBus.subscribe((p) => externalApiPost('/events/combined-progress', p)),
  );

  // Re-publish commands (with refreshed per-upload staleness + recommendations)
  // whenever staleness changes. Debounced so rapid file events don't spam.
  let stalePublishTimer: NodeJS.Timeout | undefined;
  const stalenessSub = uploadStalenessBus.subscribe(() => {
    if (stalePublishTimer) clearTimeout(stalePublishTimer);
    stalePublishTimer = setTimeout(() => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const cf = vscode.workspace
        .getConfiguration('commandsExtension')
        .get<string>('configFile', 'commands-list.json');
      void publishCommandsToExternalApi(root, cf);
    }, 200);
  });
  context.subscriptions.push(stalenessSub, new vscode.Disposable(() => {
    if (stalePublishTimer) clearTimeout(stalePublishTimer);
  }));

  const openPanelCommand = vscode.commands.registerCommand(
    'commandsExtension.openPanel',
    () => {
      CommandsPanel.createOrShow(context.extensionUri, context);
    }
  );
  context.subscriptions.push(openPanelCommand);

  // Internal hook used by the webview's toggleFavorite (and any other
  // workspaceState mutator that needs the hub to see the new favorites
  // list right away). Bound via vscode.commands so webviewBase doesn't
  // need a direct reference to publishCommandsToExternalApi.
  const republishCommand = vscode.commands.registerCommand(
    'commandsExtension._republishExternal',
    () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const cf = vscode.workspace
        .getConfiguration('commandsExtension')
        .get<string>('configFile', 'commands-list.json');
      void publishCommandsToExternalApi(root, cf);
    },
  );
  context.subscriptions.push(republishCommand);

  const uploadFileCommand = vscode.commands.registerCommand(
    'commandsExtension.uploadFile',
    (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
      void uploadFilesToServer(resource, resources);
    }
  );
  context.subscriptions.push(uploadFileCommand);

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
    const claudeHooksWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '.claude/settings*.json')
    );

    const onFileChange = () => {
      CommandsPanel.refresh();
      sidebarProvider.refresh();
      void publishCommandsToExternalApi(vscode.workspace.workspaceFolders![0].uri.fsPath, configFile);
    };

    const onUploadsConfigChange = () => {
      onFileChange();
      const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
      uploadStalenessTracker!.refreshScopesFromConfig(root, uploadsFile).catch(() => undefined);
      void refreshServerUploadsContext(root, uploadsFile);
    };

    for (const w of [commandsWatcher, packageWatcher, ps1Watcher, claudeHooksWatcher]) {
      w.onDidChange(onFileChange);
      w.onDidCreate(onFileChange);
      w.onDidDelete(onFileChange);
    }
    uploadsWatcher.onDidChange(onUploadsConfigChange);
    uploadsWatcher.onDidCreate(onUploadsConfigChange);
    uploadsWatcher.onDidDelete(onUploadsConfigChange);

    const staleWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '**/*')
    );
    const isIgnored = (p: string) => p.includes('/.git/') || p.includes('/node_modules/');
    staleWatcher.onDidChange((uri) => {
      if (!isIgnored(uri.fsPath)) uploadStalenessTracker!.onFileChanged(uri.fsPath);
    });
    staleWatcher.onDidCreate((uri) => {
      if (!isIgnored(uri.fsPath)) uploadStalenessTracker!.onFileChanged(uri.fsPath);
    });
    staleWatcher.onDidDelete((uri) => {
      if (!isIgnored(uri.fsPath)) uploadStalenessTracker!.onFileDeleted(uri.fsPath);
    });

    context.subscriptions.push(commandsWatcher, packageWatcher, uploadsWatcher, ps1Watcher, claudeHooksWatcher, staleWatcher);

    // Populate scopes from current config + scan for new-in-scope files
    uploadStalenessTracker
      .refreshScopesFromConfig(vscode.workspace.workspaceFolders[0].uri.fsPath, uploadsFile)
      .catch(() => undefined);

    // Gate the "Upload to Server" right-click command on whether this project
    // defines any server uploads.
    void refreshServerUploadsContext(vscode.workspace.workspaceFolders[0].uri.fsPath, uploadsFile);

    // Initial publish so the external endpoint has commands without waiting
    // for a file edit (no-op when externalApiUrl is empty).
    void publishCommandsToExternalApi(vscode.workspace.workspaceFolders[0].uri.fsPath, configFile);

    // Heartbeat republish — defends against a hub restart that loses its
    // in-memory pushedCommands cache. PUSHED_TTL_MS in the hub is 5min, so
    // 30s here keeps the cache fresh with plenty of margin and is cheap.
    const heartbeat = setInterval(() => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const cf = vscode.workspace
        .getConfiguration('commandsExtension')
        .get<string>('configFile', 'commands-list.json');
      void publishCommandsToExternalApi(root, cf);
    }, 30_000);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(heartbeat)));
  }
}

export function deactivate(): void {}
