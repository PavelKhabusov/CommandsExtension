import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { ServerDefinition, SshTarget } from './uploadsTypes';
import { explainSshFailure } from './sqlConsole';

export function sshTargetOf(server: Partial<ServerDefinition>): SshTarget | null {
  const viaSsh = server.protocol === 'ssh' || server.uploadVia === 'ssh';
  if (!viaSsh) return null;
  const ssh = server.ssh ?? {};
  const host = ssh.host || server.sql?.sshHost || server.host;
  const user = ssh.user || server.sql?.sshUser || server.user;
  if (!host || !user) return null;
  const port = ssh.port ?? server.sql?.sshPort ?? (server.protocol === 'ssh' ? server.port ?? 22 : 22);
  return {
    host,
    user,
    port,
    root: ssh.root || (server.protocol === 'ssh' ? '/' : '~'),
    maxParallel: Math.max(1, Math.floor(ssh.maxParallel ?? 3)),
    fallbackToFtp: ssh.fallbackToFtp === true,
  };
}

/** Maps a config path (remoteDir / spec path) to the path used over SSH. */
export function sshPath(t: SshTarget, p: string): string {
  const rel = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (t.root === '~') return rel || '.';
  const root = t.root.replace(/\/+$/, '');
  return rel ? `${root}/${rel}` : root || '/';
}

export class SshError extends Error {
  constructor(message: string, public readonly connection: boolean) {
    super(message);
  }
}

const SSH_NOISE =
  /post-quantum|store now, decrypt later|may need to be upgraded|^\*\*|Welcome to|^Warning: Permanently added/;

function cleanErr(err: string): string {
  return err.split('\n').filter((l) => l.trim() && !SSH_NOISE.test(l)).join('\n');
}

function login(t: SshTarget): string {
  return `${t.user}@${t.host}`;
}

