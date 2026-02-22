# Commands Extension — Fix Plan

## High Priority (Core Implementation)

- [x] Project scaffold: package.json, tsconfig.json, .vscode/launch.json
- [ ] Define TypeScript interfaces: CommandDefinition, CommandGroup, CommandSource in `src/types.ts`
- [ ] Implement `src/commandsProvider.ts` — load commands from `commands.json` file
- [ ] Implement `src/commandsProvider.ts` — load commands from `package.json` scripts section
- [ ] Implement `src/commandsProvider.ts` — merge both sources into unified command list
- [ ] Implement `src/webviewPanel.ts` — create Webview panel class (singleton pattern)
- [ ] Implement `src/webviewPanel.ts` — generate HTML with grouped command buttons
- [ ] Implement `src/webviewPanel.ts` — handle postMessage from webview to run commands
- [ ] Implement `src/extension.ts` — activate: register command, create panel on invoke

## Medium Priority (Features)

- [ ] Create `media/main.js` — webview UI logic: render commands, handle button clicks, postMessage
- [ ] Create `media/main.css` — styles using VSCode CSS variables (--vscode-button-*, --vscode-editor-*)
- [ ] Terminal execution: launch commands via `vscode.window.createTerminal()` + `terminal.sendText()`
- [ ] PowerShell support: create terminal with `{ shellPath: 'pwsh' }` for pwsh command type
- [ ] FileSystemWatcher: watch `commands.json` and `package.json` for changes, auto-refresh webview
- [ ] Webview UI: group commands by group field, show group headers
- [ ] Webview UI: show running indicator when command is launched

## Low Priority (Polish)

- [ ] Error handling: graceful fallback when commands.json is missing or invalid JSON
- [ ] Error handling: show info message when no workspace is open
- [ ] Refresh button in webview toolbar
- [ ] Support `cwd` field in command definition for custom working directory
- [ ] Create `commands.example.json` as reference for users
- [ ] Extension icon and README for marketplace

## Completed

- [x] Project initialization (git, .gitignore, directories)

## Notes
- Use VSCode API idioms: Disposable pattern, configuration API
- Webview must use nonce-based CSP for security
- All webview resources (JS, CSS) must use `webview.asWebviewUri()` for proper paths
- Keep webview JS minimal — heavy logic stays in extension TypeScript
- Test by pressing F5 to launch Extension Development Host
