import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * Manage Claude Code hooks across three settings.json files:
 *   - <workspace>/.claude/settings.json         (project, committed)
 *   - <workspace>/.claude/settings.local.json   (project, gitignored)
 *   - ~/.claude/settings.json                   (user-global)
 *
 * Each hook in Claude Code's schema looks like:
 *   "hooks": {
 *     "<EventName>": [
 *       { "matcher": "...", "hooks": [{ "type": "command", "command": "...", "timeout": 10 }] }
 *     ]
 *   }
 *
 * We flatten that for UI: one HookEntry per leaf command, identified by a
 * sha1 over (file, event, matcher, command, timeout).
 *
 * Disabled hooks are removed from settings.json and their original spec is
 * cached in workspaceState so they can be restored.
 */

export type HookEvent =
  | 'Stop'
  | 'SubagentStop'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact';

export const ALL_HOOK_EVENTS: HookEvent[] = [
  'Stop',
  'SubagentStop',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
];

export const MATCHER_EVENTS = new Set<HookEvent>(['PreToolUse', 'PostToolUse', 'Notification']);

export type HookTargetFile = 'project' | 'local' | 'user';

export interface HookEntry {
  id: string;
  event: HookEvent;
  matcher?: string;
  command: string;
  timeout?: number;
  targetFile: HookTargetFile;
  enabled: boolean;
  /** Optional metadata that helps UI render the original source (preset key,
   *  command reference). Only set for hooks created through our editor. */
  source?: {
    kind: 'preset' | 'command-ref' | 'custom';
    presetKey?: string;
    commandRef?: string;
  };
}

interface ClaudeHookLeaf {
  type: 'command';
  command: string;
  timeout?: number;
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks: ClaudeHookLeaf[];
  /** Extension-managed metadata; Claude Code ignores unknown fields. */
  _ext?: { kind: 'preset' | 'command-ref' | 'custom'; presetKey?: string; commandRef?: string };
}

interface ClaudeSettings {
  hooks?: Partial<Record<HookEvent, ClaudeHookEntry[]>>;
  [k: string]: unknown;
}

const DISABLED_STATE_KEY = 'commandsExtension.disabledClaudeHooks';

interface DisabledRecord {
  entry: HookEntry;
}

function hookFilePath(workspaceRoot: string, target: HookTargetFile): string {
  if (target === 'user') return path.join(os.homedir(), '.claude', 'settings.json');
  if (target === 'local') return path.join(workspaceRoot, '.claude', 'settings.local.json');
  return path.join(workspaceRoot, '.claude', 'settings.json');
}

export function getHookFilePaths(workspaceRoot: string): Record<HookTargetFile, string> {
  return {
    project: hookFilePath(workspaceRoot, 'project'),
    local: hookFilePath(workspaceRoot, 'local'),
    user: hookFilePath(workspaceRoot, 'user'),
  };
}

async function readSettings(filePath: string): Promise<ClaudeSettings | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return null;
  }
}

async function writeSettings(filePath: string, data: ClaudeSettings): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  // Preserve the file's existing top-level field order roughly by writing
  // hooks last; this isn't perfect but matches what most editors do.
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function hookId(target: HookTargetFile, event: HookEvent, matcher: string, command: string, timeout?: number): string {
  const h = crypto.createHash('sha1');
  h.update([target, event, matcher || '', command, timeout?.toString() ?? ''].join('\x1f'));
  return h.digest('hex').slice(0, 16);
}

