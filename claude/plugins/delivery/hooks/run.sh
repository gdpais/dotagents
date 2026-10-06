#!/bin/sh
# Runs a delivery hook script with bun, passing stdin, stdout and the exit code through.
# Without bun the gates are skipped (exit 0) so they never break the session;
# `run.sh --check` (SessionStart) tells the user once.
BUN=$(command -v bun 2>/dev/null)
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; fi
if [ "$1" = "--check" ]; then
  [ -n "$BUN" ] || echo '{"systemMessage": "delivery plugin: bun not found, so its gates (preflight on stop, commit secret scan, ask before push) are off. Install bun (https://bun.sh) and restart."}'
  exit 0
fi
[ -n "$BUN" ] || exit 0
exec "$BUN" "$@"
