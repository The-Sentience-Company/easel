#!/usr/bin/env bash
# Update the daemon's own checkout: pull, deps, assets, then re-install to converge.
# Self-locating like install.sh — `easel update` always updates the installed root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.sentience.easeld.plist"

before="$(git -C "$ROOT" rev-parse --short HEAD)"
git -C "$ROOT" pull --ff-only
after="$(git -C "$ROOT" rev-parse --short HEAD)"
if [ "$before" = "$after" ]; then
  echo "easel: already at $after"
else
  echo "easel: $before -> $after"
fi

(cd "$ROOT" && npm install --no-audit --no-fund)
(cd "$ROOT" && node render/build-excalidraw.mjs)

# Carry the installed agent's settings into the re-install; explicit env still wins.
plist_env() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PLIST" 2>/dev/null || true; }
if [ -f "$PLIST" ]; then
  v="$(plist_env EASEL_PORT)";     [ -n "$v" ] && export EASEL_PORT="${EASEL_PORT:-$v}"
  v="$(plist_env EASEL_DATA_DIR)"; [ -n "$v" ] && export EASEL_DATA_DIR="${EASEL_DATA_DIR:-$v}"
  v="$(plist_env EASEL_NODE)";     [ -n "$v" ] && export EASEL_NODE="${EASEL_NODE:-$v}"
fi

# install.sh is the single converge path: plist + CLI shim + restart + health wait.
exec "$ROOT/install/install.sh"
