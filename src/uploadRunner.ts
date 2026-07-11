import * as fs from 'fs';
import * as http from 'http';
import * as vscode from 'vscode';
import * as ftp from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { ResolvedUpload, UploadProgress, UploadStatus } from './uploadsTypes';
import { resolveItems, ResolvedItem } from './uploadsProvider';

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

/** Отбрасывает из заливки файлы, чей размер на сервере совпал (skipUnchanged-глобы). */
function filterUnchanged(
  items: ResolvedItem[],
  remote: RemoteEntry[] | null,
  skipGlobs: RegExp[]
): { toUpload: ResolvedItem[]; skipped: number } {
  if (!remote || skipGlobs.length === 0) return { toUpload: items, skipped: 0 };
  const remoteSizes = new Map<string, number>();
  for (const e of remote) if (!e.isDir) remoteSizes.set(e.rel, e.size);
  const toUpload: ResolvedItem[] = [];
  let skipped = 0;
  for (const it of items) {
    const rel = normalizeRel(it.relativeFromBase);
    if (matchesAny(rel, skipGlobs) && remoteSizes.get(rel) === safeSize(it.absolutePath)) {
      skipped += 1;
    } else {
      toUpload.push(it);
    }
  }
  return { toUpload, skipped };
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

  public async run(workspaceRoot: string, upload: ResolvedUpload, fileFilter?: Set<string>): Promise<void> {
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

      let password = upload.password;
      if (!password) {
        password = await vscode.window.showInputBox({
          title: `Password for ${upload.user}@${upload.host}`,
          prompt: `${upload.protocol.toUpperCase()} password — not stored, will be asked again`,
          password: true,
          ignoreFocusOut: true,
        });
        if (!password) {
          emit({ status: 'cancelled', message: 'Password not provided', finishedAt: Date.now() });
          return;
        }
      }

      emit({ status: 'connecting', message: 'Preparing network…' });
      await prepareUpload(key, workspaceRoot);

      emit({ status: 'connecting', message: `Connecting to ${upload.host}…` });

      // Mirror-очистка только при полной заливке: частичная (fileFilter)
      // не знает полного локального состава и удалять ничего не должна.
      const mirror = upload.mode === 'mirror' && !fileFilter;

      if (upload.protocol === 'sftp') {
        await this._runSftp(upload, password, items, emit, ctrl.signal, mirror);
      } else {
        await this._runFtp(upload, password, items, emit, ctrl.signal, mirror);
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

  // ------------------------------------------------------------------ FTP

  private async _runFtp(
    upload: ResolvedUpload,
    password: string,
    items: ResolvedItem[],
    emit: (p: Partial<UploadProgress> & { status: UploadStatus }) => void,
    signal: AbortSignal,
    mirror = false
  ): Promise<void> {
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

      // Пре-скан сервера: нужен и для skipUnchanged, и для mirror-очистки
      let preScan: RemoteEntry[] | null = null;
      if (mirror || skipGlobs.length > 0) {
        emit({ status: 'running', message: 'Сканирую сервер…' });
        preScan = await this._scanFtp(clients[0], base, signal, (n) =>
          emit({ status: 'running', message: `Сканирую сервер… ${n} файлов` })
        );
      }

      const { toUpload, skipped } = filterUnchanged(items, preScan, skipGlobs);

      // Дополнительные соединения — только если есть что заливать параллельно
      const poolSize = Math.min(connections, Math.max(1, toUpload.length));
      while (clients.length < poolSize) {
        if (signal.aborted) throw new Error('Cancelled');
        clients.push(await openClient());
      }

      const totalBytes = toUpload.reduce((sum, it) => sum + safeSize(it.absolutePath), 0);
      const filesTotal = toUpload.length;
      const startedAt = Date.now();
      // Побайтовый прогресс: у каждого соединения свой накопитель trackProgress
      const clientBytes = new Array<number>(poolSize).fill(0);
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
        emit({
          status: 'running',
          currentFile: currentName,
          bytes: transferred,
          bytesTotal: totalBytes,
          filesDone,
          filesTotal,
          percent: totalBytes > 0 ? Math.min(100, (transferred / totalBytes) * 100) : undefined,
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
      if (mirror && preScan && !signal.aborted) {
        emit({ status: 'running', message: 'Mirror: удаляю устаревшее…', percent: 100 });
        deleted = await this._mirrorDelete(
          preScan,
          items,
          upload,
          signal,
          (rel) => clients[0].remove(`${base}/${rel}`),
          (rel) => clients[0].removeEmptyDir(`${base}/${rel}`).then(() => undefined),
          emit
        );
      }

      const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
      emit({
        status: 'done',
        message:
          `Uploaded ${filesDone} file(s), ${formatBytes(transferredTotal)} in ${elapsed.toFixed(1)}s` +
          (skipped > 0 ? `, skipped ${skipped} unchanged` : '') +
          (mirror ? `, mirror: removed ${deleted} stale` : ''),
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

  private async _scanFtp(
    client: ftp.Client,
    base: string,
    signal: AbortSignal,
    onProgress?: (found: number) => void
  ): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = [];
    let lastReport = 0;
    const walk = async (relDir: string): Promise<void> => {
      if (signal.aborted) throw new Error('Cancelled');
      let list: ftp.FileInfo[];
      try {
        list = await client.list(relDir ? `${base}/${relDir}` : base);
      } catch {
        return;
      }
      for (const fi of list) {
        if (fi.name === '.' || fi.name === '..') continue;
        const rel = relDir ? `${relDir}/${fi.name}` : fi.name;
        if (fi.isDirectory) {
          entries.push({ rel, isDir: true, size: 0 });
          await walk(rel);
        } else if (fi.isFile) {
          entries.push({ rel, isDir: false, size: fi.size });
        }
      }
      const now = Date.now();
      if (onProgress && now - lastReport > 500) {
        lastReport = now;
        onProgress(entries.length);
      }
    };
    await walk('');
    return entries;
  }

  // ------------------------------------------------------------------ SFTP

  private async _runSftp(
    upload: ResolvedUpload,
    password: string,
    items: ResolvedItem[],
    emit: (p: Partial<UploadProgress> & { status: UploadStatus }) => void,
    signal: AbortSignal,
    mirror = false
  ): Promise<void> {
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

      let preScan: RemoteEntry[] | null = null;
      if (mirror || skipGlobs.length > 0) {
        emit({ status: 'running', message: 'Сканирую сервер…' });
        preScan = await this._scanSftp(clients[0], base, signal, (n) =>
          emit({ status: 'running', message: `Сканирую сервер… ${n} файлов` })
        );
      }

      const { toUpload, skipped } = filterUnchanged(items, preScan, skipGlobs);

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
        emit({
          status: 'running',
          currentFile: currentName,
          bytes: transferred,
          bytesTotal: totalBytes,
          filesDone,
          filesTotal,
          percent: totalBytes > 0 ? Math.min(100, (transferred / totalBytes) * 100) : undefined,
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
      if (mirror && preScan && !signal.aborted) {
        emit({ status: 'running', message: 'Mirror: удаляю устаревшее…', percent: 100 });
        deleted = await this._mirrorDelete(
          preScan,
          items,
          upload,
          signal,
          (rel) => clients[0].delete(`${base}/${rel}`).then(() => undefined),
          (rel) => clients[0].rmdir(`${base}/${rel}`).then(() => undefined),
          emit
        );
      }

      const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
      emit({
        status: 'done',
        message:
          `Uploaded ${filesDone} file(s), ${formatBytes(transferredTotal)} in ${elapsed.toFixed(1)}s` +
          (skipped > 0 ? `, skipped ${skipped} unchanged` : '') +
          (mirror ? `, mirror: removed ${deleted} stale` : ''),
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

  private async _scanSftp(
    sftp: SftpClient,
    base: string,
    signal: AbortSignal,
    onProgress?: (found: number) => void
  ): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = [];
    let lastReport = 0;
    const walk = async (relDir: string): Promise<void> => {
      if (signal.aborted) throw new Error('Cancelled');
      let list: Awaited<ReturnType<SftpClient['list']>>;
      try {
        list = await sftp.list(relDir ? `${base}/${relDir}` : base);
      } catch {
        return;
      }
      for (const fi of list) {
        if (fi.name === '.' || fi.name === '..') continue;
        const rel = relDir ? `${relDir}/${fi.name}` : fi.name;
        if (fi.type === 'd') {
          entries.push({ rel, isDir: true, size: 0 });
          await walk(rel);
        } else if (fi.type === '-') {
          entries.push({ rel, isDir: false, size: fi.size });
        }
      }
      const now = Date.now();
      if (onProgress && now - lastReport > 500) {
        lastReport = now;
        onProgress(entries.length);
      }
    };
    await walk('');
    return entries;
  }

  // ------------------------------------------------------------- mirror

  /** Удаляет с сервера файлы, которых нет в локальном наборе (mode: 'mirror'). */
  private async _mirrorDelete(
    remote: RemoteEntry[],
    localItems: ResolvedItem[],
    upload: ResolvedUpload,
    signal: AbortSignal,
    removeFile: (rel: string) => Promise<unknown>,
    removeDir: (rel: string) => Promise<unknown>,
    emit: (p: Partial<UploadProgress> & { status: UploadStatus }) => void
  ): Promise<number> {
    const local = new Set(localItems.map((it) => normalizeRel(it.relativeFromBase)));
    const protect = buildProtectMatchers(upload.protectRemote);

    let deleted = 0;
    for (const e of remote) {
      if (signal.aborted) throw new Error('Cancelled');
      if (e.isDir || local.has(e.rel) || matchesAny(e.rel, protect)) continue;
      try {
        await removeFile(e.rel);
        deleted += 1;
        if (deleted % 20 === 0) {
          emit({ status: 'running', message: `Mirror: удалено ${deleted}…`, percent: 100 });
        }
      } catch {
        /* оставляем — не смогли удалить */
      }
    }

    // Пустые папки — от самых глубоких к корню; непустые просто не удалятся
    const dirs = remote.filter((e) => e.isDir).sort((a, b) => b.rel.length - a.rel.length);
    for (const d of dirs) {
      if (signal.aborted) throw new Error('Cancelled');
      if (matchesAny(d.rel, protect)) continue;
      try {
        await removeDir(d.rel);
      } catch {
        /* не пустая */
      }
    }
    return deleted;
  }
}
