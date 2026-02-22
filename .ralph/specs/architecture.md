# Commands Extension — Architecture Specification

## Overview

A VSCode extension that provides a Webview panel with an auto-generated UI for running project commands. Commands are loaded from two sources and executed in VSCode terminals.

## Command Sources

### Source 1: `commands.json`

Located at workspace root (configurable via `commandsExtension.configFile` setting).

```json
{
  "commands": [
    {
      "name": "Build Project",
      "command": "npm run build",
      "type": "terminal",
      "group": "Build",
      "cwd": "./frontend"
    },
    {
      "name": "Deploy",
      "command": "./scripts/deploy.ps1",
      "type": "pwsh",
      "group": "Deploy"
    },
    {
      "name": "Start Server",
      "command": "node server.js",
      "type": "node",
      "group": "Dev"
    }
  ]
}
```

**Fields:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | yes | Display name in UI |
| command | string | yes | Command to execute |
| type | `"terminal"` \| `"pwsh"` \| `"node"` | yes | Shell type |
| group | string | no | Group name for UI grouping (default: "General") |
| cwd | string | no | Working directory relative to workspace root |

### Source 2: `package.json` scripts

Automatically reads the `scripts` section from workspace `package.json`.

```json
{
  "scripts": {
    "build": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "test": "jest"
  }
}
```

These are converted to:
```typescript
{
  name: "build",           // script key
  command: "npm run build", // prefixed with "npm run"
  type: "terminal",
  group: "npm scripts"     // always grouped as "npm scripts"
}
```

## TypeScript Interfaces

```typescript
// src/types.ts

interface CommandDefinition {
  name: string;
  command: string;
  type: 'terminal' | 'pwsh' | 'node';
  group: string;
  cwd?: string;
}

interface CommandGroup {
  name: string;
  commands: CommandDefinition[];
}

type CommandSource = 'commands.json' | 'package.json';
```

## Architecture Components

### `src/commandsProvider.ts`

Responsible for loading and merging commands from both sources.

```typescript
export function loadCommands(workspaceRoot: string): Promise<CommandGroup[]>
```

- Reads `commands.json` if it exists (gracefully skip if missing)
- Reads `package.json` scripts if they exist
- Groups commands by `group` field
- Returns array of `CommandGroup` sorted: user groups first, then "npm scripts"

### `src/webviewPanel.ts`

Manages the Webview panel lifecycle.

```typescript
export class CommandsPanel {
  public static currentPanel: CommandsPanel | undefined;
  public static createOrShow(extensionUri: vscode.Uri): void;

  private _update(): void;           // Refresh webview content
  private _getHtmlForWebview(): string; // Generate HTML
  private _handleMessage(message: any): void; // Handle postMessage from webview
}
```

**Singleton pattern**: Only one panel instance at a time. `createOrShow()` focuses existing panel or creates new one.

### `src/extension.ts`

Entry point.

```typescript
export function activate(context: vscode.ExtensionContext): void {
  // Register "commandsExtension.openPanel" command
  // Set up FileSystemWatcher for commands.json and package.json
  // Push disposables to context.subscriptions
}

export function deactivate(): void {}
```

## Webview ↔ Extension Messaging Protocol

### Webview → Extension (postMessage)

```typescript
// Run a command
{ type: 'runCommand', name: string, command: string, shellType: 'terminal' | 'pwsh' | 'node', cwd?: string }

// Request refresh
{ type: 'refresh' }
```

### Extension → Webview (postMessage)

```typescript
// Send updated command list
{ type: 'updateCommands', groups: CommandGroup[] }

// Notify command started
{ type: 'commandStarted', name: string }
```

## Webview UI Requirements

- Use VSCode CSS variables for native look:
  - `var(--vscode-button-background)`
  - `var(--vscode-button-foreground)`
  - `var(--vscode-button-hoverBackground)`
  - `var(--vscode-editor-background)`
  - `var(--vscode-editor-foreground)`
  - `var(--vscode-panel-border)`
- Group commands with collapsible sections (group headers)
- Each command as a clickable button showing name
- Content Security Policy with nonce for inline scripts
- Responsive layout

## Terminal Execution

```typescript
function runCommand(cmd: CommandDefinition, workspaceRoot: string): void {
  const terminalOptions: vscode.TerminalOptions = {
    name: `Cmd: ${cmd.name}`,
    cwd: cmd.cwd
      ? path.join(workspaceRoot, cmd.cwd)
      : workspaceRoot,
  };

  if (cmd.type === 'pwsh') {
    terminalOptions.shellPath = 'pwsh';
  }

  const terminal = vscode.window.createTerminal(terminalOptions);
  terminal.show();

  if (cmd.type === 'node') {
    terminal.sendText(`node ${cmd.command}`);
  } else {
    terminal.sendText(cmd.command);
  }
}
```

## Security

- Webview CSP: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`
- No eval, no inline styles from untrusted sources
- Validate commands.json schema before rendering
