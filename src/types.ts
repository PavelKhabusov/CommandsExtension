export interface CommandDefinition {
  name: string;
  command: string;
  type: 'terminal' | 'pwsh' | 'node';
  group: string;
  cwd?: string;
}

export interface CommandGroup {
  name: string;
  commands: CommandDefinition[];
}

export type CommandSource = 'commands.json' | 'package.json';
