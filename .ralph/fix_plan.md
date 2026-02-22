# Commands Extension — Fix Plan

## High Priority (Core Implementation)

- [x] Project scaffold: package.json, tsconfig.json, .vscode/launch.json
- [x] Define TypeScript interfaces: CommandDefinition, CommandGroup, CommandSource in `src/types.ts`
- [x] Implement `src/commandsProvider.ts` — load commands from `commands.json` file
- [x] Implement `src/commandsProvider.ts` — load commands from `package.json` scripts section
- [x] Implement `src/commandsProvider.ts` — merge both sources into unified command list
- [x] Implement `src/webviewPanel.ts` — create Webview panel class (singleton pattern)
- [x] Implement `src/webviewPanel.ts` — generate HTML with grouped command buttons
- [x] Implement `src/webviewPanel.ts` — handle postMessage from webview to run commands
- [x] Implement `src/extension.ts` — activate: register command, create panel on invoke

## Medium Priority (Features)

- [x] Create `media/main.js` — webview UI logic: render commands, handle button clicks, postMessage
- [x] Create `media/main.css` — styles using VSCode CSS variables (--vscode-button-*, --vscode-editor-*)
- [x] Terminal execution: launch commands via `vscode.window.createTerminal()` + `terminal.sendText()`
- [x] PowerShell support: create terminal with `{ shellPath: 'pwsh' }` for pwsh command type
- [x] FileSystemWatcher: watch `commands.json` and `package.json` for changes, auto-refresh webview
- [x] Webview UI: group commands by group field, show group headers
- [x] Webview UI: show running indicator when command is launched

## Low Priority (Polish)

- [x] Error handling: graceful fallback when commands.json is missing or invalid JSON
- [x] Error handling: show info message when no workspace is open
- [x] Refresh button in webview toolbar
- [x] Support `cwd` field in command definition for custom working directory
- [x] Create `commands.example.json` as reference for users
- [ ] Extension icon and README for marketplace

---

## BUG FIX: Webview flickering / infinite reload loop

### Problem
The webview tab constantly flickers and shows "Loading commands..." because of a reload loop:
1. `_update()` in `src/webviewPanel.ts:79` sets `this._panel.webview.html = this._getHtmlForWebview()` on EVERY update — this completely destroys and recreates the webview DOM
2. When webview loads, `media/main.js:120` sends `vscode.postMessage({ type: 'refresh' })` on script init
3. Extension receives 'refresh' message → calls `_update()` → sets HTML again → webview reloads → sends 'refresh' again → infinite loop

### Fix Required
- [x] In `src/webviewPanel.ts`: set HTML only ONCE in the constructor (first creation). Add a `private _htmlSet: boolean = false` flag. In `_update()`, if HTML is already set, only send postMessage with new commands data — do NOT reassign `this._panel.webview.html`
- [x] In `media/main.js`: remove the `vscode.postMessage({ type: 'refresh' })` call on line 120. Instead, the extension should send the initial commands data right after setting HTML (already does this via setTimeout). Also fixed `refresh-btn` → `refreshBtn` ID mismatch.
- [x] Verify: after fix, opening the panel should show commands instantly without any flicker or "Loading commands..." flash

---

## NEW FEATURE: Sidebar panel (Activity Bar)

### Requirement
The extension should be available in the VSCode sidebar (Activity Bar) in addition to the editor panel. Users should see a dedicated icon in the Activity Bar that opens the commands panel in the sidebar.

### Implementation Plan

- [x] Add `viewsContainers.activitybar` to `package.json` — register a new Activity Bar container with id `commandsExtension` and an icon
- [x] Add `views` to `package.json` — register a webview view `commandsExtension.sidebarView` inside the container
- [x] Create `src/sidebarProvider.ts` — implement `vscode.WebviewViewProvider` with `resolveWebviewView()` method. Reuses the same webview HTML/JS/CSS from `media/`. Loads commands from `commandsProvider.ts` and sends via postMessage (same protocol as the editor panel)
- [x] In `src/extension.ts`: register the sidebar provider via `vscode.window.registerWebviewViewProvider('commandsExtension.sidebarView', provider)`
- [x] Add a simple SVG icon for the Activity Bar (created `media/icon.svg` — terminal prompt icon, 24x24, monochrome)
- [x] Both the sidebar view and the editor panel work independently — opening one does not affect the other
- [x] FileSystemWatcher refreshes both the sidebar and the editor panel when files change

---

## UI REDESIGN: Improved layout and visuals

### Requirement
Make the webview UI more polished and visually appealing, closer to modern VSCode extension panels.

### Implementation Plan

- [ ] Redesign `media/main.css` — modern card-based layout for command groups instead of plain buttons:
  - Group cards with subtle background (`var(--vscode-sideBar-background)` or `var(--vscode-list-hoverBackground)`)
  - Rounded corners (6px) on group containers
  - Better spacing and padding (12px inside groups, 8px between buttons)
  - Command buttons as pill-shaped elements with icon indicators for type (terminal icon, pwsh icon, node icon)
  - Smooth transitions on hover (background color, transform scale)
  - Active/pressed state with subtle inset shadow
  - Running state: animated pulsing border or spinner icon instead of just opacity change

- [ ] Redesign `media/main.js` — improve the rendered HTML structure:
  - Add codicon-based icons for command types (use `vscode-codicons` font which is built into webviews: terminal = `\eab8`, pwsh = `\ea85`, node = `\ea8f`)
  - Show the actual command text as a subtle subtitle under the button name
  - Add a "last run" timestamp for recently executed commands
  - Smooth group collapse animation (CSS max-height transition instead of display:none)
  - Empty state: add a codicon icon and better styled call-to-action

- [ ] Redesign toolbar:
  - Search/filter input field to quickly find commands by name
  - Collapse All / Expand All buttons
  - Toolbar should be sticky at the top when scrolling

- [ ] Responsive sidebar layout: when rendered in the narrow sidebar, buttons should stack vertically (full width). In the wider editor panel, buttons can wrap in a grid

---

## Completed

- [x] Project initialization (git, .gitignore, directories)

## Notes
- Use VSCode API idioms: Disposable pattern, configuration API
- Webview must use nonce-based CSP for security
- All webview resources (JS, CSS) must use `webview.asWebviewUri()` for proper paths
- Keep webview JS minimal — heavy logic stays in extension TypeScript
- Test by pressing F5 to launch Extension Development Host
- For sidebar: use `WebviewViewProvider` interface, not `WebviewPanel`
- Codicon font is available in webviews via `vscode-codicon` — no extra install needed
