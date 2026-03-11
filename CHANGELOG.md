# Changelog

All notable changes to Commands Extension are documented here.

## [0.0.12] - 2026-03-11

### Added
- **Search & filter** — filter commands by name, command text, or group name directly from the toolbar
- **Context menu for all commands** — right-click any command (custom, npm scripts, PowerShell) to access actions
- **Run confirmation** — enable per-command confirmation dialog via context menu; lock icon indicator on protected commands
- **Favorites from context menu** — add/remove favorites via right-click (in addition to the star button)
- **Stop terminal from context menu** — stop running terminals via right-click
- **Delete individual commands** — remove custom commands via context menu (not just entire groups)
- **Command count badge** — group headers show command count on hover
- **Search clear button** — clear search input with one click

### Changed
- **Deduplicated providers** — sidebar and panel now share `WebviewMessageHandler` (~200 lines removed)
- **Async file operations** — all `fs.*Sync` calls replaced with `fs.promises.*` + `Promise.all()` for parallel loading
- **Integrated search bar** — search is part of the toolbar row, no duplicate "Commands" title

## [0.0.11] - 2025-02-23

### Added
- Active terminal indicator (green dot + close button on running commands)
- Terminal status tracking with `onDidChange` events

## [0.0.10] - 2025-02-22

### Fixed
- PowerShell (`pwsh`) support on macOS

## [0.0.9] - 2025-02-22

### Added
- Auto-detect `.ps1` scripts in workspace root (PowerShell scripts group)
- File watcher for `.ps1` files — auto-refresh on add/remove
- Source tracking per group (`commands-list.json`, `package.json`, `ps1-scripts`)

## [0.0.8] - 2025-02-22

### Added
- Favorites system — star commands to pin them to a Favorites group at the top
- Move commands between groups via right-click context menu
- Delete entire groups with confirmation dialog
- Collapsible groups with persistent state across sessions
- Collapse/expand all groups button
- Add commands from UI (+ button in toolbar)

## [0.0.7] - 2025-02-22

### Added
- Marketplace templates — recommended command sets for React, Node.js, Next.js, Docker, Expo, Python, Git, and more
- Resizable marketplace panel with drag handle
- Expandable template groups with individual command adding
- Hover tooltips on templates and commands

### Changed
- Complete UI redesign — new layout with toolbar, groups, and bottom marketplace panel
- Renamed config file from `commands.json` to `commands-list.json`

## [0.0.6] - 2025-02-21

### Added
- Terminal reuse — re-running a command reuses its existing terminal
- Clear all terminals button

### Changed
- Improved JSON parsing with trailing comma tolerance

## [0.0.5] - 2025-02-21

### Fixed
- Package configuration cleanup

## [0.0.4] - 2025-02-21

### Added
- Configurable config file path (`commandsExtension.configFile` setting)

## [0.0.3] - 2025-02-21

### Added
- Initial release
- Sidebar and panel views
- `commands-list.json` support with terminal, node, and pwsh types
- Auto-import `package.json` scripts
- Auto-refresh on file changes
