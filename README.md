# Commands Extension

[![Version](https://img.shields.io/badge/version-0.0.7-blue)](https://github.com/PavelKhabusov/CommandsExtension/releases)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/PavelKhabusov.commands-extension?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=PavelKhabusov.commands-extension)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**One-click command runner for VS Code.** Define commands in JSON or let the extension pick up your `package.json` scripts automatically — then run anything from a sidebar or panel with a single click.

> No more switching to the terminal and typing the same commands over and over.

---

## Quick Start

```bash
code --install-extension PavelKhabusov.commands-extension
```

1. Open a workspace in VS Code
2. Create `commands-list.json` in the root (or just have a `package.json` with scripts)
3. Click the **Commands** icon in the Activity Bar — done

---

## Features

### Sidebar & Panel

Access your commands from the Activity Bar sidebar or open a dedicated panel via `Ctrl+Shift+P` > **Commands: Open Panel**.

### Collapsible Groups

Organize commands into named groups. Collapse/expand individual groups or all at once. Group state is preserved when commands update.

### Favorites

Star any command to pin it to the **Favorites** group at the top. Favorites persist across sessions.

### Multiple Shell Types

| Type | Runs as |
|------|---------|
| `terminal` | Default shell (bash, zsh, cmd, ...) |
| `node` | `node <command>` |
| `pwsh` | `pwsh -Command <command>` |

### Add Commands from UI

Click **+** in the toolbar to add new commands without touching JSON. Pick an existing group or create a new one on the fly.

### Terminal Reuse

Re-running a command reuses its existing terminal instead of spawning a new one. Use the **Clear Terminals** button to clean up.

### Auto-Refresh

File watchers monitor `commands-list.json` and `package.json` — the UI updates instantly when you save changes.

### Marketplace Templates

The built-in **Recommended** section offers ready-made command sets for popular stacks:

| Template | Description |
|----------|-------------|
| React | Dev server, build, test, lint, format |
| Node.js Backend | Start, dev, build, test, DB migrate |
| Next.js | Dev, build, start, lint |
| Docker | Build, compose up/down, logs |
| Expo | Start, iOS/Android, EAS build/submit |
| Python | Run, pytest, pip install/freeze |
| Git | Status, pull, push, stash, log |
| Turborepo | Monorepo build, dev, lint, test |
| Deploy | Vercel & Netlify deploy commands |
| Testing | Test, watch, coverage |
| Linting | Lint, format, typecheck |
| Git Hooks | Prepare, pre-commit, pre-push |

Click **+** on a template to add the whole set, or expand it and add individual commands.

### Theme-Aware

Uses VS Code CSS variables — looks native in any theme (light, dark, high contrast).

---

## `commands-list.json` Format

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

### Fields

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `name` | string | yes | Display name in the UI |
| `command` | string | yes | Command to execute |
| `type` | `"terminal"` \| `"node"` \| `"pwsh"` | yes | Execution type |
| `group` | string | no | Group name (default: `"General"`) |
| `cwd` | string | no | Working directory relative to workspace root |

---

## `package.json` Scripts

Scripts from your `package.json` are auto-imported under the **npm scripts** group:

```json
{
  "scripts": {
    "build": "tsc -p ./",
    "test": "jest",
    "start": "node server.js"
  }
}
```

These appear as `npm run build`, `npm run test`, `npm run start`.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `commandsExtension.configFile` | `commands-list.json` | Path to config file (relative to workspace root) |

---

## Requirements

- VS Code 1.85.0+

## License

MIT
