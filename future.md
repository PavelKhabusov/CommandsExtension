# Future ideas

Things considered during Combined Operations + Claude Hooks Manager
design but intentionally left out of MVP. Pick up if/when a real need
shows up.

## Combined Operations

- **Conditional steps** — `if/else` between steps (skip if file doesn't
  exist, skip if last step exit code != 0, etc.).
- **Parameterization** — pass input from one step into the next
  (capture stdout, env vars, file paths).
- **Parallel steps** — run a group of steps concurrently and wait for
  all to finish before proceeding.
- **Import / export operations between workspaces** — copy a combined
  op definition to clipboard or via quickPick over recent workspaces
  (mirrors what Claude Hooks already does for hook specs).
- **Operation "Run + Save"** — a button in the editor that saves the
  op and immediately runs it in one click, without closing the modal.

## Claude Hooks Manager

- **Copy to another project via quickPick** — pick a recent workspace
  and paste the hook directly into its `settings.json`. Today copy/paste
  is clipboard-only.
- **Matcher regex validation** — validate the matcher field on Save
  and surface a clear error before the hook reaches `settings.json`.
- **Webhook executor / CLI runner** — invoke hooks from outside VS Code
  (e.g. a CLI tool) so they can be tested without firing a real
  Claude session.
- **Hook registry / marketplace** — shared catalog of common hooks
  (notify-done, auto-push, etc.) you can install with one click.
- **Conditional hooks** — only run if a file exists, only on certain
  branches, etc.
- **VS Code variable substitution** — let hook commands reference
  `${workspaceFolder}`, `${file}`, etc., resolved before the shell
  sees them.
- **Trigger history / logs** — view of recent firings (event +
  timestamp + exit code) for diagnostics.

## Cross-platform

- **Bundle a small audio file** with the extension and play it via
  Node, so `sound` step works on machines without paplay/afplay/
  PowerShell beep.
- **BurntToast auto-install** prompt on Windows when the user enables
  a `notification` preset/step and the module isn't installed.

## External API consumers

- **Combined-op cancel from external consumers** — the
  `commandsExtension.externalApiUrl` integration already publishes
  combined ops (`/events/commands`) and live progress
  (`/events/combined-progress`), and the SSE `run-command` channel can
  start an op by name. Cancellation is still local-only; expose it
  through the same SSE channel (e.g. a `cancel-command` event).
