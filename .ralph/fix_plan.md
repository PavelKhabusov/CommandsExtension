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
- [x] Extension icon and README for marketplace

---

## BUG FIX: Webview flickering / infinite reload loop

- [x] Fixed: set HTML only ONCE, updates via postMessage only
- [x] Fixed: removed auto-refresh on load, fixed refreshBtn ID mismatch

---

## NEW FEATURE: Sidebar panel (Activity Bar)

- [x] All sidebar tasks complete

---

## FEATURE: Reuse terminals for repeated commands

- [x] All terminal reuse tasks complete (TerminalManager singleton)

---

## UI REDESIGN: VSCode-native button style + command subtitle

### Requirement
Restyle command buttons to look native to VSCode — like list items in the Explorer or Source Control panels, NOT like colored action buttons. Show the command text as a subtitle. The current `--vscode-button-background` blue buttons look out of place.

### Implementation Plan

- [x] Restyle `media/main.css` — command items as LIST ROWS, not buttons. Follow VSCode native patterns:
  - Remove `--vscode-button-background` from command items completely
  - Command items should look like rows in VSCode's Explorer/Source Control — transparent background, hover highlight
  - Each command item is a full-width row with: play icon on left, command name, type badge on right
  - Below the name: a subtle subtitle line showing the actual command text (e.g. `npm run build`) in `--vscode-descriptionForeground`
  - Hover state: `var(--vscode-list-hoverBackground)` — same as hovering a file in Explorer
  - Active/pressed: `var(--vscode-list-activeSelectionBackground)` with `var(--vscode-list-activeSelectionForeground)`
  - Running state: subtle animated left-border accent (2px `--vscode-progressBar-background`) instead of opacity change
  - Group headers: keep as-is (uppercase, muted, collapsible) — they already look native
  - Remove rounded pill shape — use rectangular full-width rows
  - Toolbar: keep sticky, add a `+` (add command) button next to refresh

- [x] Update `media/main.js` — change rendered HTML structure for command items:
  - Each command renders as a `<div class="cmd-item">` (not `<button>`) containing:
    - `<span class="cmd-icon">▶</span>` — play triangle on the left (use CSS, not codicon to keep it simple)
    - `<div class="cmd-info"><span class="cmd-name">Build Project</span><span class="cmd-subtitle">npm run build</span></div>`
    - `<span class="cmd-badge">node</span>` — type badge only for non-terminal types, on the right
  - Add click handler on the whole `.cmd-item` row
  - Add `+ Add Command` button in toolbar that sends `{ type: 'addCommand' }` message to extension

- [x] Responsive: in sidebar, items are always full-width (they already would be as rows). No special handling needed.

---

## NEW FEATURE: Add Command UI (inline form in webview)

### Requirement
Users should be able to add new commands to `commands.json` directly from the webview panel, without manually editing the file. A `+` button in the toolbar opens an inline form.

### Implementation Plan

- [x] Add `+ Add Command` button to toolbar in webview HTML (both `webviewPanel.ts` and `sidebarProvider.ts`)
- [x] In `media/main.js`: when `+` is clicked, show an inline form at the top of the commands container:
  - Input: "Command name" (text, required)
  - Input: "Command" (text, required, placeholder: `npm run build`)
  - Select: "Type" (terminal / node / pwsh, default: terminal)
  - Input: "Group" (text, optional, placeholder: `General`)
  - Two buttons: "Save" and "Cancel"
  - Form styled with VSCode input variables (`--vscode-input-background`, `--vscode-input-border`, `--vscode-input-foreground`)
  - On "Save": send `{ type: 'addCommand', name, command, cmdType, group }` to extension
  - On "Cancel": hide the form
