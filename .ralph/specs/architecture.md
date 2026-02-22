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

- Webview CSP: `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};`
- No eval, no inline styles from untrusted sources
- Validate commands.json schema before rendering

---

## Sidebar Panel (WebviewViewProvider)

The extension must also be available in the VSCode sidebar via the Activity Bar.

### package.json contributions

```json
{
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "commandsExtension",
          "title": "Commands",
          "icon": "media/icon.svg"
        }
      ]
    },
    "views": {
      "commandsExtension": [
        {
          "type": "webview",
          "id": "commandsExtension.sidebarView",
          "name": "Commands"
        }
      ]
    }
  }
}
```

### `src/sidebarProvider.ts`

```typescript
export class CommandsSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'commandsExtension.sidebarView';
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    // Set up message handling (same protocol as editor panel)
    // Load and send commands via postMessage
  }

  public refresh(): void {
    // Send updated commands to sidebar webview via postMessage
    // Do NOT reset webview.html — only postMessage
  }
}
```

### Key Architecture Rules
- Sidebar and editor panel are INDEPENDENT — they can be open simultaneously
- Both share the same `media/main.js`, `media/main.css`, and `commandsProvider.ts`
- FileSystemWatcher in `extension.ts` should refresh BOTH when files change
- The webview JS/CSS must be responsive: in narrow sidebar (width ~300px), buttons stack vertically; in wide editor panel, buttons wrap in a flex grid
- HTML is set ONCE in `resolveWebviewView()`. Updates are done ONLY via postMessage

### Activity Bar Icon

Create `media/icon.svg` — a simple monochrome SVG icon (24x24). Should look clear on both dark and light themes. Suggested: a terminal prompt icon or a play-button-in-a-list icon.

---

## UI Design Specification

### Visual Style
The UI should feel native to VSCode — like a built-in panel, not an external app.

### Layout Structure
```
┌──────────────────────────────────┐
│ 🔍 [Search commands...]  [⟳] [≡]│  ← sticky toolbar
├──────────────────────────────────┤
│                                  │
│ ▼ BUILD                         │  ← group header (uppercase, muted color)
│ ┌──────────────────────────────┐│
│ │ ▶ Build Project        [npm] ││  ← command card with type badge
│ │   npm run build              ││  ← command subtitle (muted)
│ ├──────────────────────────────┤│
│ │ ▶ Watch Mode           [npm] ││
│ │   npm run watch              ││
│ └──────────────────────────────┘│
│                                  │
│ ▼ DEV                           │
│ ┌──────────────────────────────┐│
│ │ ▶ Start Server        [node] ││
│ │   node server.js             ││
│ └──────────────────────────────┘│
│                                  │
│ ▶ DEPLOY (collapsed)            │
│                                  │
│ ▼ NPM SCRIPTS                   │
│ ┌────────┐ ┌────────┐ ┌───────┐│  ← npm scripts can be compact pills
│ │ build  │ │ watch  │ │ test  ││
│ └────────┘ └────────┘ └───────┘│
│                                  │
└──────────────────────────────────┘
```

### CSS Variables to Use
```css
/* Backgrounds */
--vscode-editor-background          /* main bg */
--vscode-sideBar-background         /* group card bg */
--vscode-list-hoverBackground       /* button hover */
--vscode-list-activeSelectionBackground  /* button active */

/* Text */
--vscode-editor-foreground          /* primary text */
--vscode-descriptionForeground      /* secondary text, subtitles */
--vscode-textLink-foreground        /* accent links */

/* Borders */
--vscode-panel-border               /* dividers */
--vscode-widget-border              /* card borders */

/* Buttons */
--vscode-button-background          /* primary buttons */
--vscode-button-foreground          /* button text */
--vscode-button-secondaryBackground /* secondary buttons */

/* Badges */
--vscode-badge-background           /* type badges */
--vscode-badge-foreground           /* badge text */

/* Input */
--vscode-input-background           /* search field bg */
--vscode-input-foreground           /* search text */
--vscode-input-border               /* search border */
--vscode-input-placeholderForeground /* placeholder */
```

### Codicon Icons (built into VSCode webviews)
Use the `codicon` font class for icons:
- Terminal: `codicon-terminal`
- Node.js: `codicon-symbol-event`
- PowerShell: `codicon-terminal-powershell`
- Run/Play: `codicon-play`
- Refresh: `codicon-refresh`
- Collapse all: `codicon-collapse-all`
- Expand all: `codicon-expand-all`
- Search: `codicon-search`
- Group chevron: `codicon-chevron-down` / `codicon-chevron-right`

To use codicons in webview, include the codicon CSS from `@vscode/codicons` OR use the toolkit.
Simplest approach: include the codicon font-face in the webview CSP and reference via class.

### Responsive Behavior
- **Sidebar** (width < 400px): full-width stacked buttons, no flex-wrap grid
- **Editor panel** (width >= 400px): buttons wrap in a flex grid, 2-3 per row
- Use CSS `@media (max-width: 400px)` or container queries
