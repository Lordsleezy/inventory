#!/usr/bin/env bash
# Publish the five Twin Rivers site folders as Lordsleezy GitHub repositories.
# Prerequisites:
#   - gh authenticated as a user/token that can create repos under Lordsleezy
#     OR empty public repos already created with the exact names below
#   - run from this directory
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)/repos"
REPOS=(
  fencingwestsacramento-site
  deckbuildingsacramento-site
  gateinstallationsacramento-site
  citrusheightsfencing-site
  fencessacramentoca-site
)

for repo in "${REPOS[@]}"; do
  dir="$ROOT/$repo"
  echo "======== $repo ========"
  if ! gh repo view "Lordsleezy/$repo" >/dev/null 2>&1; then
    echo "Creating Lordsleezy/$repo ..."
    gh repo create "Lordsleezy/$repo" --public \
      --description "Twin Rivers Fence — $repo" \
      --source "$dir" --remote origin --push
  else
    echo "Repo exists — pushing main ..."
    cd "$dir"
    git init -b main 2>/dev/null || true
    git remote remove origin 2>/dev/null || true
    git remote add origin "https://github.com/Lordsleezy/$repo.git"
    git add -A
    git status --short
    git commit -m "Publish $repo production-ready Twin Rivers site" || true
    git push -u origin main
  fi
  echo "Verify: https://github.com/Lordsleezy/$repo"
done

echo "All publish attempts finished."