function explain(t: SshTarget, raw: string, code: number | null): SshError {
  const hint = explainSshFailure({ sshHost: t.host, sshUser: t.user, sshPort: t.port }, raw);
  const port = t.port !== 22 ? ` -p ${t.port}` : '';
  let extra = hint;
  if (!extra && /rsync: (command )?not found|rsync: not found/i.test(raw)) {
    extra = `rsync is missing on the server.\n\nCheck:  ssh${port} ${login(t)} 'which rsync'`;
  }
  const connection = !!hint || code === 255;
  return new SshError(extra ? `${raw}\n\n${extra}` : raw, connection);
}

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sshOptions(t: SshTarget): string[] {
  return [
    '-p', String(t.port),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30',
    '-o', 'LogLevel=ERROR',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${path.join(os.tmpdir(), 'ce-ssh-%C')}`,
    '-o', 'ControlPersist=60',
  ];
}

function rsyncBinary(): string {
  return vscode.workspace.getConfiguration('commandsExtension').get<string>('rsyncPath') || 'rsync';
}

interface ExecResult {
  code: number | null;
  out: string;
  err: string;
}

function exec(
  cmd: string,
  args: string[],
  opts: { stdin?: string | Buffer; signal?: AbortSignal; onStdout?: (chunk: string) => void } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('Cancelled'));
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill('SIGTERM');
    };
    opts.signal?.addEventListener('abort', onAbort);
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      if (opts.onStdout) opts.onStdout(s);
      else out += s;
    });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new SshError(
        e.code === 'ENOENT'
          ? `${cmd} is not installed locally. Install it (e.g. "sudo pacman -S ${path.basename(cmd)}") or set commandsExtension.rsyncPath.`
          : `Could not start ${cmd}: ${e.message}`,
        false
      ));
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) reject(new Error('Cancelled'));
      else resolve({ code, out, err });
    });
    child.stdin.on('error', () => undefined);
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/** Runs a shell script on the server; throws an explained SshError on failure. */
export async function sshRun(t: SshTarget, script: string, signal?: AbortSignal, stdin?: string | Buffer): Promise<string> {
  const args = [...sshOptions(t), '-T', login(t), script];
  const r = await exec('ssh', args, { stdin, signal });
  if (r.code !== 0) throw explain(t, cleanErr(r.err) || `ssh exited with code ${r.code}`, r.code);
  return r.out;
}

export interface RsyncFile {
  localAbs: string;
  /** Path under remoteDir (posix); absolute when remoteDir is empty. */
  remoteRel: string;
}

export interface RsyncProgress {
  bytes: number;
  percent: number;
  speedBps: number;
  filesDone: number;
  currentFile?: string;
}

export interface RsyncResult {
  filesTransferred: number;
  bytes: number;
}

const UNITS: Record<string, number> = { B: 1, kB: 1024, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
const PROGRESS_RE = /^\s*([\d,.]+)\s+(\d+)%\s+([\d.]+)([kKMGT]?B)\/s\s+\S+/;

/**
 * Pushes files with one rsync run. A staging dir of symlinks mirrors the remote
 * layout, so files from anywhere land at arbitrary remote paths in one pass.
 */
export async function rsyncPush(
  t: SshTarget,
  files: RsyncFile[],
  remoteDir: string,
  opts: { ignoreExisting?: boolean },
  onProgress: (p: RsyncProgress) => void,
  signal?: AbortSignal
): Promise<RsyncResult> {
  if (files.length === 0) return { filesTransferred: 0, bytes: 0 };
  const dest = sshPath(t, remoteDir) + '/';
  const stage = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ce-rsync-'));
  try {
    const rels: string[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const rel = f.remoteRel.replace(/\\/g, '/').replace(/^\.?\/+/, '');
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      const link = path.join(stage, rel);
      await fs.promises.mkdir(path.dirname(link), { recursive: true });
      await fs.promises.symlink(f.localAbs, link);
      rels.push(rel);
    }
    const listFile = path.join(stage, '.ce-files');
    await fs.promises.writeFile(listFile, rels.join('\0'));

    const args = [
      '-rtzL',
      '--mkpath',
      '--no-implied-dirs',
      '--from0',
      `--files-from=${listFile}`,
      '--info=progress2',
      '--out-format=%n',
      '--exclude=.ce-files',
      ...(opts.ignoreExisting ? ['--ignore-existing'] : []),
      '-e', ['ssh', ...sshOptions(t)].map((a) => (/[\s'"]/.test(a) ? sq(a) : a)).join(' '),
      stage + '/',
      `${login(t)}:${dest}`,
    ];

    let filesDone = 0;
    let bytes = 0;
    let pending = '';
    let current: string | undefined;
    const handleLine = (line: string) => {
      const m = line.match(PROGRESS_RE);
      if (m) {
        bytes = Number(m[1].replace(/[,.]/g, ''));
        onProgress({
          bytes,
          percent: Number(m[2]),
          speedBps: Number(m[3]) * (UNITS[m[4]] ?? 1),
          filesDone,
          currentFile: current,
        });
        return;
      }
      const name = line.trim();
      if (!name || name.endsWith('/')) return;
      filesDone += 1;
      current = name;
    };

    const r = await exec(rsyncBinary(), args, {
      signal,
      onStdout: (chunk) => {
        pending += chunk;
        const parts = pending.split(/[\r\n]/);
        pending = parts.pop() ?? '';
        parts.forEach(handleLine);
      },
    });
    if (pending) handleLine(pending);
    if (r.code !== 0) {
      throw explain(t, cleanErr(r.err) || `rsync exited with code ${r.code}`, r.code === 255 || r.code === 12 ? 255 : r.code);
    }
    return { filesTransferred: filesDone, bytes };
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface SshRemoteEntry {
  rel: string;
  isDir: boolean;
  size: number;
}

/** Everything under base (files and dirs, relative paths); empty when base is missing. */
export async function sshScanTree(t: SshTarget, remoteDir: string, signal?: AbortSignal, prune: string[] = []): Promise<SshRemoteEntry[]> {
  const base = sshPath(t, remoteDir);
  const pruneExpr = prune.map((p) => `-path ${sq(base.replace(/\/+$/, '') + '/' + p)} -prune -o `).join('');
  const out = await sshRun(
    t,
    `[ -d ${sq(base)} ] || exit 0; find ${sq(base)} -mindepth 1 ${pruneExpr}\\( -type f -o -type d \\) -printf '%y %s %P\\0'`,
    signal
  );
  const entries: SshRemoteEntry[] = [];
  for (const rec of out.split('\0')) {
    const m = rec.match(/^([fd]) (\d+) (.+)$/s);
    if (m) entries.push({ rel: m[3], isDir: m[1] === 'd', size: Number(m[2]) });
  }
  return entries;
}

/** Removes files, then empty dirs (deepest first), relative to base. Returns files removed. */
export async function sshRemoveUnder(
  t: SshTarget,
  remoteDir: string,
  files: string[],
  dirs: string[],
  signal?: AbortSignal
): Promise<number> {
  const base = sshPath(t, remoteDir);
  let removed = 0;
  if (files.length) {
    const out = await sshRun(t, `cd ${sq(base)} && xargs -0 -r rm -fv -- | wc -l`, signal, files.join('\0'));
    removed = Number(out.trim()) || 0;
  }
  if (dirs.length) {
    await sshRun(t, `cd ${sq(base)} && xargs -0 -r rmdir -- 2>/dev/null; true`, signal, dirs.join('\0'));
  }
  return removed;
}

/** rm -rf for each path; missing ones are skipped. Returns how many existed. */
export async function sshDeletePaths(t: SshTarget, targets: string[], signal?: AbortSignal): Promise<number> {
  if (targets.length === 0) return 0;
  const out = await sshRun(
    t,
    `n=0; for p in ${targets.map((x) => sq(sshPath(t, x))).join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then rm -rf -- "$p" && n=$((n+1)); fi; done; echo $n`,
    signal
  );
  return Number(out.trim()) || 0;
}

export async function sshListDir(t: SshTarget, dir: string): Promise<{ name: string; isDir: boolean; size: number }[]> {
  const out = await sshRun(t, `find ${sq(sshPath(t, dir))} -mindepth 1 -maxdepth 1 -printf '%y %s %f\\0'`);
  const list: { name: string; isDir: boolean; size: number }[] = [];
  for (const rec of out.split('\0')) {
    const m = rec.match(/^(\S) (\d+) (.+)$/s);
    if (m) list.push({ name: m[3], isDir: m[1] === 'd', size: Number(m[2]) });
  }
  return list;
}

export async function sshMkdir(t: SshTarget, dir: string): Promise<void> {
  await sshRun(t, `mkdir -p -- ${sq(sshPath(t, dir))}`);
}

export async function sshStat(t: SshTarget, target: string): Promise<{ exists: boolean; isDir: boolean; fileCount: number }> {
  const out = await sshRun(
    t,
    `p=${sq(sshPath(t, target))}; if [ -d "$p" ]; then echo "d $(find "$p" -type f | wc -l)"; elif [ -e "$p" ]; then echo f; else echo none; fi`
  );
  const s = out.trim();
  if (s.startsWith('d ')) return { exists: true, isDir: true, fileCount: Number(s.slice(2)) || 0 };
  if (s === 'f') return { exists: true, isDir: false, fileCount: 1 };
  return { exists: false, isDir: false, fileCount: 0 };
}

/** Pulls a remote file or folder into localDir/<basename>. Returns files received. */
export async function rsyncPull(t: SshTarget, remotePath: string, localDir: string, signal?: AbortSignal): Promise<number> {
  await fs.promises.mkdir(localDir, { recursive: true });
  const args = [
    '-rtz',
    '--out-format=%n',
    '-e', ['ssh', ...sshOptions(t)].map((a) => (/[\s'"]/.test(a) ? sq(a) : a)).join(' '),
    `${login(t)}:${sshPath(t, remotePath)}`,
    localDir.replace(/\/+$/, '') + '/',
  ];
  const r = await exec(rsyncBinary(), args, { signal });
  if (r.code !== 0) throw explain(t, cleanErr(r.err) || `rsync exited with code ${r.code}`, r.code === 255 || r.code === 12 ? 255 : r.code);
  return r.out.split('\n').filter((l) => l.trim() && !l.endsWith('/')).length;
}

const slots = new Map<string, { active: number; queue: (() => void)[] }>();

/** Per-server limit of concurrent rsync uploads (SshTarget.maxParallel). */
export async function acquireSshSlot(t: SshTarget, signal?: AbortSignal): Promise<() => void> {
  const key = `${t.user}@${t.host}:${t.port}`;
  let s = slots.get(key);
  if (!s) { s = { active: 0, queue: [] }; slots.set(key, s); }
  const st = s;
  if (st.active < t.maxParallel) st.active += 1;
  else {
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        const i = st.queue.indexOf(go);
        if (i >= 0) st.queue.splice(i, 1);
        reject(new Error('Cancelled'));
      };
      signal?.addEventListener('abort', abort);
      st.queue.push(go);
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = st.queue.shift();
    if (next) next();
    else st.active -= 1;
  };
}