function flatten(targetFile: HookTargetFile, settings: ClaudeSettings | null): HookEntry[] {
  if (!settings?.hooks) return [];
  const out: HookEntry[] = [];
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const matcher = entry.matcher ?? '';
      const meta = entry._ext;
      if (!Array.isArray(entry.hooks)) continue;
      for (const leaf of entry.hooks) {
        if (!leaf || leaf.type !== 'command' || typeof leaf.command !== 'string') continue;
        out.push({
          id: hookId(targetFile, event as HookEvent, matcher, leaf.command, leaf.timeout),
          event: event as HookEvent,
          matcher: matcher || undefined,
          command: leaf.command,
          timeout: leaf.timeout,
          targetFile,
          enabled: true,
          source: meta ? { kind: meta.kind, presetKey: meta.presetKey, commandRef: meta.commandRef } : undefined,
        });
      }
    }
  }
  return out;
}

export async function loadAllHooks(
  workspaceRoot: string,
  context: vscode.ExtensionContext,
): Promise<HookEntry[]> {
  const paths = getHookFilePaths(workspaceRoot);
  const [proj, local, user] = await Promise.all([
    readSettings(paths.project),
    readSettings(paths.local),
    readSettings(paths.user),
  ]);
  const enabled = [
    ...flatten('project', proj),
    ...flatten('local', local),
    ...flatten('user', user),
  ];
  // Disabled hooks live in workspaceState. Clean up any that show up in
  // settings.json now (someone re-enabled them outside our UI).
  const enabledIds = new Set(enabled.map((h) => h.id));
  const disabledMap = context.workspaceState.get<Record<string, DisabledRecord>>(DISABLED_STATE_KEY, {});
  let dirty = false;
  const disabled: HookEntry[] = [];
  for (const [id, rec] of Object.entries(disabledMap)) {
    if (enabledIds.has(id)) {
      delete disabledMap[id];
      dirty = true;
      continue;
    }
    disabled.push({ ...rec.entry, enabled: false });
  }
  if (dirty) await context.workspaceState.update(DISABLED_STATE_KEY, disabledMap);
  return [...enabled, ...disabled];
}

async function upsertHookInFile(
  workspaceRoot: string,
  entry: HookEntry,
  removeOldId?: string,
): Promise<void> {
  const filePath = hookFilePath(workspaceRoot, entry.targetFile);
  const settings = (await readSettings(filePath)) ?? {};
  if (!settings.hooks) settings.hooks = {};
  // Remove the old hook (matched by hashing the OLD spec — caller passes id).
  if (removeOldId) {
    for (const [ev, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        if (!Array.isArray(e.hooks)) continue;
        const matcher = e.matcher ?? '';
        e.hooks = e.hooks.filter(
          (leaf) => hookId(entry.targetFile, ev as HookEvent, matcher, leaf.command, leaf.timeout) !== removeOldId,
        );
      }
      // Drop entries whose hooks list became empty.
      settings.hooks[ev as HookEvent] = entries.filter((e) => Array.isArray(e.hooks) && e.hooks.length > 0);
      if (settings.hooks[ev as HookEvent]?.length === 0) delete settings.hooks[ev as HookEvent];
    }
  }

  // Append into matching (event, matcher) bucket; create if missing.
  if (!settings.hooks[entry.event]) settings.hooks[entry.event] = [];
  const bucket = settings.hooks[entry.event] as ClaudeHookEntry[];
  const matcher = entry.matcher ?? '';
  let target = bucket.find((b) => (b.matcher ?? '') === matcher);
  if (!target) {
    target = { matcher: matcher || undefined, hooks: [] };
    bucket.push(target);
  }
  const leaf: ClaudeHookLeaf = { type: 'command', command: entry.command };
  if (typeof entry.timeout === 'number') leaf.timeout = entry.timeout;
  target.hooks.push(leaf);
  if (entry.source) target._ext = entry.source;

  await writeSettings(filePath, settings);
}

