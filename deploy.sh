#!/bin/bash
# One-time deploy: creates a public GitHub repo from this folder, pushes it,
# and enables GitHub Pages. Requires `gh` (GitHub CLI) to be authenticated.
#
# Usage:
#   bash deploy.sh photogrid          # repo name (defaults to "photogrid")
#   bash deploy.sh photogrid private  # second arg = "private" if you want it private

set -euo pipefail

REPO_NAME="${1:-photogrid}"
VISIBILITY_FLAG="--public"
if [ "${2:-}" = "private" ]; then VISIBILITY_FLAG="--private"; fi

cd "$(dirname "$0")"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI not installed. https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: not logged in to gh. Run:  gh auth login" >&2
  exit 1
fi

# Init local git if needed
if [ ! -d .git ]; then
  git init -b main
  git add .
  git commit -m "Initial commit: PhotoGrid web"
fi

# Create the remote repo and push
echo "==> Creating repo and pushing…"
gh repo create "$REPO_NAME" $VISIBILITY_FLAG --source=. --remote=origin --push

# Enable Pages via Actions workflow (matches .github/workflows/pages.yml)
OWNER="$(gh api user --jq .login)"
echo "==> Enabling GitHub Pages (build_type=workflow)…"
gh api -X POST "repos/$OWNER/$REPO_NAME/pages" \
  -f build_type=workflow 2>/dev/null \
  || gh api -X PUT "repos/$OWNER/$REPO_NAME/pages" -f build_type=workflow

URL="https://$OWNER.github.io/$REPO_NAME/"
echo ""
echo "Repo:  https://github.com/$OWNER/$REPO_NAME"
echo "Site:  $URL  (give it 30–60s for the first deploy to finish)"
echo ""
echo "To redeploy later: just push to main. The workflow handles it."
