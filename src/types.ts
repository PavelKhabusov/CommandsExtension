export interface CommandDefinition {
  name: string;
  command: string;
  type: 'terminal' | 'pwsh' | 'node';
  group: string;
  cwd?: string;
  detail?: string;
}

export interface CommandGroup {
  name: string;
  commands: CommandDefinition[];
  source?: 'commands-list.json' | 'package.json';
}

export type CommandSource = 'commands-list.json' | 'package.json';
