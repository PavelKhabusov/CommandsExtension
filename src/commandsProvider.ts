import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandDefinition, CommandGroup } from './types';

interface CommandsJsonSchema {
  commands: Array<{
    name: string;
    command: string;
    type: 'terminal' | 'pwsh' | 'node';
    group?: string;
    cwd?: string;
  }>;
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

function loadFromCommandsJson(filePath: string): CommandDefinition[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
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

function loadFromPackageJson(filePath: string): CommandDefinition[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
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
  const npmScriptsGroup: CommandGroup | undefined = groupMap.has('npm scripts')
    ? { name: 'npm scripts', commands: groupMap.get('npm scripts')!, source: 'package.json' }
    : undefined;

  // User-defined groups first (sorted alphabetically), then npm scripts
  for (const [name, commands] of groupMap) {
    if (name !== 'npm scripts') {
      groups.push({ name, commands, source: 'commands-list.json' });
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  if (npmScriptsGroup) {
    groups.push(npmScriptsGroup);
  }

  return groups;
}

export async function loadCommands(workspaceRoot: string, configFileName: string = 'commands-list.json'): Promise<CommandGroup[]> {
  const commandsJsonPath = path.join(workspaceRoot, configFileName);
  const packageJsonPath = path.join(workspaceRoot, 'package.json');

  const commandsFromJson = loadFromCommandsJson(commandsJsonPath);
  const commandsFromPackage = loadFromPackageJson(packageJsonPath);

  const allCommands = [...commandsFromJson, ...commandsFromPackage];
  return groupCommands(allCommands);
}

export async function addCommandToFile(
  workspaceRoot: string,
  newCommand: { name: string; command: string; type: string; group: string },
  configFileName: string = 'commands-list.json'
): Promise<void> {
  const filePath = path.join(workspaceRoot, configFileName);

  let data: CommandsJsonSchema = { commands: [] };

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      data = JSON.parse(raw);
      if (!Array.isArray(data.commands)) {
        data.commands = [];
      }
    } catch {
      data = { commands: [] };
    }
  }

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

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function removeGroupFromFile(
  workspaceRoot: string,
  groupName: string,
  configFileName: string = 'commands-list.json'
): Promise<number> {
  const filePath = path.join(workspaceRoot, configFileName);

  if (!fs.existsSync(filePath)) {
    return 0;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: CommandsJsonSchema = JSON.parse(raw);
    if (!Array.isArray(data.commands)) {
      return 0;
    }

    const before = data.commands.length;
    data.commands = data.commands.filter(cmd => (cmd.group || 'General') !== groupName);
    const removed = before - data.commands.length;

    if (removed > 0) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }

    return removed;
  } catch {
    return 0;
  }
}
