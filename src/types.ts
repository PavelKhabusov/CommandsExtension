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
  source?: CommandSource;
}

export type CommandSource = 'commands-list.json' | 'package.json' | 'ps1-scripts';
