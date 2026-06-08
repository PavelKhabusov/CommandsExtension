import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandDefinition, CommandGroup, CommandSource } from './types';
import { CombinedOpDefinition, CombinedStep } from './combinedOpsTypes';

interface CommandsJsonSchema {
  commands: Array<{
    name: string;
    command: string;
    type: 'terminal' | 'pwsh' | 'node';
    group?: string;
    cwd?: string;
  }>;
  combined?: CombinedOpDefinition[];
}

interface PackageJsonSchema {
  scripts?: Record<string, string>;
}

function hasTrailingCommas(json: string): boolean {
  return /,\s*[\]}]/g.test(json);
}

function stripTrailingCommas(json: string): string {
  return json.replace(/,\s*([\]}])/g, '$1');
}

function safeParseJson<T>(raw: string, filePath: string): T | null {
  if (hasTrailingCommas(raw)) {
    vscode.window.showWarningMessage(`Commands Extension: trailing comma in ${path.basename(filePath)}`);
    raw = stripTrailingCommas(raw);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    vscode.window.showWarningMessage(`Commands Extension: invalid JSON in ${path.basename(filePath)}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

async function loadFromCommandsJson(filePath: string): Promise<CommandDefinition[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const parsed = safeParseJson<CommandsJsonSchema>(raw, filePath);

  if (!parsed || !parsed.commands || !Array.isArray(parsed.commands)) {
    return [];
  }

  return parsed.commands
    .filter(cmd => cmd.name && cmd.command && cmd.type)
    .map(cmd => ({
      name: cmd.name,
      command: cmd.command,
      type: cmd.type,
      group: cmd.group || 'General',
      cwd: cmd.cwd,
    }));
}

async function loadFromPackageJson(filePath: string): Promise<CommandDefinition[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const parsed = safeParseJson<PackageJsonSchema>(raw, filePath);

  if (!parsed || !parsed.scripts || typeof parsed.scripts !== 'object') {
    return [];
  }

  return Object.entries(parsed.scripts).map(([scriptName, scriptValue]) => ({
    name: scriptName,
    command: `npm run ${scriptName}`,
    type: 'terminal' as const,
    group: 'npm scripts',
    detail: scriptValue,
  }));
}

async function loadPs1Scripts(workspaceRoot: string): Promise<CommandDefinition[]> {
  try {
    const entries = await fs.promises.readdir(workspaceRoot, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.ps1'))
      .map(e => ({
        name: e.name.replace(/\.ps1$/, ''),
        command: `pwsh ./${e.name}`,
        type: 'terminal' as const,
        group: 'PowerShell scripts',
        detail: e.name,
      }));
  } catch {
    return [];
  }
}

const autoGroups: Record<string, CommandSource> = {
  'npm scripts': 'package.json',
  'PowerShell scripts': 'ps1-scripts',
};

function groupCommands(commands: CommandDefinition[]): CommandGroup[] {
  const groupMap = new Map<string, CommandDefinition[]>();

  for (const cmd of commands) {
    const existing = groupMap.get(cmd.group);
    if (existing) {
      existing.push(cmd);
    } else {
      groupMap.set(cmd.group, [cmd]);
    }
  }

  const groups: CommandGroup[] = [];
  const autoGroupEntries: CommandGroup[] = [];

  for (const [name, commands] of groupMap) {
    if (name in autoGroups) {
      autoGroupEntries.push({ name, commands, source: autoGroups[name] });
    } else {
      groups.push({ name, commands, source: 'commands-list.json' });
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  // Auto-detected groups go at the end
  for (const g of autoGroupEntries) {
    groups.push(g);
  }

  return groups;
}

export async function loadCommands(workspaceRoot: string, configFileName: string = 'commands-list.json'): Promise<CommandGroup[]> {
  const commandsJsonPath = path.join(workspaceRoot, configFileName);
  const packageJsonPath = path.join(workspaceRoot, 'package.json');

  const [commandsFromJson, commandsFromPackage, commandsFromPs1] = await Promise.all([
    loadFromCommandsJson(commandsJsonPath),
    loadFromPackageJson(packageJsonPath),
    loadPs1Scripts(workspaceRoot),
  ]);

  const allCommands = [...commandsFromJson, ...commandsFromPackage, ...commandsFromPs1];
  return groupCommands(allCommands);
}

async function readCommandsJson(filePath: string): Promise<CommandsJsonSchema | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    const data: CommandsJsonSchema = JSON.parse(raw);
    if (!Array.isArray(data.commands)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

// ─── Combined Operations ──────────────────────────────────────────────────

const VALID_STEP_TYPES = new Set([
  'command', 'upload', 'auto-upload', 'wait', 'open', 'sound', 'notification', 'vscode-cmd',
]);

function isValidStep(s: unknown): s is CombinedStep {
  if (!s || typeof s !== 'object') return false;
  const o = s as { type?: unknown };
  if (typeof o.type !== 'string' || !VALID_STEP_TYPES.has(o.type)) return false;
  return true;
}

function isValidCombinedOp(op: unknown): op is CombinedOpDefinition {
  if (!op || typeof op !== 'object') return false;
  const o = op as { name?: unknown; steps?: unknown };
  if (typeof o.name !== 'string' || !o.name.trim()) return false;
  if (!Array.isArray(o.steps)) return false;
  return o.steps.every(isValidStep);
}

export async function loadCombinedOps(
  workspaceRoot: string,
  configFileName: string = 'commands-list.json',
): Promise<CombinedOpDefinition[]> {
  const filePath = path.join(workspaceRoot, configFileName);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  const parsed = safeParseJson<CommandsJsonSchema>(raw, filePath);
  if (!parsed || !Array.isArray(parsed.combined)) return [];
  return parsed.combined.filter(isValidCombinedOp).map((op) => ({
    name: op.name,
    steps: op.steps,
    stopOnError: op.stopOnError !== false,
  }));
}

export async function saveCombinedOp(
  workspaceRoot: string,
  op: CombinedOpDefinition,
  originalName: string | undefined,
  configFileName: string = 'commands-list.json',
): Promise<void> {
  const filePath = path.join(workspaceRoot, configFileName);
  const data: CommandsJsonSchema =
    (await readCommandsJson(filePath)) ?? { commands: [] };
  if (!Array.isArray(data.combined)) data.combined = [];

  const lookupName = originalName ?? op.name;
  const idx = data.combined.findIndex((c) => c.name === lookupName);
  const sanitized: CombinedOpDefinition = {
    name: op.name,
    steps: op.steps,
    stopOnError: op.stopOnError !== false,
  };
  if (idx >= 0) {
    data.combined[idx] = sanitized;
  } else {
    data.combined.push(sanitized);
  }
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function deleteCombinedOp(
  workspaceRoot: string,
  name: string,
  configFileName: string = 'commands-list.json',
): Promise<boolean> {
  const filePath = path.join(workspaceRoot, configFileName);
  const data = await readCommandsJson(filePath);
  if (!data || !Array.isArray(data.combined)) return false;
  const before = data.combined.length;
  data.combined = data.combined.filter((c) => c.name !== name);
  if (data.combined.length === before) return false;
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return true;
}

export async function addCommandToFile(
  workspaceRoot: string,
  newCommand: { name: string; command: string; type: string; group: string },
  configFileName: string = 'commands-list.json'
): Promise<void> {
  const filePath = path.join(workspaceRoot, configFileName);

  let data: CommandsJsonSchema = await readCommandsJson(filePath) ?? { commands: [] };

  const group = newCommand.group || 'General';
  const exists = data.commands.some(
    cmd => cmd.name === newCommand.name && (cmd.group || 'General') === group
  );
  if (exists) {
    return;
  }

  data.commands.push({
    name: newCommand.name,
    command: newCommand.command,
    type: newCommand.type as 'terminal' | 'pwsh' | 'node',
    group,
  });

  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function moveCommandInFile(
  workspaceRoot: string,
  commandName: string,
  sourceGroup: string,
  targetGroup: string,
  configFileName: string = 'commands-list.json'
): Promise<boolean> {
  const filePath = path.join(workspaceRoot, configFileName);
  const data = await readCommandsJson(filePath);
  if (!data) return false;

  const cmd = data.commands.find(
    c => c.name === commandName && (c.group || 'General') === sourceGroup
  );
  if (!cmd) return false;

  cmd.group = targetGroup;
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return true;
}

export async function removeGroupFromFile(
  workspaceRoot: string,
  groupName: string,
  configFileName: string = 'commands-list.json'
): Promise<number> {
  const filePath = path.join(workspaceRoot, configFileName);
  const data = await readCommandsJson(filePath);
  if (!data) return 0;

  const before = data.commands.length;
  data.commands = data.commands.filter(cmd => (cmd.group || 'General') !== groupName);
  const removed = before - data.commands.length;

  if (removed > 0) {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  return removed;
}

export async function removeCommandFromFile(
  workspaceRoot: string,
  commandName: string,
  groupName: string,
  configFileName: string = 'commands-list.json'
): Promise<boolean> {
  const filePath = path.join(workspaceRoot, configFileName);
  const data = await readCommandsJson(filePath);
  if (!data) return false;

  const index = data.commands.findIndex(
    cmd => cmd.name === commandName && (cmd.group || 'General') === groupName
  );
  if (index === -1) return false;

  data.commands.splice(index, 1);
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return true;
}
