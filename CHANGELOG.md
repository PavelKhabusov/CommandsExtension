# Changelog

All notable changes to Commands Extension are documented here.

## [0.0.18] - 2026-08-31

### Added
- **SQL Console** — a server carrying an `sql` block (`database`, `dbUser`, `dbPassword`) puts a database button in the Server Uploads section header, opening a panel with two tabs. **Query** is a phpMyAdmin-style box with SQL syntax highlighting (keywords, strings, backtick identifiers, numbers, functions, types and comments): `Run` or `Ctrl+Enter`, a selected fragment runs alone, each statement gets its own result table, and a failing statement stops the batch and shows the full MySQL error. The batch runs in one session, so user variables, `PREPARE`/`EXECUTE`, temporary tables and transactions carry across statements. Each result table has a **Copy** button and a multi-statement batch adds **Copy all results**, both emitting markdown tables (literal `NULL`, flattened newlines, escaped pipes) that paste straight into a chat or an issue. Long values stay on one line until a cell is clicked, so scrolling past a table of serialized blobs doesn't reflow it. **Export** dumps the database with two toggles — Schema and Data, never both off — into a folder asked for once and remembered per workspace, with live progress and a summary of size, duration and table count. Everything runs **on the server over SSH** — `mysqldump` and `gzip` included — so only compressed bytes cross the network; against a remote database over the internet that is the difference between seconds and minutes, since every client round-trip otherwise pays network latency. Requires SSH access and your public key installed (`ssh-copy-id user@host`); connections use `BatchMode`, so a missing key reports an error instead of hanging on a password prompt. Connection failures come back with the command that fixes them — the `ssh-copy-id` line for that exact login on a refused key, `ssh-keygen -R` on a changed host key — and rejected database credentials are named as such rather than mistaken for the SSH login. A dump is verified after download: a missing completion marker (truncated transfer) or tables without a `PRIMARY KEY` are reported, since restoring such a dump silently reproduces the damage. **Browse** pages through a table phpMyAdmin-style: a table picker with row counts, search that runs **on the server across every column** (so it finds matches anywhere in the table, not just the page on screen), click-to-sort headers, a 25/50/100/250/500 page size and first/prev/next/last plus a page-number box. Right-clicking a `.sql` file offers **Run SQL File in Console**, which opens the panel with the file loaded into the Query tab (unsaved editor changes included) without executing it. When several servers configure `sql`, the panel gets a server switcher.
- **Parallel steps in Combined Operations** — command steps now have a **wait** checkbox in the editor. Leave it on (default) and the step blocks until the command exits; uncheck it and the command runs in the background so the next step starts immediately — e.g. a backend and a frontend dev server side by side. Backgrounded steps are marked `∥` in the step list and persist as `"wait": false` in `commands-list.json`.

### Changed
- **Documentation reorganised** — the long reference sections (Server Uploads, Combined Operations, Claude Hooks Manager) moved out of the README into [`docs/`](docs/), with the former `future.md` ideas backlog as [`docs/roadmap.md`](docs/roadmap.md). The README drops from ~525 to ~290 lines.

### Fixed
- **Quick / spec uploads clear the modified badge** — Quick Upload and Quick Upload from Spec bypass the regular upload runner, so files they sent stayed flagged "modified" in the sidebar. They now mark the uploaded files as synced in every configured upload whose scope covers them.
- **Branch switches no longer flag everything as modified** — snapshots keep a sha1 per uploaded file, so an mtime bump with identical content (typically `git checkout` / branch switching) heals itself instead of lighting up the whole tree.
- **No server pre-scan on partial uploads** — `skipUnchanged` sizing is a full-run optimisation; partial (Modified/filtered) uploads already know exactly what changed, so they no longer pay for a remote scan.

## [0.0.17] - 2026-08-27

