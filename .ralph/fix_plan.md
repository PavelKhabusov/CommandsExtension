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

## Completed

- [x] Project initialization (git, .gitignore, directories)

## Notes
- Use VSCode API idioms: Disposable pattern, configuration API
- Webview must use nonce-based CSP for security
- All webview resources (JS, CSS) must use `webview.asWebviewUri()` for proper paths
- Keep webview JS minimal — heavy logic stays in extension TypeScript
- Test by pressing F5 to launch Extension Development Host
