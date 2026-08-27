export interface CommandDefinition {
  name: string;
  command: string;
  type: 'terminal' | 'pwsh' | 'node';
  group: string;
  cwd?: string;
  detail?: string;
  /** Name of a command that stops this one. When this command is running, its
   *  card shows a Stop button that closes this terminal and runs that command. */
  stop?: string;
  /** Hide this command from the list (e.g. a stop command only reached via `stop`). */
  hidden?: boolean;
}

export interface CommandGroup {
  name: string;
  commands: CommandDefinition[];
  source?: CommandSource;
}

export type CommandSource = 'commands-list.json' | 'package.json' | 'ps1-scripts';
