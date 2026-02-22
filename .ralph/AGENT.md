# Agent Build Instructions

## Project Setup
```bash
npm install
```

## Build / Compile
```bash
npm run compile
```
This compiles TypeScript from `src/` to `out/` via `tsc`.

## Watch Mode (continuous compilation)
```bash
npm run watch
```

## Running / Testing the Extension
There is no automated test suite. Testing is manual:

1. Open the project folder in VSCode
2. Press **F5** to launch Extension Development Host
3. In the new VSCode window, open a project that has `commands.json` or `package.json` with scripts
4. Press `Ctrl+Shift+P` → type "Commands: Open Panel"
5. Verify the webview panel opens with command buttons
6. Click a command button → verify a terminal opens and runs the command

## Verification Checklist
- [ ] `npm run compile` passes with zero errors
- [ ] Extension activates without errors in Extension Development Host
- [ ] Webview panel opens via command palette
- [ ] Commands from `commands.json` are displayed
- [ ] Commands from `package.json` scripts are displayed
- [ ] Clicking a command opens a terminal and executes it
- [ ] PowerShell commands open in a pwsh terminal
- [ ] File changes to `commands.json` auto-refresh the webview

## Key Learnings
- VSCode extensions require `"main": "./out/extension.js"` in package.json
- Webview resources must use `webview.asWebviewUri()` for correct paths
- Content Security Policy (CSP) with nonce is required for webview scripts
- Use `vscode.workspace.onDidChangeConfiguration()` for settings changes
- FileSystemWatcher via `vscode.workspace.createFileSystemWatcher()`
