# Commands Extension

[![Version](https://img.shields.io/badge/version-0.0.14-blue)](https://github.com/PavelKhabusov/CommandsExtension/releases)
[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/PavelKhabusov.commands-extension?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=PavelKhabusov.commands-extension)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**One-click command runner for VS Code.** Define commands in JSON or let the extension pick up your `package.json` scripts and `.ps1` files automatically — then run anything from a sidebar or panel with a single click.

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

### Search & Filter

Filter commands instantly by typing in the search bar. Matches command names, command text, and group names. Groups auto-expand during search and restore their collapsed state when cleared.

### Context Menu

Right-click any command to access:

| Action | Availability |
|--------|-------------|
| Add / Remove from favorites | All commands |
| Enable / Disable confirmation | All commands |
| Stop terminal | Commands with active terminal |
| Move to group | Custom commands only |
| Delete | Custom commands only |

### Run Confirmation

Enable confirmation for critical commands via the context menu. Protected commands show a lock icon indicator and require a modal confirmation dialog before running.

### Collapsible Groups

Organize commands into named groups. Collapse/expand individual groups or all at once. Group state is preserved across sessions. Command count badge appears on hover.

### Favorites

Star any command to pin it to the **Favorites** group at the top. Use the star button or right-click > "Add to favorites". Favorites persist across sessions.

### Multiple Shell Types

| Type | Runs as |
|------|---------|
| `terminal` | Default shell (bash, zsh, cmd, ...) |
| `node` | `node <command>` |
| `pwsh` | `pwsh -Command <command>` |

### Add Commands from UI

Click **+** in the toolbar to add new commands without touching JSON. Pick an existing group or create a new one on the fly.

### Terminal Management

- Re-running a command reuses its existing terminal
- Active terminals show a green indicator dot and a close button
- Stop terminals via the close button, context menu, or the **Clear Terminals** toolbar button

### Auto-Detection

| Source | Group | Auto-refresh |
|--------|-------|:------------:|
| `commands-list.json` | Custom groups | Yes |
| `package.json` scripts | npm scripts | Yes |
| `*.ps1` files | PowerShell scripts | Yes |

### Server Uploads

Define per-project FTP / FTPS / SFTP upload targets in `server-uploads.local.json` and run them with one click — no FileZilla CLI required, works on Linux, macOS, and Windows.

- **Live progress** — percentage, current file, transfer speed, files done / total
- **Cancel mid-flight** — stop button on running uploads
- **Files, folders, globs** — single files, recursive folder uploads, or glob patterns
- **Per-upload `exclude`** — skip files inside an uploaded folder (e.g. `**/node_modules/**`)
- **Shared `servers`** — define a server once, reference it from many uploads
- **Interactive picker** — folder-with-plus button opens a native file/folder dialog and appends selections to the config
- **`.local.json` by default** — the default filename is excluded by common gitignore patterns so credentials stay out of git

```json
{
  "servers": [
    {
      "name": "main",
      "protocol": "ftp",
      "host": "example.com",
      "port": 21,
      "user": "username",
      "password": "your-password"
    }
  ],
  "uploads": [
    {
      "name": "Theme → prod",
      "server": "main",
      "remoteDir": "/public_html/wp-content/themes/mytheme/",
      "items": ["./wp-content/themes/mytheme/"],
      "exclude": ["**/node_modules/**", "**/*.log"],
      "onExists": "overwrite"
    },
    {
      "name": "Single file → prod",
      "server": "main",
      "remoteDir": "/public_html/",
      "items": ["./bundle/app.js"]
    }
  ]
}
```

#### `servers` entry

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `name` | string | yes | Reference name used by uploads |
| `protocol` | `"ftp"` \| `"ftps"` \| `"sftp"` | yes | Connection protocol |
| `host` | string | yes | Server hostname or IP |
| `port` | number | no | Defaults: 21 (FTP/FTPS), 22 (SFTP) |
| `user` | string | yes | Username |
| `password` | string | no | Password. If omitted, you'll be prompted at upload time (not saved) |

#### `uploads` entry

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `name` | string | yes | Display name in the UI |
| `group` | string | no | Group name (default: `"Uploads"`) |
| `server` | string | conditional | Reference to a `servers` entry. Required unless inline `host`/`user`/`protocol` are set |
| `protocol` / `host` / `port` / `user` / `password` | — | conditional | Inline server fields (override or replace `server`) |
| `remoteDir` | string | yes | Remote directory (absolute path) |
| `items` | string[] | yes | Files, folders, or globs (relative to workspace root) |
| `exclude` | string[] | no | Glob patterns to skip during folder/glob expansion |
| `onExists` | `"overwrite"` \| `"skip"` | no | Behavior on file collision (default: `"overwrite"`) |

Right-click an upload for context menu actions: edit config, add files.

> **Passwords are stored in plain text inside `server-uploads.local.json`.** The default filename is `.local.json` so most gitignore presets exclude it. If you use a different filename, add it to `.gitignore` yourself.

> **Proxy / VPN note:** uploads use raw TCP sockets; HTTP proxy settings (system or VS Code) are not applied. System-level VPN tunnels are honored transparently by the OS — bypassing them requires VPN-level split tunneling.

### Marketplace Templates

The built-in **Recommended** section offers ready-made command sets:

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
| `commandsExtension.configFile` | `commands-list.json` | Path to commands config file (relative to workspace root) |
| `commandsExtension.uploadsFile` | `server-uploads.local.json` | Path to server uploads config file (relative to workspace root) |

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full list of changes per version.

## Requirements

- VS Code 1.85.0+

## License

MIT
