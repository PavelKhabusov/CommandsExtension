# Commands Extension

[![Version](https://img.shields.io/badge/version-0.0.6-blue)](https://github.com/PavelKhabusov/CommandsExtension/releases)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/PavelKhabusov.commands-extension?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=PavelKhabusov.commands-extension)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A VSCode extension that gives your project a visual command dashboard. Define commands in a `commands-list.json` file or let the extension auto-import your `package.json` scripts — then run them with a single click from the sidebar or a dedicated panel.

## Install

**From Marketplace:**
1. Open VSCode
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for **"Commands Extension"**
4. Click **Install**

**Or via CLI:**
```bash
code --install-extension PavelKhabusov.commands-extension
```

## Features

- **Sidebar & Panel** — Access commands from the Activity Bar sidebar or via `Ctrl+Shift+P` > "Commands: Open Panel"
- **Multiple command types** — `terminal` (default shell), `node`, `pwsh` (PowerShell)
- **Grouped commands** — Organize commands into collapsible groups
- **Add commands from UI** — Click `+` to add new commands directly without editing JSON
- **Terminal reuse** — Re-running a command reuses its existing terminal instead of creating a new one
- **Auto-refresh** — File watcher detects changes to `commands-list.json` and `package.json` and updates the UI
- **Theme-aware** — Uses VSCode CSS variables for a native look in any theme (light, dark, high contrast)

## Getting Started

1. Open a workspace folder in VSCode
2. Create a `commands-list.json` file in the workspace root (see format below)
3. Open the Commands sidebar from the Activity Bar — your commands appear automatically

Scripts from `package.json` are also imported automatically under the "npm scripts" group.

## commands-list.json Format

```json
{
  "commands": [
    {
      "name": "Build Project",
      "command": "npm run build",
      "type": "terminal",
      "group": "Build"
    },
    {
      "name": "Start Server",
      "command": "server.js",
      "type": "node",
      "group": "Dev"
    },
    {
      "name": "Deploy",
      "command": "./scripts/deploy.ps1",
      "type": "pwsh",
      "group": "Deploy"
    }
  ]
}
```

### Command Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Display name shown in the UI |
| `command` | string | yes | Command to execute |
| `type` | `"terminal"` \| `"node"` \| `"pwsh"` | yes | Execution type |
| `group` | string | no | Group name for organizing (default: "General") |
| `cwd` | string | no | Working directory relative to workspace root |

### Command Types

| Type | Description |
|------|-------------|
| `terminal` | Runs the command in the default shell (bash, zsh, cmd, etc.) |
| `node` | Runs with `node <command>` |
| `pwsh` | Runs with `pwsh -Command <command>` (PowerShell) |

## package.json Scripts

Scripts from your `package.json` are automatically imported under the **"npm scripts"** group. For example:

```json
{
  "scripts": {
    "build": "tsc -p ./",
    "test": "jest",
    "start": "node server.js"
  }
}
```

These appear as `npm run build`, `npm run test`, `npm run start` in the UI.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `commandsExtension.configFile` | `commands-list.json` | Path to commands config file (relative to workspace root) |

## Requirements

- Visual Studio Code 1.85.0 or later

## License

MIT
