# Claude Hooks Manager

Manage [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
from the panel instead of editing `settings.json` by hand. The **Claude Hooks**
section lists every hook found in:

| File                             | Source label |
|----------------------------------|--------------|
| `.claude/settings.json`          | 📁 project (committed)             |
| `.claude/settings.local.json`    | 🔒 local (gitignored)              |
| `~/.claude/settings.json`        | 🌍 user-global (all your projects) |

By default the section shows only **project** + **local** hooks — the ones
actually scoped to this workspace. User-global hooks (shared across every
project on your machine) are hidden behind the `🌍` toggle in the header
to keep your project view focused. Toggle it on to also list them.

Section header buttons (visible on hover):

| Button | What it does |
|--------|--------------|
| `+`    | Open the editor to add a new hook                                              |
| `📋`   | Paste a hook JSON from clipboard (opens the editor pre-filled)                |
| `🌍`   | Toggle visibility of user-global hooks                                        |
| `📂`   | Quick-open any of the three `settings.json` files (no hook needed)            |

Each card has:
- a **toggle switch** to disable / re-enable the hook (disabled hooks are
  pulled out of `settings.json` and cached in workspace state; toggling on
  restores them; the row stays in the same slot — ordering is stable across
  toggles)
- a **clickable script path** for hooks whose command points to a
  `.sh` / `.py` / `.js` / etc. file (with `$CLAUDE_PROJECT_DIR` and `~/`
  expansion) — click to open the script in the editor
- a colored target pill (📁 blue / 🔒 yellow / 🌍 purple) — click to
  open the underlying `settings.json`
- right-click context menu: **Edit** / **Copy to clipboard** (as JSON) /
  **Delete**

The **+ Add hook** button opens an inline editor where you pick:
1. **Event** — `Stop`, `SubagentStop`, `UserPromptSubmit`, `PreToolUse`,
   `PostToolUse`, `Notification`, `SessionStart`, `SessionEnd`, `PreCompact`.
   Each group shows a short description of when it fires.
2. **Matcher** — optional regex, only relevant for the events that take one.
3. **Target file** — project / local / user-global. Writes to user-global
   ask for confirmation the first time.
4. **Action**:
   - **Preset** — `Play sound`, `Desktop notification`, `Append timestamp`,
     `Wait N seconds`, `Open URL / file / app`. Each preset emits a
     cross-platform shell command (⚠ icon flags presets whose tool isn't
     detected on this OS).
   - **Existing command** — pick one from `commands-list.json`. The
     actual shell script is copied into the hook so you can tweak it
     per-hook without affecting the original command.
   - **Custom shell** — write whatever you want.
5. **Shell script** — multi-line editable, even for presets/command refs.
6. **Timeout** (optional, seconds).

**Copy / paste across projects** — right-click → **Copy to clipboard** writes
a small `{event,matcher,command,timeout}` JSON to the clipboard. In another
project, hit the 📋 button in the **Claude Hooks** section header to open
the editor pre-filled with the pasted spec.
