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

      if (upload.protocol === 'sftp') {
        await this._runSftp(upload, password, items, emit, ctrl.signal);
      } else {
        await this._runFtp(upload, password, items, emit, ctrl.signal);
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

  private async _runFtp(
    upload: ResolvedUpload,
    password: string,
    items: ResolvedItem[],
    emit: (p: Partial<UploadProgress> & { status: UploadStatus }) => void,
    signal: AbortSignal
  ): Promise<void> {
    const client = new ftp.Client(30_000);
    client.ftp.verbose = false;

    const onAbort = () => client.close();
    signal.addEventListener('abort', onAbort);

    try {
      await client.access({
        host: upload.host,
        port: upload.port,
        user: upload.user,
        password,
        secure: upload.protocol === 'ftps',
      });

      const totalBytes = items.reduce((sum, it) => sum + safeSize(it.absolutePath), 0);
      let transferredBefore = 0;
      let filesDone = 0;
      const filesTotal = items.length;
      const startedAt = Date.now();
      let currentName = '';

      client.trackProgress((info) => {
        if (signal.aborted) return;
        const totalNow = transferredBefore + info.bytes;
        const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
        emit({
          status: 'running',
          currentFile: currentName,
          bytes: totalNow,
          bytesTotal: totalBytes,
          filesDone,
          filesTotal,
          percent: totalBytes > 0 ? Math.min(100, (totalNow / totalBytes) * 100) : undefined,
          speedBps: totalNow / elapsed,
        });
      });

      for (const item of items) {
        if (signal.aborted) throw new Error('Cancelled');
        currentName = item.relativeFromBase;
        const remotePath = joinRemote(upload.remoteDir, item.relativeFromBase);
        const remoteDir = posixDirname(remotePath);
        if (remoteDir && remoteDir !== '/' && remoteDir !== '.') {
          await client.ensureDir(remoteDir);
          await client.cd('/');
        }
        await client.uploadFrom(item.absolutePath, remotePath);
        transferredBefore += safeSize(item.absolutePath);
        filesDone += 1;
      }

      const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
      emit({
        status: 'done',
        message: `Uploaded ${filesDone} file(s), ${formatBytes(transferredBefore)} in ${elapsed.toFixed(1)}s`,
        bytes: transferredBefore,
        bytesTotal: totalBytes,
        filesDone,
        filesTotal,
        percent: 100,
        speedBps: transferredBefore / elapsed,
        finishedAt: Date.now(),
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
      client.close();
    }
  }

  private async _runSftp(
    upload: ResolvedUpload,
    password: string,
    items: ResolvedItem[],
    emit: (p: Partial<UploadProgress> & { status: UploadStatus }) => void,
    signal: AbortSignal
  ): Promise<void> {
    const sftp = new SftpClient();
    const onAbort = () => {
      sftp.end().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort);

    try {
      await sftp.connect({
        host: upload.host,
        port: upload.port,
        username: upload.user,
        password,
        readyTimeout: 30_000,
      });

      const totalBytes = items.reduce((sum, it) => sum + safeSize(it.absolutePath), 0);
      let transferredBefore = 0;
      let filesDone = 0;
      const filesTotal = items.length;
      const startedAt = Date.now();
      const remoteDirsCreated = new Set<string>();

      for (const item of items) {
        if (signal.aborted) throw new Error('Cancelled');
        const remotePath = joinRemote(upload.remoteDir, item.relativeFromBase);
        const remoteDir = posixDirname(remotePath);
        if (remoteDir && !remoteDirsCreated.has(remoteDir)) {
          try {
            await sftp.mkdir(remoteDir, true);
          } catch {
            /* dir may already exist */
          }
          remoteDirsCreated.add(remoteDir);
        }

        const fileSize = safeSize(item.absolutePath);
        let lastEmit = 0;
        await sftp.fastPut(item.absolutePath, remotePath, {
          step: (totalTransferred: number) => {
            const now = Date.now();
            if (now - lastEmit < 100) return;
            lastEmit = now;
            const totalNow = transferredBefore + totalTransferred;
            const elapsed = Math.max(1, (now - startedAt) / 1000);
            emit({
              status: 'running',
              currentFile: item.relativeFromBase,
              bytes: totalNow,
              bytesTotal: totalBytes,
              filesDone,
              filesTotal,
              percent: totalBytes > 0 ? Math.min(100, (totalNow / totalBytes) * 100) : undefined,
              speedBps: totalNow / elapsed,
            });
          },
        });
        transferredBefore += fileSize;
        filesDone += 1;
      }

      const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
      emit({
        status: 'done',
        message: `Uploaded ${filesDone} file(s), ${formatBytes(transferredBefore)} in ${elapsed.toFixed(1)}s`,
        bytes: transferredBefore,
        bytesTotal: totalBytes,
        filesDone,
        filesTotal,
        percent: 100,
        speedBps: transferredBefore / elapsed,
        finishedAt: Date.now(),
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        await sftp.end();
      } catch {
        /* ignore */
      }
    }
  }
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
