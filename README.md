# Commands Extension

[![Version](https://img.shields.io/badge/version-0.0.15-blue)](https://github.com/PavelKhabusov/CommandsExtension/releases)
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

### Claude Hooks Manager

Manage [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
from the panel instead of editing `settings.json` by hand. The **Claude Hooks**
section lists every hook found in:

| File                             | Source label |
|----------------------------------|--------------|
| `.claude/settings.json`          | 📁 project (committed)             |
| `.claude/settings.local.json`    | 🔒 local (gitignored)              |
| `~/.claude/settings.json`        | 🌍 user-global (all your projects) |

By default the section shows only **project** + **local** hooks — the ones
actually scoped to this workspace. User-global hooks (shared across every
project on your machine) are hidden behind the `🌍` toggle in the header
to keep your project view focused. Toggle it on to also list them.

Section header buttons (visible on hover):

| Button | What it does |
|--------|--------------|
| `+`    | Open the editor to add a new hook                                              |
| `📋`   | Paste a hook JSON from clipboard (opens the editor pre-filled)                |
| `🌍`   | Toggle visibility of user-global hooks                                        |
| `📂`   | Quick-open any of the three `settings.json` files (no hook needed)            |

Each card has:
- a **toggle switch** to disable / re-enable the hook (disabled hooks are
  pulled out of `settings.json` and cached in workspace state; toggling on
  restores them; the row stays in the same slot — ordering is stable across
  toggles)
- a **clickable script path** for hooks whose command points to a
  `.sh` / `.py` / `.js` / etc. file (with `$CLAUDE_PROJECT_DIR` and `~/`
  expansion) — click to open the script in the editor
- a colored target pill (📁 blue / 🔒 yellow / 🌍 purple) — click to
  open the underlying `settings.json`
- right-click context menu: **Edit** / **Copy to clipboard** (as JSON) /
  **Delete**

The **+ Add hook** button opens an inline editor where you pick:
1. **Event** — `Stop`, `SubagentStop`, `UserPromptSubmit`, `PreToolUse`,
   `PostToolUse`, `Notification`, `SessionStart`, `SessionEnd`, `PreCompact`.
   Each group shows a short description of when it fires.
2. **Matcher** — optional regex, only relevant for the events that take one.
3. **Target file** — project / local / user-global. Writes to user-global
   ask for confirmation the first time.
4. **Action**:
   - **Preset** — `Play sound`, `Desktop notification`, `Append timestamp`,
     `Wait N seconds`, `Open URL / file / app`. Each preset emits a
     cross-platform shell command (see the table above; ⚠ icon flags
     presets whose tool isn't detected on this OS).
   - **Existing command** — pick one from `commands-list.json`. The
     actual shell script is copied into the hook so you can tweak it
     per-hook without affecting the original command.
   - **Custom shell** — write whatever you want.
5. **Shell script** — multi-line editable, even for presets/command refs.
6. **Timeout** (optional, seconds).

**Copy / paste across projects** — right-click → **Copy to clipboard** writes
a small `{event,matcher,command,timeout}` JSON to the clipboard. In another
project, hit the 📋 button in the **Claude Hooks** section header to open
the editor pre-filled with the pasted spec.

---

### Combined Operations

Bundle terminal commands, server uploads, and small helpers into a single
ordered sequence. Each step in a combined operation can be:

| Step type      | What it does                                                                       |
|----------------|------------------------------------------------------------------------------------|
| `command`      | Runs an existing command from `commands-list.json` / `package.json` / `*.ps1`. With Shell Integration enabled (default for bash/zsh/fish/pwsh/cmd) the runner waits for it to exit; if SI is unavailable, it falls back to fire-and-go. |
| `upload`       | Runs a server upload by key (`<group>:<name>`), waits for completion.              |
| `auto-upload`  | Picks the optimal upload set-cover for a server (`user@host`) — exactly what the recommended auto-upload card does locally. |
| `vscode-cmd`   | Invokes any registered VS Code command (e.g. `workbench.action.reloadWindow`). Picker uses VS Code's native quickPick with fuzzy search over all 1000+ command IDs. |
| `wait`         | `await sleep(seconds * 1000)` — internal pause, cancellable, no terminal.          |
| `open`         | Opens a URL/file via `vscode.env.openExternal`; for `app` targets uses the OS shell (`gtk-launch` → binary fallback on Linux, `open -a` on macOS, `start ""` on Windows). |
| `sound`        | Plays a short sound clip (complete / alert / error) — best-effort cross-platform. |
| `notification` | Shows a VS Code notification (info / warn / error).                                |

Combined operations live in the same `commands-list.json` under a new
`combined` field. Edit them via the "+" button in the **Combined
Operations** section of the panel: an inline editor opens with
drag-to-reorder steps and an "Add step ▾" submenu (7 step types via
VS Code's native input box / quick-pick prompts). Run from the card
(click), cancel the running op via the same click; right-click for
Run / Edit / Duplicate / Delete.

Each card lists its steps with a per-step **checkbox** — quickly skip
individual steps without removing them (e.g. include `command` and
`upload` but skip the `notification`). State persists in
`commands-list.json`.

When a step is uploading, the card shows the step number ("Running
2/3: …") and the standard upload progress bar inline.

`stopOnError` (default `true`) — a failed step (upload error, non-zero
exit code) skips the remaining steps. Toggle in the editor.

**Common use case:** after a local install you want VS Code to pick up
the new build. Bundle `npm run install-local` + `vscode-cmd:
workbench.action.reloadWindow` into one "Install & Reload" operation —
one click, both steps, and the window reloads right when the install
finishes.

---

### Cross-platform requirements

`sound`, `notification`, and `open` steps (in Combined Operations) and
the matching presets (in Claude Hooks Manager) rely on small system
utilities. Most are already installed on desktop Linux / macOS / Windows;
some Linux setups (servers, minimal distros) need extras.

| Feature        | Linux                                            | macOS                       | Windows                                      |
|----------------|--------------------------------------------------|-----------------------------|----------------------------------------------|
| Play sound     | `paplay` (pulseaudio-utils) or `aplay`           | `afplay` (built-in)         | PowerShell `[console]::beep()` (built-in)    |
| Notification   | `notify-send` (libnotify-bin)                    | `osascript` (built-in)      | PowerShell + .NET MessageBox (built-in); `BurntToast` module for toast notifications |
| Open URL/file/app | `xdg-open` (xdg-utils)                        | `open` (built-in)           | `start ""` (built-in)                        |

**Install commands when something's missing:**

- Ubuntu / Debian: `sudo apt install libnotify-bin pulseaudio-utils xdg-utils`
- Fedora: `sudo dnf install libnotify pulseaudio-utils xdg-utils`
- Arch: `sudo pacman -S libnotify libpulse xdg-utils`
- macOS: everything ships with the OS
- Windows: nothing required for basics; for richer toast notifications, run `Install-Module -Name BurntToast -Force` in PowerShell

The editor's "Add step ▾" submenu shows a ⚠ icon next to presets
whose underlying tool isn't detected on the current OS, with a tooltip
hint about what to install.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `commandsExtension.configFile` | `commands-list.json` | Path to commands config file (relative to workspace root) |
| `commandsExtension.uploadsFile` | `server-uploads.local.json` | Path to server uploads config file (relative to workspace root) |
| `commandsExtension.externalApiUrl` | `""` | Optional base URL of an external hub that receives upload / staleness / combined-op events and the merged command list. Empty disables. |

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full list of changes per version.

## Requirements

- VS Code 1.85.0+

## License

MIT
