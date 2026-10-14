import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as ftp from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { ResolvedUpload, UploadProgress, UploadStatus, ServerDefinition } from './uploadsTypes';
import { resolveItems, ResolvedItem } from './uploadsProvider';
import {
  sshTargetOf, SshError, rsyncPush, sshScanTree, sshRemoveUnder, sshDeletePaths,
  sshListDir, sshMkdir, sshStat, rsyncPull, acquireSshSlot,
} from './sshTransport';

/**
 * Ask the external hub (commandsExtension.externalApiUrl) to prepare the
 * network (stop the VPN if needed) before we open the FTP/SFTP connection.
 * The hub blocks its 204 until the network actually reports ready, so by the
 * time we get the response there's no proxy/tun race. If no hub is configured
 * or it isn't running, we just continue.
 */
function prepareUpload(uploadKey: string, workspacePath?: string): Promise<void> {
  return new Promise((resolve) => {
    const cfg = vscode.workspace.getConfiguration('commandsExtension');
    const base = (cfg.get<string>('externalApiUrl') ?? 'http://127.0.0.1:8765').replace(/\/+$/, '');
    let url: URL;
    try { url = new URL(`${base}/events/upload-prepare`); }
    catch { return resolve(); }
    // workspacePath lets the hub apply per-project upload settings
    // (e.g. "keep VPN on"). Omitted if no workspace folder is open.
    const body = JSON.stringify({ uploadKey, workspacePath });
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      timeout: 8000,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body).toString(),
      },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

export type ProgressCallback = (p: UploadProgress) => void;

/** Minimal glob → RegExp: supports '**' (any depth), '*' (within segment), '?'. */
function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = esc
    .replace(/\*\*\//g, ' ANYDIR ')
    .replace(/\*\*/g, ' ANY ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/ ANYDIR /g, '(?:.*/)?')
    .replace(/ ANY /g, '.*');
  return new RegExp('^' + re + '$');
}

/** Mirror-mode: '.htaccess' в корне защищён всегда, дальше — по protectRemote. */
function buildProtectMatchers(protectRemote: string[] | undefined): RegExp[] {
  const patterns = ['.htaccess', ...(protectRemote ?? [])];
  return patterns.map(globToRegExp);
}

function matchesAny(relPath: string, matchers: RegExp[]): boolean {
  return matchers.some((m) => m.test(relPath));
}

interface RemoteEntry {
  /** posix path relative to remoteDir, no leading slash */
  rel: string;
  isDir: boolean;
  size: number;
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

function clampConnections(n: number | undefined, fallback: number): number {
  const v = n ?? fallback;
  return Math.max(1, Math.min(8, Math.floor(v)));
}

function safeSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function joinRemote(remoteDir: string, relPath: string): string {
  const dir = remoteDir.endsWith('/') ? remoteDir : remoteDir + '/';
  const cleanRel = relPath.replace(/^\.?\/+/, '');
  return dir + cleanRel;
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.substring(0, i);
}

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** Уникальные директории (rel, posix) заливаемых файлов — для точечного скана. */
function dirsOf(items: ResolvedItem[]): string[] {
  const dirs = new Set<string>();
  for (const it of items) {
    const rel = normalizeRel(it.relativeFromBase);
    const i = rel.lastIndexOf('/');
    dirs.add(i <= 0 ? '' : rel.substring(0, i));
  }
  return Array.from(dirs);
}

/** Отбрасывает из заливки файлы, чей размер на сервере совпал (skipUnchanged-глобы). */
function filterUnchanged(
  items: ResolvedItem[],
  remote: RemoteEntry[] | null,
  skipGlobs: RegExp[],
  sameHash: Set<string> = new Set(),
  unlisted: (rel: string) => boolean = () => false
): { toUpload: ResolvedItem[]; skipped: number } {
  if (skipGlobs.length === 0 && sameHash.size === 0) return { toUpload: items, skipped: 0 };
  const remoteSizes = new Map<string, number>();
  for (const e of remote ?? []) if (!e.isDir) remoteSizes.set(e.rel, e.size);
  const toUpload: ResolvedItem[] = [];
  let skipped = 0;
  for (const it of items) {
    const rel = normalizeRel(it.relativeFromBase);
    if (unlisted(rel)) {
      if (sameHash.has(rel)) skipped += 1;
      else toUpload.push(it);
      continue;
    }
    const size = safeSize(it.absolutePath);
    const sizeSame = remoteSizes.get(rel) === size;
    if ((remote && matchesAny(rel, skipGlobs) && sizeSame) || (sameHash.has(rel) && (!remote || sizeSame))) {
      skipped += 1;
    } else {
      toUpload.push(it);
    }
  }
  return { toUpload, skipped };
}

// skipSameHash: sha1 файлов, залитых в прошлый раз, — пропускаем те, что не изменились с последней заливки
function hashManifestPath(workspaceRoot: string, key: string): string {
  return path.join(workspaceRoot, '.vscode', 'upload-hashes', key.replace(/[^\w.-]+/g, '_') + '.json');
}

function sha1File(p: string): string | null {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

function readHashManifest(file: string): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function mirrorManifestPath(workspaceRoot: string, key: string): string {
  return path.join(workspaceRoot, '.vscode', 'upload-hashes', key.replace(/[^\w.-]+/g, '_') + '.mirror.json');
}

function readMirrorManifest(file: string): string[] | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function ancestorsOf(rel: string, into: Set<string>): void {
  for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) into.add(rel.substring(0, i));
}

function subtreeMatchers(globs: string[], exact: boolean): RegExp[] {
  const out: RegExp[] = [];
  for (const g of globs) {
    const n = normalizeRel(g).replace(/\/+$/, '');
    if (n.endsWith('/**')) out.push(globToRegExp(n.slice(0, -3)));
    else if (exact && n) out.push(globToRegExp(n));
  }
  return out;
}

function coveredBy(dir: string, matchers: RegExp[]): boolean {
  if (matchers.length === 0) return false;
  for (let d = dir; d; d = d.includes('/') ? d.substring(0, d.lastIndexOf('/')) : '') {
    if (matchesAny(d, matchers)) return true;
  }
  return false;
}

function literalPrefix(glob: string): { prefix: string; wild: boolean } {
  const n = normalizeRel(glob);
  const i = n.search(/[*?[]/);
  return i < 0 ? { prefix: n, wild: false } : { prefix: n.substring(0, i), wild: true };
}

interface MirrorPlan {
  smart: boolean;
  local: Set<string>;
  prev: Set<string>;
  knownDirs: Set<string>;
  skipDirs: RegExp[];
  trustDirs: RegExp[];
  protectGlobs: string[];
}

interface ScanResult {
  entries: RemoteEntry[];
  foreignDirs: string[];
  trustedDirs: string[];
  skippedDirs: string[];
  dirsListed: number;
}

type DirLister = (relDir: string) => Promise<{ name: string; isDir: boolean; isFile: boolean; size: number }[]>;

function buildMirrorPlan(upload: ResolvedUpload, items: ResolvedItem[], prev: string[] | null, hasHashes: boolean): MirrorPlan {
  const local = new Set(items.map((it) => normalizeRel(it.relativeFromBase)));
  const prevSet = new Set(prev ?? []);
  const knownDirs = new Set<string>();
  for (const r of local) ancestorsOf(r, knownDirs);
  for (const r of prevSet) ancestorsOf(r, knownDirs);
  const protectGlobs = ['.htaccess', ...(upload.protectRemote ?? [])];
  const trustGlobs = upload.mirrorTrustHashes ?? upload.skipUnchanged ?? [];
  return {
    smart: upload.mirrorScan !== 'full',
    local,
    prev: prevSet,
    knownDirs,
    skipDirs: [...subtreeMatchers(protectGlobs, false), ...subtreeMatchers(upload.mirrorScanIgnore ?? [], true)],
    trustDirs: upload.mirrorScan !== 'full' && prev && hasHashes ? subtreeMatchers(trustGlobs, true) : [],
    protectGlobs,
  };
}

function mayHoldProtected(dir: string, globs: string[]): boolean {
  const d = dir + '/';
  return globs.some((g) => {
    const { prefix, wild } = literalPrefix(g);
    return prefix.startsWith(d) || (wild && d.startsWith(prefix));
  });
}

async function scanMirror(
  listers: DirLister[],
  plan: MirrorPlan,
  signal: AbortSignal,
  onProgress: (dirs: number, files: number) => void
): Promise<ScanResult> {
  const res: ScanResult = { entries: [], foreignDirs: [], trustedDirs: [], skippedDirs: [], dirsListed: 0 };
  const listed = new Set<string>(['']);
  const queue: string[] = [''];
  let active = 0;
  let files = 0;
  let lastReport = 0;

  const classify = (rel: string) => {
    if (coveredBy(rel, plan.skipDirs)) {
      res.skippedDirs.push(rel);
      return;
    }
    if (coveredBy(rel, plan.trustDirs)) {
      res.trustedDirs.push(rel);
      return;
    }
    if (plan.smart && !plan.knownDirs.has(rel) && !mayHoldProtected(rel, plan.protectGlobs)) {
      res.foreignDirs.push(rel);
      return;
    }
    res.entries.push({ rel, isDir: true, size: 0 });
    if (!listed.has(rel)) {
      listed.add(rel);
      queue.push(rel);
    }
  };

  const worker = async (list: DirLister): Promise<void> => {
    for (;;) {
      if (signal.aborted) throw new Error('Cancelled');
      const relDir = queue.shift();
      if (relDir === undefined) {
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 15));
        continue;
      }
      active += 1;
      try {
        const entries = await list(relDir);
        res.dirsListed += 1;
        for (const fi of entries) {
          if (fi.name === '.' || fi.name === '..') continue;
          const rel = relDir ? `${relDir}/${fi.name}` : fi.name;
          if (fi.isDir) classify(rel);
          else if (fi.isFile) {
            res.entries.push({ rel, isDir: false, size: fi.size });
            files += 1;
          }
        }
        const now = Date.now();
        if (now - lastReport > 300) {
          lastReport = now;
          onProgress(res.dirsListed, files);
        }
      } catch {
        /* недоступная или отсутствующая папка */
      } finally {
        active -= 1;
      }
    }
  };

  await Promise.all(listers.map((l) => worker(l)));
  onProgress(res.dirsListed, files);
  return res;
}

function scanSummary(s: ScanResult): string {
  const parts = [`${s.dirsListed} dirs listed`];
  if (s.skippedDirs.length) parts.push(`skipped protected: ${s.skippedDirs.length} dirs`);
  if (s.trustedDirs.length) parts.push(`trusted: ${s.trustedDirs.length} dirs`);
  if (s.foreignDirs.length) parts.push(`foreign: ${s.foreignDirs.length} dirs`);
  return parts.join(', ');
}

export class UploadRunner {
  private readonly _active = new Map<string, AbortController>();
  private readonly _lastStatus = new Map<string, UploadProgress>();

  constructor(
    private readonly _onProgress: ProgressCallback,
    private readonly _onFilesUploaded?: (
      key: string,
      filePaths: string[],
      partial: boolean,
      scope: { workspaceRoot: string; items: string[]; exclude: string[] }
    ) => void
  ) {}

  public getLastStatuses(): UploadProgress[] {
    return Array.from(this._lastStatus.values());
  }

  public isRunning(key: string): boolean {
    return this._active.has(key);
  }

  public cancel(key: string): void {
    const ctrl = this._active.get(key);
    if (ctrl) ctrl.abort();
  }

  public async run(
    workspaceRoot: string,
    upload: ResolvedUpload,
    fileFilter?: Set<string>
  ): Promise<void> {
    const key = `${upload.group}:${upload.name}`;
    if (this._active.has(key)) {
      vscode.window.showInformationMessage(`Upload "${upload.name}" is already running.`);
      return;
    }

    const ctrl = new AbortController();
    this._active.set(key, ctrl);

    const emit = (patch: Partial<UploadProgress> & { status: UploadStatus }) => {
      const merged: UploadProgress = {
        uploadKey: key,
        workspacePath: workspaceRoot,
        ...patch,
      };
      this._lastStatus.set(key, merged);
      this._onProgress(merged);
    };

    emit({ status: 'connecting', message: 'Resolving items…' });

    try {
      let items = await resolveItems(workspaceRoot, upload.items, upload.exclude);
      if (fileFilter && fileFilter.size > 0) {
        items = items.filter((it) => fileFilter.has(it.absolutePath));
      }
      if (items.length === 0) {
        emit({ status: 'error', message: 'No files found to upload (check items / exclude)', finishedAt: Date.now() });
        return;
      }

      emit({ status: 'connecting', message: 'Preparing network…' });
      await prepareUpload(key, workspaceRoot);

      emit({ status: 'connecting', message: `Connecting to ${upload.host}…` });

      // Mirror-очистка только при полной заливке: частичная (fileFilter)
      // не знает полного локального состава и удалять ничего не должна.
      const mirror = upload.mode === 'mirror' && !fileFilter;
      // Точечная заливка сама знает состав — серверный скан skipUnchanged не нужен.
      if (fileFilter) upload = { ...upload, skipUnchanged: [] };

      const hashGlobs = fileFilter ? [] : (upload.skipSameHash ?? []).map(globToRegExp);
      const manifestFile = hashManifestPath(workspaceRoot, key);
      const prevHashes = hashGlobs.length ? readHashManifest(manifestFile) : {};
      const nextHashes: Record<string, string> = {};
      const sameHash = new Set<string>();
      for (const it of hashGlobs.length ? items : []) {
        const rel = normalizeRel(it.relativeFromBase);
        if (!matchesAny(rel, hashGlobs)) continue;
        const h = sha1File(it.absolutePath);
        if (!h) continue;
        nextHashes[rel] = h;
        if (prevHashes[rel] === h) sameHash.add(rel);
      }
      const mirrorFile = mirrorManifestPath(workspaceRoot, key);
      let plan: MirrorPlan | null = null;
      if (mirror) {
        const prevList = readMirrorManifest(mirrorFile);
        const prev = prevList || Object.keys(prevHashes).length ? [...(prevList ?? []), ...Object.keys(prevHashes)] : null;
        plan = buildMirrorPlan(upload, items, prev, Object.keys(prevHashes).length > 0);
      }

      let viaSsh = false;
      if (upload.ssh) {
        try {
          await this._runRsync(upload, items, emit, ctrl.signal, plan, sameHash);
          viaSsh = true;
        } catch (e) {
          if (!(e instanceof SshError && e.connection && upload.ssh.fallbackToFtp && upload.protocol !== 'ssh')) throw e;
          emit({ status: 'connecting', message: `SSH failed, falling back to ${upload.protocol.toUpperCase()}…` });
        }
      }
      if (!viaSsh) {
        const password = await this._askPassword(upload);
        if (!password) {
          emit({ status: 'cancelled', message: 'Password not provided', finishedAt: Date.now() });
          return;
        }
        if (upload.protocol === 'sftp') {
          await this._runSftp(upload, password, items, emit, ctrl.signal, plan, sameHash);
        } else {
          await this._runFtp(upload, password, items, emit, ctrl.signal, plan, sameHash);
        }
      }
      if (hashGlobs.length && !ctrl.signal.aborted && this._lastStatus.get(key)?.status === 'done') {
        fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
        fs.writeFileSync(manifestFile, JSON.stringify(nextHashes));
      }
      if (plan && !ctrl.signal.aborted && this._lastStatus.get(key)?.status === 'done') {
        fs.mkdirSync(path.dirname(mirrorFile), { recursive: true });
        fs.writeFileSync(mirrorFile, JSON.stringify(Array.from(plan.local)));
      }
      this._onFilesUploaded?.(
        key,
        items.map((it) => it.absolutePath),
        !!fileFilter,
        { workspaceRoot, items: upload.items, exclude: upload.exclude }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ status: 'error', message, finishedAt: Date.now() });
    } finally {
      this._active.delete(key);
    }
  }

  private async _askPassword(upload: ResolvedUpload): Promise<string | undefined> {
    if (upload.password) return upload.password;
    return vscode.window.showInputBox({
      title: `Password for ${upload.user}@${upload.host}`,
      prompt: `${upload.protocol.toUpperCase()} password — not stored, will be asked again`,
      password: true,
      ignoreFocusOut: true,
    });
  }

  // ---------------------------------------------------------------- rsync

  private async _runRsync(
    upload: ResolvedUpload,
    items: ResolvedItem[],
    emit: (p: Partial<UploadProgress> & { status: UploadStatus }) => void,
    signal: AbortSignal,
    plan: MirrorPlan | null,
    sameHash: Set<string>
  ): Promise<void> {
    const mirror = !!plan;
    const t = upload.ssh!;
    const base = upload.remoteDir;
    emit({ status: 'connecting', message: `Waiting for a free SSH slot on ${t.host}…` });
    const release = await acquireSshSlot(t, signal);
    try {
      const toUpload = items.filter((it) => !sameHash.has(normalizeRel(it.relativeFromBase)));
      const skippedHash = items.length - toUpload.length;
      const totalBytes = toUpload.reduce((sum, it) => sum + safeSize(it.absolutePath), 0);
      const filesTotal = toUpload.length;
      const startedAt = Date.now();
      emit({ status: 'connecting', message: `rsync → ${t.user}@${t.host}…` });

      let lastEmit = 0;
      const res = await rsyncPush(
        t,
        toUpload.map((it) => ({ localAbs: it.absolutePath, remoteRel: normalizeRel(it.relativeFromBase) })),
        base,
        { ignoreExisting: upload.onExists === 'skip' },
        (p) => {
          const now = Date.now();
          if (now - lastEmit < 150) return;
          lastEmit = now;
          emit({
            status: 'running',
            currentFile: p.currentFile,
            bytes: p.bytes,
            bytesTotal: totalBytes,
            filesDone: p.filesDone,
            filesTotal,
            percent: p.percent,
            speedBps: p.speedBps,
          });
        },
        signal
      );

      let deleted = 0;
      if (mirror && !signal.aborted) {
        emit({ status: 'running', message: 'Mirror: scanning server…', percent: 100 });
        const prune = [...(upload.protectRemote ?? []), ...(upload.mirrorScanIgnore ?? [])]
          .map((g) => normalizeRel(g).replace(/\/+$/, ''))
          .map((g) => (g.endsWith('/**') ? g.slice(0, -3) : (upload.mirrorScanIgnore ?? []).includes(g) ? g : ''))
          .filter((g) => g && !/[*?[]/.test(g));
        const remote = (await sshScanTree(t, base, signal, prune)).filter((e) => !coveredBy(e.isDir ? e.rel : posixDirname(e.rel).replace(/^\/$/, ''), plan!.skipDirs));
        const local = plan!.local;
        const protect = buildProtectMatchers(upload.protectRemote);
        const keepDirs = new Set<string>();
        for (const rel of local) ancestorsOf(rel, keepDirs);
        const files = remote.filter((e) => !e.isDir && !local.has(e.rel) && !matchesAny(e.rel, protect)).map((e) => e.rel);
        const dirs = remote
          .filter((e) => e.isDir && !keepDirs.has(e.rel) && !matchesAny(e.rel, protect))
          .map((e) => e.rel)
          .sort((a, b) => b.length - a.length);
        emit({ status: 'running', message: `Mirror: removing ${files.length} stale…`, percent: 100 });
        deleted = await sshRemoveUnder(t, base, files, dirs, signal);
      }

      const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
      const unchanged = filesTotal - res.filesTransferred + skippedHash;
      emit({
        status: 'done',
        message:
          `rsync: uploaded ${res.filesTransferred} file(s), ${formatBytes(res.bytes)} in ${elapsed.toFixed(1)}s` +
          (unchanged > 0 ? `, skipped ${unchanged} unchanged` : '') +
          (mirror ? `, mirror: removed ${deleted} stale` : ''),
        bytes: res.bytes,
        bytesTotal: totalBytes,
        filesDone: res.filesTransferred,
        filesTotal,
        percent: 100,
        speedBps: res.bytes / elapsed,
        finishedAt: Date.now(),
      });
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------------ FTP

  private async _runFtp(
    upload: ResolvedUpload,
    password: string,
    items: ResolvedItem[],
    emit: (p: Partial<UploadProgress> & { status: UploadStatus }) => void,
    signal: AbortSignal,
    plan: MirrorPlan | null = null,
    sameHash: Set<string> = new Set()
  ): Promise<void> {
    const mirror = !!plan;
    const connections = clampConnections(upload.connections, 4);
    const skipGlobs = (upload.skipUnchanged ?? []).map(globToRegExp);
    const base = upload.remoteDir.replace(/\/+$/, '');

    const openClient = async (): Promise<ftp.Client> => {
      const c = new ftp.Client(30_000);
      c.ftp.verbose = false;
      await c.access({
        host: upload.host,
        port: upload.port,
        user: upload.user,
        password,
        secure: upload.protocol === 'ftps',
      });
      return c;
    };

    const clients: ftp.Client[] = [];
    const onAbort = () => clients.forEach((c) => c.close());
    signal.addEventListener('abort', onAbort);

    try {
      clients.push(await openClient());

      // Пре-скан сервера: нужен и для skipUnchanged, и для mirror-очистки.
      // Пул открываем ДО скана — обход дерева тоже параллелится по соединениям,
      // иначе тысячи LIST-запросов идут в одно соединение и упираются в latency.
      let preScan: RemoteEntry[] | null = null;
      let scan: ScanResult | null = null;
      if (mirror || skipGlobs.length > 0) {
        emit({ status: 'running', message: 'Scanning server…' });

        const scanPool = mirror ? connections : Math.min(connections, Math.max(1, items.length));
        await Promise.all(
          Array.from({ length: Math.max(0, scanPool - clients.length) }, async () => {
            if (signal.aborted) return;
            clients.push(await openClient());
          })
        );

        if (plan) {
          scan = await scanMirror(
            clients.map((c) => async (rel: string) => (await c.list(rel ? `${base}/${rel}` : base)).map((fi) => ({ name: fi.name, isDir: fi.isDirectory, isFile: fi.isFile, size: fi.size }))),
            plan,
            signal,
            (d, n) => emit({ status: 'running', message: `Scanning server: ${d} dirs / ${n} files` })
          );
          preScan = scan.entries;
          emit({ status: 'running', message: `Scanned server: ${scanSummary(scan)}` });
        } else {
          // Только skipUnchanged: размеры нужны лишь для заливаемых файлов.
          // Обходим не всё дерево, а только директории, где они лежат.
          preScan = await this._scanFtpDirs(clients, base, dirsOf(items), signal, (n) =>
            emit({ status: 'running', message: `Scanning server… ${n} files` })
          );
        }
      }

      const { toUpload, skipped } = filterUnchanged(items, preScan, skipGlobs, sameHash, (rel) =>
        !!plan && rel.includes('/') && coveredBy(rel.substring(0, rel.lastIndexOf('/')), plan.trustDirs)
      );

      // Соединения уже открыты под скан; добираем, если их не хватает
      const poolSize = Math.min(connections, Math.max(1, toUpload.length));
      while (clients.length < poolSize) {
        if (signal.aborted) throw new Error('Cancelled');
        clients.push(await openClient());
      }

      const totalBytes = toUpload.reduce((sum, it) => sum + safeSize(it.absolutePath), 0);
      const filesTotal = toUpload.length;
      const startedAt = Date.now();
      // Побайтовый прогресс: у каждого соединения свой накопитель trackProgress.
      // Длина — по числу клиентов (их может быть больше poolSize: пул открывался
      // под скан), иначе индексы за границей массива и прогресс висит на 0%.
      const clientBytes = new Array<number>(clients.length).fill(0);
      let filesDone = 0;
      let nextIndex = 0;
      let lastEmit = 0;
      let currentName = '';

      const emitProgress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastEmit < 150) return;
        lastEmit = now;
        const transferred = clientBytes.reduce((a, b) => a + b, 0);
        const elapsed = Math.max(1, (now - startedAt) / 1000);
        // Процент — по завершённым файлам, а не по байтам: на тысячах мелких
        // файлов trackProgress почти не срабатывает (передача укладывается в один
        // буфер), transferred остаётся 0 и прогресс висит на нуле. Байты берём как
        // уточнение внутри текущих файлов, если они всё-таки набежали.
        const byFiles = filesTotal > 0 ? (filesDone / filesTotal) * 100 : 0;
        const byBytes = totalBytes > 0 ? (transferred / totalBytes) * 100 : 0;
        emit({
          status: 'running',
          currentFile: currentName,
          bytes: Math.max(transferred, 0),
          bytesTotal: totalBytes,
          filesDone,
          filesTotal,
          percent: Math.min(100, Math.max(byFiles, byBytes)),
          speedBps: transferred / elapsed,
        });
      };

      clients.slice(0, poolSize).forEach((c, i) => {
        c.trackProgress((info) => {
          if (signal.aborted) return;
          // info.bytes — суммарно по соединению с момента trackProgress
          clientBytes[i] = info.bytes;
          emitProgress();
        });
      });
      emitProgress(true);

      // ensureDir дорогой (серия MKD/CWD) — создаём каждую папку один раз
      const dirEnsured = new Map<string, Promise<void>>();
      const ensureDirOnce = (client: ftp.Client, dir: string): Promise<void> => {
        let p = dirEnsured.get(dir);
        if (!p) {
          p = (async () => {
            try {
              await client.ensureDir(dir);
              await client.cd('/');
            } catch {
              /* существует или создаст сосед */
            }
          })();
          dirEnsured.set(dir, p);
        }
        return p;
      };

      const worker = async (client: ftp.Client): Promise<void> => {
        for (;;) {
          if (signal.aborted) throw new Error('Cancelled');
          const idx = nextIndex++;
          if (idx >= toUpload.length) return;
          const item = toUpload[idx];
          const rel = normalizeRel(item.relativeFromBase);
          const remotePath = joinRemote(upload.remoteDir, rel);
          const remoteDir = posixDirname(remotePath);
          if (remoteDir && remoteDir !== '/' && remoteDir !== '.') {
            await ensureDirOnce(client, remoteDir);
          }
          currentName = rel;
          await client.uploadFrom(item.absolutePath, remotePath);
          filesDone += 1;
          emitProgress();
        }
      };

      await Promise.all(clients.slice(0, poolSize).map((c) => worker(c)));
      clients.forEach((c) => c.trackProgress());
      const transferredTotal = clientBytes.reduce((a, b) => a + b, 0);

      let deleted = 0;
      if (plan && scan && !signal.aborted) {
        emit({ status: 'running', message: 'Mirror: removing stale files…', percent: 100 });
        deleted = await this._mirrorDelete(
          scan,
          plan,
          upload,
          signal,
          (rel) => clients[0].remove(`${base}/${rel}`),
          (rel) => clients[0].removeEmptyDir(`${base}/${rel}`).then(() => undefined),
          (rel) => clients[0].removeDir(`${base}/${rel}`).then(() => clients[0].cd('/')).then(() => undefined),
          emit
        );
      }

      const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
      emit({
        status: 'done',
        message:
          `Uploaded ${filesDone} file(s), ${formatBytes(transferredTotal)} in ${elapsed.toFixed(1)}s` +
          (skipped > 0 ? `, skipped ${skipped} unchanged` : '') +
          (mirror ? `, mirror: removed ${deleted} stale` : '') +
          (scan ? ` (${scanSummary(scan)})` : ''),
        bytes: transferredTotal,
        bytesTotal: totalBytes,
        filesDone,
        filesTotal,
        percent: 100,
        speedBps: transferredTotal / elapsed,
        finishedAt: Date.now(),
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
      clients.forEach((c) => c.close());
    }
  }

  /**
   * Точечный скан: листает ТОЛЬКО перечисленные директории, без рекурсии.
   * Для skipUnchanged при частичной заливке нужны размеры лишь тех файлов,
   * что мы собираемся заливать — обходить всё дерево сервера незачем.
   */
  private async _scanFtpDirs(
    clients: ftp.Client[],
    base: string,
    dirs: string[],
    signal: AbortSignal,
    onProgress?: (found: number) => void
  ): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = [];
    const queue = [...dirs];
    let lastReport = 0;

    const worker = async (client: ftp.Client): Promise<void> => {
      for (;;) {
        if (signal.aborted) throw new Error('Cancelled');
        const relDir = queue.shift();
        if (relDir === undefined) return;
        try {
          const list = await client.list(relDir ? `${base}/${relDir}` : base);
          for (const fi of list) {
            if (!fi.isFile) continue;
            const rel = relDir ? `${relDir}/${fi.name}` : fi.name;
            entries.push({ rel, isDir: false, size: fi.size });
          }
          const now = Date.now();
          if (onProgress && now - lastReport > 300) {
            lastReport = now;
            onProgress(entries.length);
          }
        } catch {
          // Директории может не быть на сервере — значит файлы новые, зальём
        }
      }
    };

    await Promise.all(clients.map((c) => worker(c)));
    return entries;
  }

  // ------------------------------------------------------------------ SFTP

  private async _runSftp(
    upload: ResolvedUpload,
    password: string,
    items: ResolvedItem[],
    emit: (p: Partial<UploadProgress> & { status: UploadStatus }) => void,
    signal: AbortSignal,
    plan: MirrorPlan | null = null,
    sameHash: Set<string> = new Set()
  ): Promise<void> {
    const mirror = !!plan;
    const connections = clampConnections(upload.connections, 2);
    const skipGlobs = (upload.skipUnchanged ?? []).map(globToRegExp);
    const base = upload.remoteDir.replace(/\/+$/, '');

    const openClient = async (): Promise<SftpClient> => {
      const c = new SftpClient();
      await c.connect({
        host: upload.host,
        port: upload.port,
        username: upload.user,
        password,
        readyTimeout: 30_000,
      });
      return c;
    };

    const clients: SftpClient[] = [];
    const onAbort = () => clients.forEach((c) => { c.end().catch(() => undefined); });
    signal.addEventListener('abort', onAbort);

    try {
      clients.push(await openClient());

      // Пул открываем ДО скана — обход дерева тоже параллелится по соединениям
      let preScan: RemoteEntry[] | null = null;
      let scan: ScanResult | null = null;
      if (mirror || skipGlobs.length > 0) {
        emit({ status: 'running', message: 'Scanning server…' });

        const scanPool = mirror ? connections : Math.min(connections, Math.max(1, items.length));
        await Promise.all(
          Array.from({ length: Math.max(0, scanPool - clients.length) }, async () => {
            if (signal.aborted) return;
            clients.push(await openClient());
          })
        );

        if (plan) {
          scan = await scanMirror(
            clients.map((c) => async (rel: string) => (await c.list(rel ? `${base}/${rel}` : base)).map((fi) => ({ name: fi.name, isDir: fi.type === 'd', isFile: fi.type === '-', size: fi.size }))),
            plan,
            signal,
            (d, n) => emit({ status: 'running', message: `Scanning server: ${d} dirs / ${n} files` })
          );
          preScan = scan.entries;
          emit({ status: 'running', message: `Scanned server: ${scanSummary(scan)}` });
        } else {
          // Только skipUnchanged — хватит директорий заливаемых файлов
          preScan = await this._scanSftpDirs(clients, base, dirsOf(items), signal, (n) =>
            emit({ status: 'running', message: `Scanning server… ${n} files` })
          );
        }
      }

      const { toUpload, skipped } = filterUnchanged(items, preScan, skipGlobs, sameHash, (rel) =>
        !!plan && rel.includes('/') && coveredBy(rel.substring(0, rel.lastIndexOf('/')), plan.trustDirs)
      );

      const poolSize = Math.min(connections, Math.max(1, toUpload.length));
      while (clients.length < poolSize) {
        if (signal.aborted) throw new Error('Cancelled');
        clients.push(await openClient());
      }

      const totalBytes = toUpload.reduce((sum, it) => sum + safeSize(it.absolutePath), 0);
      const filesTotal = toUpload.length;
      const startedAt = Date.now();
      // done-байты + незавершённые передачи каждого соединения (step-коллбек fastPut)
      let doneBytes = 0;
      const inflight = new Array<number>(poolSize).fill(0);
      let filesDone = 0;
      let nextIndex = 0;
      let lastEmit = 0;
      let currentName = '';

      const emitProgress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastEmit < 150) return;
        lastEmit = now;
        const transferred = doneBytes + inflight.reduce((a, b) => a + b, 0);
        const elapsed = Math.max(1, (now - startedAt) / 1000);
        // Как и в FTP: процент по файлам — надёжнее байтового на мелких файлах
        const byFiles = filesTotal > 0 ? (filesDone / filesTotal) * 100 : 0;
        const byBytes = totalBytes > 0 ? (transferred / totalBytes) * 100 : 0;
        emit({
          status: 'running',
          currentFile: currentName,
          bytes: transferred,
          bytesTotal: totalBytes,
          filesDone,
          filesTotal,
          percent: Math.min(100, Math.max(byFiles, byBytes)),
          speedBps: transferred / elapsed,
        });
      };
      emitProgress(true);

      const dirEnsured = new Map<string, Promise<void>>();
      const ensureDirOnce = (client: SftpClient, dir: string): Promise<void> => {
        let p = dirEnsured.get(dir);
        if (!p) {
          p = client.mkdir(dir, true).then(() => undefined).catch(() => undefined);
          dirEnsured.set(dir, p);
        }
        return p;
      };

      const worker = async (client: SftpClient, slot: number): Promise<void> => {
        for (;;) {
          if (signal.aborted) throw new Error('Cancelled');
          const idx = nextIndex++;
          if (idx >= toUpload.length) return;
          const item = toUpload[idx];
          const rel = normalizeRel(item.relativeFromBase);
          const remotePath = joinRemote(upload.remoteDir, rel);
          const remoteDir = posixDirname(remotePath);
          if (remoteDir) await ensureDirOnce(client, remoteDir);
          currentName = rel;
          await client.fastPut(item.absolutePath, remotePath, {
            step: (totalTransferred: number) => {
              inflight[slot] = totalTransferred;
              emitProgress();
            },
          });
          doneBytes += safeSize(item.absolutePath);
          inflight[slot] = 0;
          filesDone += 1;
          emitProgress();
        }
      };

      await Promise.all(clients.slice(0, poolSize).map((c, i) => worker(c, i)));
      const transferredTotal = doneBytes;

      let deleted = 0;
      if (plan && scan && !signal.aborted) {
        emit({ status: 'running', message: 'Mirror: removing stale files…', percent: 100 });
        deleted = await this._mirrorDelete(
          scan,
          plan,
          upload,
          signal,
          (rel) => clients[0].delete(`${base}/${rel}`).then(() => undefined),
          (rel) => clients[0].rmdir(`${base}/${rel}`).then(() => undefined),
          (rel) => clients[0].rmdir(`${base}/${rel}`, true).then(() => undefined),
          emit
        );
      }

      const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
      emit({
        status: 'done',
        message:
          `Uploaded ${filesDone} file(s), ${formatBytes(transferredTotal)} in ${elapsed.toFixed(1)}s` +
          (skipped > 0 ? `, skipped ${skipped} unchanged` : '') +
          (mirror ? `, mirror: removed ${deleted} stale` : '') +
          (scan ? ` (${scanSummary(scan)})` : ''),
        bytes: transferredTotal,
        bytesTotal: totalBytes,
        filesDone,
        filesTotal,
        percent: 100,
        speedBps: transferredTotal / elapsed,
        finishedAt: Date.now(),
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
      for (const c of clients) {
        try {
          await c.end();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Точечный скан только заданных директорий — см. комментарий у _scanFtpDirs. */
  private async _scanSftpDirs(
    clients: SftpClient[],
    base: string,
    dirs: string[],
    signal: AbortSignal,
    onProgress?: (found: number) => void
  ): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = [];
    const queue = [...dirs];
    let lastReport = 0;

    const worker = async (sftp: SftpClient): Promise<void> => {
      for (;;) {
        if (signal.aborted) throw new Error('Cancelled');
        const relDir = queue.shift();
        if (relDir === undefined) return;
        try {
          const list = await sftp.list(relDir ? `${base}/${relDir}` : base);
          for (const fi of list) {
            if (fi.type !== '-') continue;
            const rel = relDir ? `${relDir}/${fi.name}` : fi.name;
            entries.push({ rel, isDir: false, size: fi.size });
          }
          const now = Date.now();
          if (onProgress && now - lastReport > 300) {
            lastReport = now;
            onProgress(entries.length);
          }
        } catch {
          // Директории может не быть — значит файлы новые
        }
      }
    };

    await Promise.all(clients.map((c) => worker(c)));
    return entries;
  }

  // ------------------------------------------------------------- mirror

  /** Удаляет с сервера файлы, которых нет в локальном наборе (mode: 'mirror'). */
  private async _mirrorDelete(
    scan: ScanResult,
    plan: MirrorPlan,
    upload: ResolvedUpload,
    signal: AbortSignal,
    removeFile: (rel: string) => Promise<unknown>,
    removeDir: (rel: string) => Promise<unknown>,
    removeTree: (rel: string) => Promise<unknown>,
    emit: (p: Partial<UploadProgress> & { status: UploadStatus }) => void
  ): Promise<number> {
    const protect = buildProtectMatchers(upload.protectRemote);
    const keepDirs = new Set<string>();
    for (const r of plan.local) ancestorsOf(r, keepDirs);

    const files = scan.entries.filter((e) => !e.isDir && !plan.local.has(e.rel) && !matchesAny(e.rel, protect)).map((e) => e.rel);
    const dirs = new Set(scan.entries.filter((e) => e.isDir).map((e) => e.rel));
    if (scan.trustedDirs.length) {
      const trusted = scan.trustedDirs.map((d) => d + '/');
      for (const r of plan.prev) {
        if (plan.local.has(r) || matchesAny(r, protect) || !trusted.some((t) => r.startsWith(t))) continue;
        files.push(r);
        const ds = new Set<string>();
        ancestorsOf(r, ds);
        for (const d of ds) if (trusted.some((t) => (d + '/').startsWith(t) && d + '/' !== t)) dirs.add(d);
      }
    }

    let deleted = 0;
    const tick = () => {
      deleted += 1;
      if (deleted % 20 === 0) emit({ status: 'running', message: `Mirror: removed ${deleted}…`, percent: 100 });
    };
    for (const rel of files) {
      if (signal.aborted) throw new Error('Cancelled');
      try {
        await removeFile(rel);
        tick();
      } catch {
        /* нет на сервере или не смогли удалить */
      }
    }
    for (const rel of scan.foreignDirs) {
      if (signal.aborted) throw new Error('Cancelled');
      try {
        await removeTree(rel);
        tick();
      } catch {
        /* оставляем */
      }
    }

    const order = Array.from(dirs).filter((d) => !keepDirs.has(d) && !matchesAny(d, protect)).sort((a, b) => b.length - a.length);
    for (const d of order) {
      if (signal.aborted) throw new Error('Cancelled');
      try {
        await removeDir(d);
      } catch {
        /* не пустая */
      }
    }
    return deleted;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick upload: разовая заливка файлов/папки в произвольную директорию сервера,
// без конфига server-uploads.local.json (для нетрекаемых файлов — логотипы,
// иконки составных частей и т.п.). + навигация по директориям сервера.
// ─────────────────────────────────────────────────────────────────────────────

export interface QuickFile {
  /** Абсолютный локальный путь. */
  localAbs: string;
  /** Относительный путь на сервере от remoteDir (posix). Для одиночных файлов = имя файла. */
  remoteRel: string;
}

export interface RemoteListEntry {
  name: string;
  isDir: boolean;
  size?: number;
}

function serverPort(s: ServerDefinition): number {
  return s.port ?? (s.protocol === 'sftp' || s.protocol === 'ssh' ? 22 : 21);
}

/** Листинг одной удалённой директории (для навигации, как в FileZilla). */
export async function listRemoteDir(
  server: ServerDefinition,
  dir: string
): Promise<RemoteListEntry[]> {
  const port = serverPort(server);
  const path = dir && dir !== '' ? dir : '/';
  const sshT = sshTargetOf(server);
  if (sshT && server.protocol === 'ssh') return sshListDir(sshT, path);

  if (server.protocol === 'sftp') {
    const c = new SftpClient();
    try {
      await c.connect({
        host: server.host,
        port,
        username: server.user,
        password: server.password,
        readyTimeout: 30_000,
      });
      const list = await c.list(path);
      return list
        .filter((e) => e.name !== '.' && e.name !== '..')
        .map((e) => ({ name: e.name, isDir: e.type === 'd', size: e.size }));
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  const c = new ftp.Client(30_000);
  c.ftp.verbose = false;
  try {
    await c.access({
      host: server.host,
      port,
      user: server.user,
      password: server.password,
      secure: server.protocol === 'ftps',
    });
    const list = await c.list(path);
    return list
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => ({ name: e.name, isDir: e.isDirectory, size: e.size }));
  } finally {
    c.close();
  }
}

/** Создать директорию на сервере (рекурсивно). */
export async function remoteMkdir(server: ServerDefinition, dir: string): Promise<void> {
  const sshT = sshTargetOf(server);
  if (sshT && server.protocol === 'ssh') return sshMkdir(sshT, dir);
  const port = serverPort(server);
  if (server.protocol === 'sftp') {
    const c = new SftpClient();
    try {
      await c.connect({ host: server.host, port, username: server.user, password: server.password, readyTimeout: 30_000 });
      await c.mkdir(dir, true);
    } finally {
      await c.end().catch(() => undefined);
    }
    return;
  }
  const c = new ftp.Client(30_000);
  c.ftp.verbose = false;
  try {
    await c.access({ host: server.host, port, user: server.user, password: server.password, secure: server.protocol === 'ftps' });
    await c.ensureDir(dir);
  } finally {
    c.close();
  }
}

export interface RemoteTargetInfo {
  path: string;
  exists: boolean;
  isDir: boolean;
  /** Число файлов внутри (рекурсивно) — только для директорий. */
  fileCount: number;
}

/** Что лежит по пути на сервере: файл, директория (со счётчиком) или ничего. */
export async function statRemoteTarget(
  server: ServerDefinition,
  target: string
): Promise<RemoteTargetInfo> {
  const sshT = sshTargetOf(server);
  if (sshT) return { path: target, ...(await sshStat(sshT, target)) };
  const parent = posixDirname(target) || '/';
  const base = target.replace(/\/+$/, '').split('/').pop() || '';
  let entries: RemoteListEntry[];
  try {
    entries = await listRemoteDir(server, parent);
  } catch {
    return { path: target, exists: false, isDir: false, fileCount: 0 };
  }
  const hit = entries.find((e) => e.name === base);
  if (!hit) return { path: target, exists: false, isDir: false, fileCount: 0 };
  if (!hit.isDir) return { path: target, exists: true, isDir: false, fileCount: 1 };

  let fileCount = 0;
  const walk = async (dir: string): Promise<void> => {
    let list: RemoteListEntry[];
    try { list = await listRemoteDir(server, dir); } catch { return; }
    for (const e of list) {
      if (e.isDir) await walk(`${dir.replace(/\/+$/, '')}/${e.name}`);
      else fileCount += 1;
    }
  };
  await walk(target);
  return { path: target, exists: true, isDir: true, fileCount };
}

/**
 * Рекурсивно удаляет пути на сервере (файлы и директории) за одно соединение.
 * Возвращает число удалённых файлов. Отсутствующие пути пропускаются.
 */
export async function deleteRemotePaths(
  server: ServerDefinition,
  targets: string[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<number> {
  const port = serverPort(server);
  let removed = 0;
  const sshT = sshTargetOf(server);
  if (sshT) {
    onProgress?.({ uploadKey: '__quick_delete__', status: 'running', message: `Deleting ${targets.length} path(s) over SSH…` });
    return sshDeletePaths(sshT, targets, signal);
  }

  const emit = (message: string) => {
    onProgress?.({ uploadKey: '__quick_delete__', status: 'running', message });
  };

  if (server.protocol === 'sftp') {
    const c = new SftpClient();
    const onAbort = () => { c.end().catch(() => undefined); };
    signal?.addEventListener('abort', onAbort);
    try {
      await c.connect({ host: server.host, port, username: server.user, password: server.password, readyTimeout: 30_000 });
      for (const t of targets) {
        if (signal?.aborted) throw new Error('Cancelled');
        emit(`Deleting ${t}…`);
        try {
          const type = await c.exists(t);
          if (!type) continue;
          if (type === 'd') { await c.rmdir(t, true); removed += 1; }
          else { await c.delete(t); removed += 1; }
        } catch { /* уже нет или нет прав — идём дальше */ }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await c.end().catch(() => undefined);
    }
    return removed;
  }

  const c = new ftp.Client(30_000);
  c.ftp.verbose = false;
  const onAbort = () => c.close();
  signal?.addEventListener('abort', onAbort);
  try {
    await c.access({ host: server.host, port, user: server.user, password: server.password, secure: server.protocol === 'ftps' });
    for (const t of targets) {
      if (signal?.aborted) throw new Error('Cancelled');
      emit(`Deleting ${t}…`);
      try {
        await c.remove(t);
        removed += 1;
      } catch {
        try {
          await c.removeDir(t);
          removed += 1;
        } catch { /* уже нет или нет прав */ }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    c.close();
  }
  return removed;
}

export interface DownloadTarget {
  /** Абсолютный путь на сервере (файл или папка). */
  remotePath: string;
  /** Локальная директория, куда класть. */
  localDir: string;
}

/**
 * Скачивает пути с сервера в локальные директории за одно соединение.
 * Файл ложится как `localDir/<basename>`, папка — рекурсивно с сохранением
 * структуры в `localDir/<basename>/…`. Возвращает число скачанных файлов.
 */
export async function downloadRemotePaths(
  server: ServerDefinition,
  targets: DownloadTarget[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<number> {
  const port = serverPort(server);
  let done = 0;

  const emit = (message: string) => {
    onProgress?.({ uploadKey: '__quick_download__', status: 'running', message, filesDone: done });
  };

  const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || '';

  const sshT = sshTargetOf(server);
  if (sshT) {
    for (const t of targets) {
      emit(`Downloading ${baseName(t.remotePath)}…`);
      done += await rsyncPull(sshT, t.remotePath, t.localDir, signal);
    }
    return done;
  }

  if (server.protocol === 'sftp') {
    const c = new SftpClient();
    const onAbort = () => { c.end().catch(() => undefined); };
    signal?.addEventListener('abort', onAbort);
    try {
      await c.connect({ host: server.host, port, username: server.user, password: server.password, readyTimeout: 30_000 });
      const pull = async (remote: string, localDir: string): Promise<void> => {
        if (signal?.aborted) throw new Error('Cancelled');
        const type = await c.exists(remote);
        if (!type) throw new Error(`not found on server: ${remote}`);
        if (type === 'd') {
          const dest = path.join(localDir, baseName(remote));
          await fs.promises.mkdir(dest, { recursive: true });
          for (const e of await c.list(remote)) {
            await pull(`${remote.replace(/\/+$/, '')}/${e.name}`, dest);
          }
          return;
        }
        await fs.promises.mkdir(localDir, { recursive: true });
        const dest = path.join(localDir, baseName(remote));
        emit(`Downloading ${baseName(remote)}…`);
        await c.fastGet(remote, dest);
        done += 1;
      };
      for (const t of targets) await pull(t.remotePath, t.localDir);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await c.end().catch(() => undefined);
    }
    return done;
  }

  const c = new ftp.Client(30_000);
  c.ftp.verbose = false;
  const onAbort = () => c.close();
  signal?.addEventListener('abort', onAbort);
  try {
    await c.access({ host: server.host, port, user: server.user, password: server.password, secure: server.protocol === 'ftps' });
    const pull = async (remote: string, localDir: string): Promise<void> => {
      if (signal?.aborted) throw new Error('Cancelled');
      const parent = posixDirname(remote) || '/';
      const name = baseName(remote);
      let entry: ftp.FileInfo | undefined;
      try {
        entry = (await c.list(parent)).find((e) => e.name === name);
      } catch { /* родителя нет */ }
      if (!entry) throw new Error(`not found on server: ${remote}`);
      if (entry.isDirectory) {
        const dest = path.join(localDir, name);
        await fs.promises.mkdir(dest, { recursive: true });
        for (const e of await c.list(remote)) {
          await pull(`${remote.replace(/\/+$/, '')}/${e.name}`, dest);
        }
        return;
      }
      await fs.promises.mkdir(localDir, { recursive: true });
      emit(`Downloading ${name}…`);
      await c.downloadTo(path.join(localDir, name), remote);
      done += 1;
    };
    for (const t of targets) await pull(t.remotePath, t.localDir);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    c.close();
  }
  return done;
}

/**
 * Разовая заливка списка файлов в remoteDir. Каждый файл ложится в
 * `remoteDir/<remoteRel>`; недостающие директории создаются. Прогресс — по
 * завершённым файлам. Возвращает число залитых файлов.
 */
export async function uploadFilesTo(
  server: ServerDefinition,
  files: QuickFile[],
  remoteDir: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<number> {
  const port = serverPort(server);
  const total = files.length;
  const totalBytes = files.reduce((s, f) => s + safeSize(f.localAbs), 0);
  let done = 0;
  let doneBytes = 0;
  const startedAt = Date.now();

  const emit = (p: Partial<UploadProgress> & { status: UploadStatus }) => {
    if (!onProgress) return;
    onProgress({
      uploadKey: '__quick__',
      bytesTotal: totalBytes,
      filesTotal: total,
      ...p,
    });
  };

  const progress = (currentFile?: string) => {
    const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
    emit({
      status: 'running',
      currentFile,
      filesDone: done,
      bytes: doneBytes,
      percent: total > 0 ? (done / total) * 100 : 0,
      speedBps: doneBytes / elapsed,
    });
  };

  emit({ status: 'connecting', message: `Connecting to ${server.host}…` });

  const sshT = sshTargetOf(server);
  if (sshT) {
    let viaSsh = false;
    const release = await acquireSshSlot(sshT, signal);
    try {
      const res = await rsyncPush(
        sshT,
        files.map((f) => ({ localAbs: f.localAbs, remoteRel: f.remoteRel })),
        remoteDir,
        {},
        (p) => emit({ status: 'running', currentFile: p.currentFile, filesDone: p.filesDone, bytes: p.bytes, percent: p.percent, speedBps: p.speedBps }),
        signal
      );
      done = total;
      emit({ status: 'done', filesDone: done, filesTotal: total, bytes: res.bytes, percent: 100, message: `rsync: ${res.filesTransferred} changed of ${total} file(s)` });
      viaSsh = true;
    } catch (e) {
      if (!(e instanceof SshError && e.connection && sshT.fallbackToFtp && server.protocol !== 'ssh')) throw e;
    } finally {
      release();
    }
    if (viaSsh) return done;
  }

  if (server.protocol === 'sftp') {
    const c = new SftpClient();
    const onAbort = () => { c.end().catch(() => undefined); };
    signal?.addEventListener('abort', onAbort);
    try {
      await c.connect({ host: server.host, port, username: server.user, password: server.password, readyTimeout: 30_000 });
      const ensured = new Set<string>();
      for (const f of files) {
        if (signal?.aborted) throw new Error('Cancelled');
        const remotePath = joinRemote(remoteDir, f.remoteRel);
        const parent = posixDirname(remotePath);
        if (parent && !ensured.has(parent)) {
          await c.mkdir(parent, true).catch(() => undefined);
          ensured.add(parent);
        }
        await c.fastPut(f.localAbs, remotePath);
        done += 1;
        doneBytes += safeSize(f.localAbs);
        progress(f.remoteRel);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await c.end().catch(() => undefined);
    }
  } else {
    const c = new ftp.Client(30_000);
    c.ftp.verbose = false;
    const onAbort = () => c.close();
    signal?.addEventListener('abort', onAbort);
    try {
      await c.access({ host: server.host, port, user: server.user, password: server.password, secure: server.protocol === 'ftps' });
      const ensured = new Set<string>();
      for (const f of files) {
        if (signal?.aborted) throw new Error('Cancelled');
        const remotePath = joinRemote(remoteDir, f.remoteRel);
        const parent = posixDirname(remotePath);
        if (parent && parent !== '/' && parent !== '.' && !ensured.has(parent)) {
          await c.ensureDir(parent).catch(() => undefined);
          await c.cd('/').catch(() => undefined);
          ensured.add(parent);
        }
        await c.uploadFrom(f.localAbs, remotePath);
        done += 1;
        doneBytes += safeSize(f.localAbs);
        progress(f.remoteRel);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      c.close();
    }
  }

  emit({ status: 'done', filesDone: done, filesTotal: total, percent: 100, message: `Uploaded ${done} file${done === 1 ? '' : 's'}` });
  return done;
}