- [x] In `src/webviewPanel.ts` and `src/sidebarProvider.ts`: handle `addCommand` message:
  - Read current `commands.json` from workspace root (create file if it doesn't exist)
  - Parse existing commands array
  - Append new command: `{ name, command, type, group }`
  - Write updated `commands.json` back to disk with `JSON.stringify(data, null, 2)`
  - FileSystemWatcher will auto-trigger refresh of both panels
- [x] Created shared `addCommandToFile()` utility in `src/commandsProvider.ts` that both panels call

---

## Completed

- [x] Project initialization (git, .gitignore, directories)

## NEW FEATURE: Command Marketplace (встроенные шаблоны команд)

### Requirement
Внутри расширения нужен раздел «Marketplace» — аккордион-секция (по аналогии с «Рекомендуемые» в поиске расширений VSCode), содержащая готовые шаблоны/заготовки команд. Это позволит пользователям в новых проектах быстро добавлять целый стек нужных команд, а не создавать их вручную по одной.

### Что должно быть:
1. **Аккордион «Marketplace»** в sidebar/webview — сворачиваемая секция под основными командами
2. **Группы шаблонов** (например: «React», «Node.js Backend», «Docker», «Testing», «Git Hooks», «Linting») — каждая группа содержит набор связанных команд
3. **Отдельные команды-шаблоны** вне групп — универсальные полезные команды
4. **При наведении (hover) на группу** — показывать tooltip/popup со списком всех команд группы
5. **Счётчик команд** — в шапке каждой группы справа отображать badge с количеством команд в группе (например: `React (5)`)
6. **Кнопка «Добавить»** — у каждой группы и отдельной команды, добавляет все команды группы (или одну команду) в `commands.json` проекта
7. **Встроенные шаблоны** — захардкоженный набор полезных шаблонов в коде расширения (можно потом расширить через remote-источник)

### Implementation Plan

- [x] Создать `src/marketplace.ts` — модуль с данными шаблонов:
  - Интерфейс `TemplateGroup { id, name, description, icon, commands: CommandDefinition[] }`
  - Захардкоженный массив шаблонных групп (React, Node.js, Docker, Testing, Linting, Git Hooks)
  - Функция `getMarketplaceTemplates()` возвращающая все доступные шаблоны

- [x] Обновить `media/main.js` — рендеринг секции Marketplace:
  - Аккордион-секция «Marketplace» внизу списка команд
  - Каждая группа — сворачиваемый элемент со значком, названием, описанием и badge-счётчиком команд справа
  - Кнопка «+» у группы (добавить все) и у каждой отдельной команды
  - При клике отправка `addTemplateGroup` / `addTemplateCommand` в extension

- [x] Обновить `media/main.css` — стили для Marketplace:
  - Секция-аккордион с collapsible header
  - Badge-счётчик: `--vscode-badge-background` / `--vscode-badge-foreground`
  - Кнопка «+» появляется при hover
  - Визуальное разделение между основными командами и Marketplace

- [x] Обновить `src/sidebarProvider.ts` и `src/webviewPanel.ts`:
  - Передача шаблонов через `{ type: 'updateMarketplace', templates }`
  - Обработка `addTemplateGroup` и `addTemplateCommand` с вызовом `addCommandToFile()`
  - Уведомление об успешном добавлении

- [x] Наполнить начальный набор шаблонов:
  - **React**: Dev Server, Build, Test, Lint, Format
  - **Node.js Backend**: Start, Dev, Build, Test, DB Migrate
  - **Docker**: Docker Build, Docker Up, Docker Down, Docker Logs
  - **Testing**: Test, Test Watch, Test Coverage
  - **Linting & Formatting**: Lint, Lint Fix, Format, Typecheck
  - **Git Hooks**: Prepare, Pre-commit, Pre-push

---

## Notes
- Use VSCode API idioms: Disposable pattern, configuration API
- Webview must use nonce-based CSP for security
- All webview resources (JS, CSS) must use `webview.asWebviewUri()` for proper paths
- Keep webview JS minimal — heavy logic stays in extension TypeScript
- Test by pressing F5 to launch Extension Development Host
- For sidebar: use `WebviewViewProvider` interface, not `WebviewPanel`
- Command items should look like VSCode list items (Explorer, Source Control), NOT like primary action buttons
- The `+` button and inline form follow the same pattern as "New File" in Explorer
