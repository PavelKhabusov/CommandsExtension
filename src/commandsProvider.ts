import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandDefinition, CommandGroup, CommandSource } from './types';

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

function loadPs1Scripts(workspaceRoot: string): CommandDefinition[] {
  try {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.ps1'))
      .map(e => ({
        name: e.name.replace(/\.ps1$/, ''),
        command: `.\\${e.name}`,
        type: 'pwsh' as const,
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

  const commandsFromJson = loadFromCommandsJson(commandsJsonPath);
  const commandsFromPackage = loadFromPackageJson(packageJsonPath);
  const commandsFromPs1 = loadPs1Scripts(workspaceRoot);

  const allCommands = [...commandsFromJson, ...commandsFromPackage, ...commandsFromPs1];
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

export async function moveCommandInFile(
  workspaceRoot: string,
  commandName: string,
  sourceGroup: string,
  targetGroup: string,
  configFileName: string = 'commands-list.json'
): Promise<boolean> {
  const filePath = path.join(workspaceRoot, configFileName);

  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data: CommandsJsonSchema = JSON.parse(raw);
    if (!Array.isArray(data.commands)) {
      return false;
    }

    const cmd = data.commands.find(
      c => c.name === commandName && (c.group || 'General') === sourceGroup
    );
    if (!cmd) {
      return false;
    }

    cmd.group = targetGroup;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
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