### Added
- **Bound stop command** (`"stop": "<name>"` on a command) — while a start command is running, its card shows a red ⏹ Stop icon that closes its terminal and runs the named stop command (resolved by name, like combined-op steps). Several starts can share one stop (project start variants → one "Stop"), and on/off pairs (a service "up" bound to its "down") toggle from a single icon. When the stop command finishes (via Shell Integration), its own terminal is auto-closed — leaving one empty terminal if it was the last, so the terminal panel doesn't collapse.
- **Hidden commands** (`"hidden": true`) — keep a command out of the list (e.g. a stop command reached only via another command's Stop icon); a group left empty by hiding is dropped.
- **Open source from group header** — a pencil on each group header opens the file its commands come from: `commands-list.json` for custom groups, `package.json` for the npm scripts group. The count badge moved to the far right with the header icons to its left.

### Changed
- **Quick Upload from Spec grouped by server** — spec pairs are now grouped by server, so every file bound for one server uploads over a single connection in one run even when their remote dirs differ. A spec pasted into the "What to upload?" picker (or already on the clipboard) is recognised there, and the input box shows a live preview grouped by server («server» dir ← files).

## [0.0.16] - 2026-07-10

### Added
- **Quick Upload** (`Commands Extension: Quick Upload`, `commandsExtension.quickUploadFiles`) — send untracked files or a folder to an arbitrary server path without adding a config entry: pick files/folder, choose the target server, type the remote dir. A header button (⬆) on the Server Uploads section triggers it too.
- **Quick Upload from Spec** (`commandsExtension.quickUploadFromSpec`) — paste a one-line spec `local-path => server:remote-dir` (several pairs separated by `;`, `#`-comments ignored) and upload straight away. The dialog shows a live parse preview (per-pair target / unknown-server / format errors) as you type, and offers a third "From spec" mode inline.
- **Mark all synced** — header button that clears the modified/new indication across all uploads at once.

- **Mirror deploys** (`"mode": "mirror"` on an upload) — after a full upload the runner walks `remoteDir`, deletes remote files that don't exist locally and prunes now-empty directories. Built for hashed-build deploys (Next.js `out/`, Vite `dist/`): stale `_next/static/<hash>` chunks from previous builds no longer pile up on the server. `protectRemote` globs (relative to `remoteDir`) mark server-side files that must never be deleted; `.htaccess` is always protected implicitly. Mirror is skipped on partial (auto/set-cover) uploads — deletion only runs when the full local state is known. The done-message reports `mirror: removed N stale`.
- **Parallel transfers** (`"connections": N`, 1–8) — the runner opens a pool of FTP/SFTP connections and distributes the file queue between them (default 4 for ftp/ftps, 2 for sftp). Directory creation is cached per deploy instead of an `ensureDir`+`cd` round-trip per file — the old behaviour made many-small-files deploys crawl.
- **`skipUnchanged` globs** — files matching the globs whose remote size equals the local size are skipped. Meant for content-hashed paths (`_next/static/**`): repeat deploys upload only new chunks and HTML instead of re-pushing tens of MB. The done-message reports `skipped N unchanged`.

### Changed
- **Server-grouped uploads panel** — the Server Uploads section is now grouped by server: each group shows a header with the group name and, on its own line beneath, the server login *once* (instead of repeating `user@host` on every card). The "Upload only N modified" action moved to the right of that header (with the modified-file list on hover). Upload cards dropped the inline path/login — the remote path plus items/excludes are shown on hover over the card name — and every card keeps a single consistent status line: `N files tracked` when idle, `⚠ N files modified` when stale, live progress while running, or the last result.
- **rsync trailing-slash semantics for folder items** — a folder item now respects a trailing slash like rsync: `"folder/"` uploads the folder's *contents* into `remoteDir` (previous behaviour), while `"folder"` keeps the folder name on the server. Fixes folders being flattened to the remote root; configs relying on content-merge just add a trailing slash.
- **English UI** — quick-upload dialogs, the spec preview, and progress phases are in English.

### Fixed
- **Glob items ignore VS Code exclude settings** — glob upload items now walk the filesystem directly instead of `workspace.findFiles`, so files inside gitignored / `files.exclude`d folders are found; paths are preserved relative to the glob's literal base.

## [0.0.15] - 2026-06-08

### Added
- **Claude Hooks Manager** — new section in the panel for managing Claude Code hooks (`Stop`, `SubagentStop`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `SessionStart`, `SessionEnd`, `PreCompact`) across `.claude/settings.json`, `.claude/settings.local.json`, and `~/.claude/settings.json`. Each hook has a real toggle switch (backed by `workspaceState` cache so disabled hooks survive across sessions, with stable ordering so the row doesn't jump when toggled), inline editor with event/matcher/target/action picker and editable shell script field, and 5 presets (Play sound, Desktop notification, Append timestamp, Wait N seconds, Open URL/file/app) plus "Existing command" linkage that pulls the actual script body from `commands-list.json`. Header buttons: `+` add, `📋` paste from clipboard, `🌍` show user-global hooks (off by default — keeps your project view focused), `📂` quick-open any of the three settings files. Section intro + per-event descriptions explain what each hook does. Per-card features: clickable script paths (`.sh`/`.py`/etc., with `$CLAUDE_PROJECT_DIR` and `~/` expansion) open the script in the editor; color-coded project / local / user-global pills open the underlying settings file; right-click → Edit / Copy to clipboard / Delete. Writes to `~/.claude/settings.json` ask for confirmation the first time.
- **Combined Operations** — new section in the panel for composite commands that mix terminal commands, server uploads (full or auto/set-cover), VS Code commands, and native helpers (wait, open URL/file/app, play sound, notification) into ordered sequences (8 step types total). Inline drag-to-reorder editor with "Add step ▾" submenu; per-step toggle so individual steps can be skipped without removal; per-step progress in the card ("Running 2/3: …" with the standard upload progress bar inline when the current step is an upload), `stopOnError` toggle, Cancel mid-run. Terminal command steps use VS Code Shell Integration to wait on exit codes; falls back to fire-and-go when SI is unavailable. The `vscode-cmd` step lets a combined op invoke any registered VS Code command (e.g. `workbench.action.reloadWindow` after a local install) — pick via the native quickPick over all 1000+ command IDs. The `wait` / `open` / `sound` / `notification` editors use native `showInputBox` / `showQuickPick` (replacing `window.prompt`, which doesn't work in VS Code webviews). Defined in `commands-list.json` under a new `combined` field. Published to `commandsExtension.externalApiUrl` as the `combined` array in `/events/commands` + a new `/events/combined-progress` event so external hubs can render read-only cards and live progress.
- **Cross-platform helpers** — new `src/platformHelpers.ts` detects available system utilities (sound, notification, open) per OS and provides fallback chains; ⚠ icons in the editor submenu mark presets whose underlying tool isn't installed. On Linux, `open app` uses `gtk-launch` with a binary-name fallback (instead of `xdg-open`, which only handles URLs/files). README documents apt/dnf/pacman install commands.
- **Upload a single file from right-click** — new "Commands Extension: Upload to Server" context-menu command on any tracked file (Explorer, editor body, and editor tab menus). Uploads just that one file to the exact remote location it maps to; when several servers cover the file you pick the target. Only shown in projects that define server uploads.
- **External hub integration** — optional `commandsExtension.externalApiUrl` lets the extension POST upload progress, the merged command list, and per-upload staleness/recommendations to an external HTTP service. Includes instant republish on changes and a 30s heartbeat so the hub survives restarts.
- **Modified-files hover** — hovering an auto-upload card lists the files changed since the last sync.

### Changed
- **Server name in upload cards** — the card subtitle now shows the referenced server name before the account (`server · user@host · /remote/dir`) so it's clearer which server an upload targets.
- **Auto-fit upload block height** — the Server Uploads block grows to fit all cards instead of clipping.
- **`workspacePath` in events** — upload events now carry the workspace path so the hub can apply per-project rules (e.g. keep VPN on for some projects).

### Fixed
- **Mark as synced** — no longer a no-op for uploads that had no prior snapshot.

## [0.0.14] - 2026-05-11

### Added
- **File staleness tracking** — the extension tracks which uploaded files have changed since the last successful upload, marking each upload as stale or clean and showing the stale count.
- **Smart auto-upload** — a generated "Upload Modified" action per server uploads only the files changed since the last sync, instead of re-sending everything.
- **New-in-scope detection** — files that newly match an upload's `items` patterns are detected and surfaced as pending upload.
- **Cross-config propagation** — staleness propagates across multiple upload configs that share the same files.

## [0.0.13] - 2026-05-05

### Added
- **Server Uploads** — new section between commands and Recommended for FTP / FTPS / SFTP file uploads. Define per-project targets in `server-uploads.local.json`; click an entry to upload, watch live progress (%, current file, transfer speed), cancel mid-flight.
- **Cross-platform** — pure-JS `basic-ftp` and `ssh2-sftp-client` libraries, no FileZilla CLI or external tools required.
- **Shared servers** — top-level `servers` array; uploads reference a server by `server: "name"` instead of duplicating host / user / password.
- **`exclude` patterns** — per-upload glob patterns (e.g. `**/node_modules/**`, `**/*.log`) to skip files inside uploaded folders.
- **Files and folders** — items can be individual files, full directories (uploaded recursively), or glob patterns.
- **Interactive item picking** — folder-with-plus button on each upload opens a native file/folder picker; selections are appended to the config.
- **Passwords in config** — passwords live alongside server definitions in the JSON; the default `.local.json` filename keeps it out of git for most ignore presets.
- **Edit/create config from UI** — pencil/plus icon next to the section header opens or creates `server-uploads.local.json`.

### Changed
- **Recommended section collapsed by default** — to keep the sidebar focused; a small "templates" hint badge nudges discovery without distraction.
- **`uploadsFile` setting** — new `commandsExtension.uploadsFile` config (default `server-uploads.local.json`, kept out of git by `.local.json` ignore patterns).

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
