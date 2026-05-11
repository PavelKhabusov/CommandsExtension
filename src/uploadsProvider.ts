import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { UploadDefinition, UploadGroup, UploadProtocol, ServerDefinition, ResolvedUpload } from './uploadsTypes';

interface UploadsJsonSchema {
  servers?: ServerDefinition[];
  uploads: UploadDefinition[];
}

function safeParseJson<T>(raw: string, filePath: string): T | null {
  const stripped = raw.replace(/,\s*([\]}])/g, '$1');
  try {
    return JSON.parse(stripped) as T;
  } catch (e) {
    vscode.window.showWarningMessage(
      `Commands Extension: invalid JSON in ${path.basename(filePath)}: ${e instanceof Error ? e.message : e}`
    );
    return null;
  }
}

function defaultPort(protocol: UploadProtocol): number {
  return protocol === 'sftp' ? 22 : 21;
}

export function resolveServer(
  upload: UploadDefinition,
  servers: ServerDefinition[]
): ResolvedUpload | null {
  let base: Partial<ServerDefinition> = {};
  if (upload.server) {
    const ref = servers.find((s) => s.name === upload.server);
    if (!ref) return null;
    base = ref;
  }

  const protocol = upload.protocol ?? base.protocol;
  const host = upload.host ?? base.host;
  const user = upload.user ?? base.user;
  if (!protocol || !host || !user) return null;

  const port = upload.port ?? base.port ?? defaultPort(protocol);
  const password = upload.password ?? base.password;

  return {
    name: upload.name,
    group: upload.group || 'Uploads',
    protocol,
    host,
    port,
    user,
    password,
    remoteDir: upload.remoteDir,
    items: upload.items,
    exclude: upload.exclude || [],
    onExists: upload.onExists,
  };
}

interface LoadResult {
  groups: UploadGroup[];
  servers: ServerDefinition[];
}

export async function loadUploads(workspaceRoot: string, configFileName: string): Promise<LoadResult> {
  const filePath = path.join(workspaceRoot, configFileName);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return { groups: [], servers: [] };
  }

  const parsed = safeParseJson<UploadsJsonSchema>(raw, filePath);
  if (!parsed || !Array.isArray(parsed.uploads)) return { groups: [], servers: [] };

  const servers: ServerDefinition[] = Array.isArray(parsed.servers) ? parsed.servers.filter(isValidServer) : [];

  const uploads: UploadDefinition[] = parsed.uploads.filter(isValidUpload).map((u) => ({
    name: u.name,
    group: u.group || 'Uploads',
    server: u.server,
    protocol: u.protocol,
    host: u.host,
    port: u.port,
    user: u.user,
    password: u.password,
    remoteDir: u.remoteDir,
    items: u.items,
    exclude: u.exclude,
    onExists: u.onExists,
  }));

  const groupMap = new Map<string, UploadDefinition[]>();
  for (const u of uploads) {
    const g = u.group || 'Uploads';
    const arr = groupMap.get(g);
    if (arr) arr.push(u);
    else groupMap.set(g, [u]);
  }
  const groups: UploadGroup[] = [];
  for (const [name, list] of groupMap) groups.push({ name, uploads: list });
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return { groups, servers };
}

function isValidServer(s: unknown): s is ServerDefinition {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    typeof o.host === 'string' &&
    typeof o.user === 'string' &&
    (o.protocol === 'ftp' || o.protocol === 'ftps' || o.protocol === 'sftp')
  );
}

function isValidUpload(u: unknown): u is UploadDefinition {
  if (!u || typeof u !== 'object') return false;
  const o = u as Record<string, unknown>;
  if (typeof o.name !== 'string') return false;
  if (typeof o.remoteDir !== 'string') return false;
  if (!Array.isArray(o.items)) return false;
  // Either references a server, or has its own host/user/protocol
  const hasServerRef = typeof o.server === 'string' && o.server.length > 0;
  const hasInline =
    typeof o.host === 'string' &&
    typeof o.user === 'string' &&
    (o.protocol === 'ftp' || o.protocol === 'ftps' || o.protocol === 'sftp');
  return hasServerRef || hasInline;
}

