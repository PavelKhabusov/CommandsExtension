#!/bin/bash
# Auto-commit and push Claude's changes to a separate branch
# Triggered by the "Stop" hook after each Claude response

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# Skip if not a git repo
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Skip if no changes
git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ] && exit 0

# Ensure we're on a claude/* branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != claude/* ]]; then
    CLAUDE_BRANCH="claude/auto-$(date +%Y-%m-%d)"
    git checkout -b "$CLAUDE_BRANCH" 2>/dev/null || git checkout "$CLAUDE_BRANCH" 2>/dev/null || exit 0
    BRANCH="$CLAUDE_BRANCH"
fi

# Commit and push
git add -A
git commit -m "auto: Claude changes $(date '+%H:%M:%S')" --no-verify 2>/dev/null || exit 0
git push -u origin "$BRANCH" --no-verify 2>/dev/null || true

exit 0
