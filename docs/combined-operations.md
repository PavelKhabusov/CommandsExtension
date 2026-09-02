# Combined Operations

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