export function uploadKey(u: UploadDefinition): string {
  return `${u.group || 'Uploads'}:${u.name}`;
}

export interface ResolvedItem {
  type: 'file' | 'dir';
  absolutePath: string;
  relativeFromBase: string;
  baseDir: string;
}

async function statSafe(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

export function globToRegex(rawGlob: string): RegExp {
  let glob = rawGlob.replace(/^\.\//, '');
  if (glob.startsWith('/')) glob = glob.substring(1);
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

export function isExcluded(relPath: string, excludePatterns: RegExp[]): boolean {
  if (excludePatterns.length === 0) return false;
  const candidates = [relPath, '/' + relPath];
  for (const re of excludePatterns) {
    for (const c of candidates) {
      if (re.test(c)) return true;
    }
  }
  return false;
}

async function walkDir(
  dirPath: string,
  baseDir: string,
  excludeRegexes: RegExp[],
  out: ResolvedItem[]
): Promise<void> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    const rel = path.relative(baseDir, abs).split(path.sep).join('/');
    if (isExcluded(rel, excludeRegexes)) continue;
    if (entry.isDirectory()) {
      await walkDir(abs, baseDir, excludeRegexes, out);
    } else if (entry.isFile()) {
      out.push({
        type: 'file',
        absolutePath: abs,
        relativeFromBase: rel,
        baseDir,
      });
    }
  }
}

export function isPathInUploadScope(
  absPath: string,
  workspaceRoot: string,
  items: string[],
  exclude: string[] = []
): boolean {
  const sepNorm = (s: string) => s.split(path.sep).join('/');
  const relFromWs = sepNorm(path.relative(workspaceRoot, absPath));
  if (relFromWs.startsWith('..')) return false;

  const excludeRegexes = exclude.map(globToRegex);

  for (const raw of items) {
    if (!raw || typeof raw !== 'string') continue;

    if (raw.includes('*')) {
      const cleaned = raw.replace(/^\.\//, '').replace(/^\//, '');
      const re = globToRegex(cleaned);
      if (re.test(relFromWs) && !isExcluded(relFromWs, excludeRegexes)) return true;
      continue;
    }

    const absBase = path.isAbsolute(raw) ? raw : path.join(workspaceRoot, raw);
    if (absPath === absBase) {
      if (!isExcluded(path.basename(absPath), excludeRegexes)) return true;
      continue;
    }
    const baseWithSep = absBase.endsWith(path.sep) ? absBase : absBase + path.sep;
    if (absPath.startsWith(baseWithSep)) {
      const relFromBase = sepNorm(path.relative(absBase, absPath));
      if (!isExcluded(relFromBase, excludeRegexes)) return true;
    }
  }
  return false;
}

export async function resolveItems(
  workspaceRoot: string,
  items: string[],
  excludePatterns: string[] = []
): Promise<ResolvedItem[]> {
  const out: ResolvedItem[] = [];
  const excludeRegexes = excludePatterns.map(globToRegex);

  for (const raw of items) {
    if (!raw || typeof raw !== 'string') continue;

    if (raw.includes('*')) {
      const matches = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceRoot, raw),
        '**/node_modules/**'
      );
      for (const uri of matches) {
        const abs = uri.fsPath;
        const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
        if (isExcluded(rel, excludeRegexes)) continue;
        out.push({
          type: 'file',
          absolutePath: abs,
          relativeFromBase: path.basename(abs),
          baseDir: path.dirname(abs),
        });
      }
      continue;
    }

    const abs = path.isAbsolute(raw) ? raw : path.join(workspaceRoot, raw);
    const stat = await statSafe(abs);
    if (!stat) continue;

    if (stat.isFile()) {
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
      if (isExcluded(rel, excludeRegexes)) continue;
      out.push({
        type: 'file',
        absolutePath: abs,
        relativeFromBase: path.basename(abs),
        baseDir: path.dirname(abs),
      });
    } else if (stat.isDirectory()) {
      await walkDir(abs, abs, excludeRegexes, out);
    }
  }

  return out;
}

