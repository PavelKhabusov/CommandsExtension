import * as fs from 'fs';
import * as path from 'path';
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

function loadFromCommandsJson(filePath: string): CommandDefinition[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: CommandsJsonSchema = JSON.parse(raw);

    if (!parsed.commands || !Array.isArray(parsed.commands)) {
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
  } catch {
    return [];
  }
}

function loadFromPackageJson(filePath: string): CommandDefinition[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: PackageJsonSchema = JSON.parse(raw);

    if (!parsed.scripts || typeof parsed.scripts !== 'object') {
      return [];
    }

    return Object.keys(parsed.scripts).map(scriptName => ({
      name: scriptName,
      command: `npm run ${scriptName}`,
      type: 'terminal' as const,
      group: 'npm scripts',
    }));
  } catch {
    return [];
  }
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
    ? { name: 'npm scripts', commands: groupMap.get('npm scripts')! }
    : undefined;

  // User-defined groups first (sorted alphabetically), then npm scripts
  for (const [name, commands] of groupMap) {
    if (name !== 'npm scripts') {
      groups.push({ name, commands });
    }
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  if (npmScriptsGroup) {
    groups.push(npmScriptsGroup);
  }

  return groups;
}

export async function loadCommands(workspaceRoot: string, configFileName: string = 'commands.json'): Promise<CommandGroup[]> {
  const commandsJsonPath = path.join(workspaceRoot, configFileName);
  const packageJsonPath = path.join(workspaceRoot, 'package.json');

  const commandsFromJson = loadFromCommandsJson(commandsJsonPath);
  const commandsFromPackage = loadFromPackageJson(packageJsonPath);

  const allCommands = [...commandsFromJson, ...commandsFromPackage];
  return groupCommands(allCommands);
}
