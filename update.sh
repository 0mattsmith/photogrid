#!/bin/bash
# Commit any local changes and push to the existing GitHub repo.
# Pages then redeploys automatically via the included Actions workflow.
#
# Usage:
#   bash update.sh                              # auto-generates a timestamped message
#   bash update.sh "Add live preview tweaks"    # use your own commit message

set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d .git ]; then
  echo "Error: this folder isn't a git repo yet. Run deploy.sh first." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Error: no 'origin' remote configured. Run deploy.sh first." >&2
  exit 1
fi

MSG="${1:-Update $(date '+%Y-%m-%d %H:%M')}"

# Nothing to do?
if [ -z "$(git status --porcelain)" ]; then
  echo "No local changes. Nothing to commit."
  echo "Pushing in case there are unpushed commits…"
  git push
  exit 0
fi

echo "==> Staging changes…"
git add -A

echo "==> Committing: $MSG"
git commit -m "$MSG"

echo "==> Pushing to origin…"
git push

OWNER_REPO="$(git remote get-url origin | sed -E 's#.*github\.com[:/](.+)\.git$#\1#; s#.*github\.com[:/](.+)$#\1#')"
echo ""
echo "Pushed. Pages will redeploy in ~30s:"
echo "  https://github.com/${OWNER_REPO}/actions"
