# Commands Extension

A VSCode extension that provides a webview panel for running project commands. Define commands in a `commands.json` file or let the extension auto-import your `package.json` scripts.

## Features

- **Command Panel** — Open via `Ctrl+Shift+P` > "Commands: Open Panel" or from the sidebar
- **Sidebar View** — Always-visible command list in the Activity Bar
- **Multiple command types** — `terminal` (default shell), `node`, `pwsh` (PowerShell)
- **Grouped commands** — Organize commands into collapsible groups
- **Add commands from UI** — Click `+` to add new commands without editing JSON
- **Terminal reuse** — Re-running a command reuses its existing terminal
- **Auto-refresh** — File watcher detects changes to `commands.json` and `package.json`
- **Theme-aware** — Uses VSCode CSS variables for native look in any theme

## Getting Started

1. Open a workspace folder in VSCode
2. Create a `commands.json` file in the workspace root (see format below)
3. Open the Commands panel from the sidebar or command palette

## commands.json Format

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
| `type` | `"terminal"` \| `"node"` \| `"pwsh"` | yes | Shell type |
| `group` | string | no | Group name for organizing (default: "General") |
| `cwd` | string | no | Working directory relative to workspace root |

## package.json Scripts

Scripts from `package.json` are automatically imported under the "npm scripts" group. For example, a script `"build": "tsc -p ./"` appears as `npm run build`.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `commandsExtension.configFile` | `commands.json` | Path to commands config file (relative to workspace root) |