export async function pickFilesAndAppend(workspaceRoot: string): Promise<string[]> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    defaultUri: vscode.Uri.file(workspaceRoot),
    openLabel: 'Add to upload',
    title: 'Pick files or folders to upload',
  });
  if (!picked) return [];

  const result: string[] = [];
  for (const uri of picked) {
    const abs = uri.fsPath;
    const rel = path.relative(workspaceRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      result.push(abs);
    } else {
      result.push('./' + rel.split(path.sep).join('/'));
    }
  }
  return result;
}

export async function addUploadItems(
  workspaceRoot: string,
  configFileName: string,
  uploadName: string,
  groupName: string,
  newItems: string[]
): Promise<void> {
  if (newItems.length === 0) return;
  await mutateUpload(workspaceRoot, configFileName, uploadName, groupName, (target) => {
    const set = new Set(target.items);
    for (const it of newItems) set.add(it);
    target.items = Array.from(set);
  });
}

export async function addUploadExcludes(
  workspaceRoot: string,
  configFileName: string,
  uploadName: string,
  groupName: string,
  newExcludes: string[]
): Promise<void> {
  if (newExcludes.length === 0) return;
  await mutateUpload(workspaceRoot, configFileName, uploadName, groupName, (target) => {
    const set = new Set(target.exclude || []);
    for (const it of newExcludes) set.add(it);
    target.exclude = Array.from(set);
  });
}

async function mutateUpload(
  workspaceRoot: string,
  configFileName: string,
  uploadName: string,
  groupName: string,
  fn: (target: UploadDefinition) => void
): Promise<void> {
  const filePath = path.join(workspaceRoot, configFileName);
  let data: UploadsJsonSchema | null = null;
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    data = safeParseJson<UploadsJsonSchema>(raw, filePath);
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.uploads)) return;

  const target = data.uploads.find(
    (u) => u.name === uploadName && (u.group || 'Uploads') === groupName
  );
  if (!target) return;

  fn(target);

  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function pickExcludePatternsForUpload(
  workspaceRoot: string,
  upload: UploadDefinition
): Promise<string[]> {
  const itemBases = (upload.items || [])
    .filter((it) => !it.includes('*'))
    .map((it) => path.isAbsolute(it) ? it : path.join(workspaceRoot, it));

  const defaultUri = itemBases.length > 0
    ? vscode.Uri.file(itemBases[0])
    : vscode.Uri.file(workspaceRoot);

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    defaultUri,
    openLabel: 'Exclude from upload',
    title: 'Pick files or folders to exclude',
  });
  if (!picked) return [];

  const patterns: string[] = [];
  for (const uri of picked) {
    const abs = uri.fsPath;
    const base = itemBases.find((b) => abs === b || abs.startsWith(b + path.sep));
    let rel: string;
    if (base) {
      rel = path.relative(base, abs);
    } else {
      rel = path.relative(workspaceRoot, abs);
    }
    if (!rel || rel === '') continue;
    rel = rel.split(path.sep).join('/');

    let stat: fs.Stats | null = null;
    try { stat = await fs.promises.stat(abs); } catch { /* skip */ }
    if (stat && stat.isDirectory()) {
      patterns.push(rel);
      patterns.push(rel + '/**');
    } else {
      patterns.push(rel);
    }
  }
  return patterns;
}

export async function ensureUploadsFile(
  workspaceRoot: string,
  configFileName: string
): Promise<vscode.Uri> {
  const filePath = path.join(workspaceRoot, configFileName);
  if (!(await statSafe(filePath))) {
    const template = {
      servers: [
        {
          name: 'main',
          protocol: 'ftp' as UploadProtocol,
          host: 'example.com',
          port: 21,
          user: 'username',
          password: 'password-here',
        },
      ],
      uploads: [
        {
          name: 'Theme → prod',
          group: 'Uploads',
          server: 'main',
          remoteDir: '/public_html/',
          items: ['./dist/'],
          exclude: ['**/node_modules/**', '**/*.log'],
          onExists: 'overwrite' as const,
        },
      ],
    };
    await fs.promises.writeFile(filePath, JSON.stringify(template, null, 2), 'utf-8');
  }
  return vscode.Uri.file(filePath);
}