async function removeHookFromFile(
  workspaceRoot: string,
  targetFile: HookTargetFile,
  id: string,
): Promise<HookEntry | null> {
  const filePath = hookFilePath(workspaceRoot, targetFile);
  const settings = await readSettings(filePath);
  if (!settings?.hooks) return null;
  let removed: HookEntry | null = null;
  for (const [ev, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      if (!Array.isArray(e.hooks)) continue;
      const matcher = e.matcher ?? '';
      e.hooks = e.hooks.filter((leaf) => {
        const lid = hookId(targetFile, ev as HookEvent, matcher, leaf.command, leaf.timeout);
        if (lid === id) {
          removed = {
            id,
            event: ev as HookEvent,
            matcher: matcher || undefined,
            command: leaf.command,
            timeout: leaf.timeout,
            targetFile,
            enabled: true,
            source: e._ext ? { ...e._ext } : undefined,
          };
          return false;
        }
        return true;
      });
    }
    settings.hooks[ev as HookEvent] = entries.filter((e) => Array.isArray(e.hooks) && e.hooks.length > 0);
    if (settings.hooks[ev as HookEvent]?.length === 0) delete settings.hooks[ev as HookEvent];
  }
  if (removed) await writeSettings(filePath, settings);
  return removed;
}

export async function saveHook(
  workspaceRoot: string,
  entry: HookEntry,
  originalId: string | undefined,
  context: vscode.ExtensionContext,
): Promise<HookEntry> {
  // Confirm before touching user-global settings — that file is shared
  // across all projects.
  if (entry.targetFile === 'user') {
    const seen = context.globalState.get<boolean>('commandsExtension.confirmedUserHookWrite');
    if (!seen) {
      const answer = await vscode.window.showWarningMessage(
        'Write a hook to ~/.claude/settings.json? This affects every project for this user.',
        { modal: true },
        'Write once', 'Always allow',
      );
      if (answer !== 'Write once' && answer !== 'Always allow') {
        throw new Error('User-global write cancelled');
      }
      if (answer === 'Always allow') {
        await context.globalState.update('commandsExtension.confirmedUserHookWrite', true);
      }
    }
  }

  await upsertHookInFile(workspaceRoot, entry, originalId);
  // Drop from disabled-backup if it was there.
  const disabledMap = context.workspaceState.get<Record<string, DisabledRecord>>(DISABLED_STATE_KEY, {});
  if (originalId && disabledMap[originalId]) {
    delete disabledMap[originalId];
    await context.workspaceState.update(DISABLED_STATE_KEY, disabledMap);
  }
  // Recompute final id from the persisted spec.
  return {
    ...entry,
    id: hookId(entry.targetFile, entry.event, entry.matcher ?? '', entry.command, entry.timeout),
    enabled: true,
  };
}

export async function deleteHook(
  workspaceRoot: string,
  id: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  const disabledMap = context.workspaceState.get<Record<string, DisabledRecord>>(DISABLED_STATE_KEY, {});
  if (disabledMap[id]) {
    delete disabledMap[id];
    await context.workspaceState.update(DISABLED_STATE_KEY, disabledMap);
    return;
  }
  for (const target of ['project', 'local', 'user'] as HookTargetFile[]) {
    const removed = await removeHookFromFile(workspaceRoot, target, id);
    if (removed) return;
  }
}

export async function setHookEnabled(
  workspaceRoot: string,
  id: string,
  enabled: boolean,
  context: vscode.ExtensionContext,
): Promise<void> {
  const disabledMap = context.workspaceState.get<Record<string, DisabledRecord>>(DISABLED_STATE_KEY, {});
  if (!enabled) {
    // Move from settings.json into workspaceState backup.
    for (const target of ['project', 'local', 'user'] as HookTargetFile[]) {
      const removed = await removeHookFromFile(workspaceRoot, target, id);
      if (removed) {
        disabledMap[id] = { entry: removed };
        await context.workspaceState.update(DISABLED_STATE_KEY, disabledMap);
        return;
      }
    }
    return;
  }
  // Restore from backup.
  const rec = disabledMap[id];
  if (!rec) return;
  await upsertHookInFile(workspaceRoot, rec.entry);
  delete disabledMap[id];
  await context.workspaceState.update(DISABLED_STATE_KEY, disabledMap);
}
