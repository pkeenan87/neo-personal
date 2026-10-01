#!/usr/bin/env bash
# Sets `run=true|false` in $GITHUB_OUTPUT: whether this change touches anything the desktop jobs
# care about (the Rust and UI sources, the list data the agent embeds, or the CI workflow itself).
# All the desktop jobs always start (the "All checks passed" aggregator treats a skipped job as a
# failure), then skip their real work when this says false.
#
# Needs a checkout with history (fetch-depth: 0). Env: EVENT (github.event_name),
# BASE_SHA (pull request base), BEFORE (push: the previous tip).
set -euo pipefail

out="${GITHUB_OUTPUT:-/dev/stdout}"
paths='^(apps/desktop/|packages/tools/src/data/|\.github/workflows/ci\.yml$|\.github/workflows/desktop-release(-macos)?\.yml$)'

if [[ "${EVENT:-}" == "pull_request" ]]; then
  base="$(git merge-base "${BASE_SHA}" HEAD 2>/dev/null || true)"
else
  base="${BEFORE:-}"
fi

# No usable base (a new branch, a force push, a shallow clone): run, to be safe.
if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "No usable base commit; running the desktop checks."
  echo "run=true" >>"$out"
  exit 0
fi

changed="$(git diff --name-only "$base" HEAD | grep -E "$paths" || true)"
if [[ -n "$changed" ]]; then
  echo "Desktop-related changes since ${base:0:12}:"
  echo "$changed" | head -20
  echo "run=true" >>"$out"
else
  echo "Nothing desktop-related changed since ${base:0:12}; skipping the desktop checks."
  echo "run=false" >>"$out"
fi
