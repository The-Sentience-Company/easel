#!/bin/bash
# launchd entrypoint. Resolves node AT LAUNCH rather than baking an interpreter
# path into the plist, so an nvm version switch or prune cannot strand the agent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_node() {
  # 1. explicit override wins
  if [ -n "${EASEL_NODE:-}" ] && [ -x "${EASEL_NODE}" ]; then
    printf '%s\n' "$EASEL_NODE"; return 0
  fi

  # 2. nvm's current default alias, re-read on every launch
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -f "$nvm_dir/alias/default" ]; then
    local alias_target version candidate
    alias_target="$(cat "$nvm_dir/alias/default")"
    # the alias may name a version, a codename, or another alias
    for candidate in "$alias_target" "$(cat "$nvm_dir/alias/$alias_target" 2>/dev/null || true)"; do
      [ -n "$candidate" ] || continue
      version="${candidate#v}"
      if [ -x "$nvm_dir/versions/node/v$version/bin/node" ]; then
        printf '%s\n' "$nvm_dir/versions/node/v$version/bin/node"; return 0
      fi
    done
    # alias points at a line like "lts/*" — fall through to newest installed
  fi

  # 3. newest node nvm has installed
  if [ -d "$nvm_dir/versions/node" ]; then
    local newest
    newest="$(find "$nvm_dir/versions/node" -maxdepth 1 -type d -name 'v*' 2>/dev/null \
      | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)"
    if [ -n "$newest" ] && [ -x "$newest/bin/node" ]; then
      printf '%s\n' "$newest/bin/node"; return 0
    fi
  fi

  # 4. system-wide installs
  local p
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$p" ] && { printf '%s\n' "$p"; return 0; }
  done

  # 5. whatever PATH offers
  command -v node 2>/dev/null && return 0

  return 1
}

if ! NODE_BIN="$(resolve_node)"; then
  # Exit 0 deliberately: KeepAlive {SuccessfulExit:false} respawns on ANY
  # non-zero status, so a config exit code hot-loops forever. The log is the signal.
  echo "easeld: FATAL no usable node interpreter found — not starting" >&2
  echo "  looked at: \$EASEL_NODE, ${NVM_DIR:-$HOME/.nvm}, /opt/homebrew, /usr/local, /usr/bin, \$PATH" >&2
  echo "  fix: install node or set EASEL_NODE, then: launchctl kickstart -k gui/$UID/com.sentience.easeld" >&2
  exit 0
fi

echo "easeld: node $("$NODE_BIN" --version) at $NODE_BIN"
exec "$NODE_BIN" "$ROOT/daemon/server.js"
