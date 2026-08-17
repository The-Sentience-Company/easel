#!/usr/bin/env bash
# Opt-in unattended updater. --run is what launchd invokes on the schedule;
# --enable/--disable/--status manage the agent. Off until a human turns it on.
set -euo pipefail

LABEL="com.sentience.easeld-update"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${EASEL_DATA_DIR:-$HOME/.easel}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$ROOT/install/$LABEL.plist.template"
LOG="$STATE_DIR/auto-update.log"
# The marker means "asked and declined" — its absence is what tells an agent
# the user has never chosen, so it must survive --disable and uninstall.
OPTOUT="$STATE_DIR/auto-update.off"

say() { printf '  %s\n' "$*"; }
stamp() { date '+%Y-%m-%d %H:%M:%S'; }

usage() {
  cat <<EOF
usage: auto-update.sh --enable [--at HH:MM] | --disable | --status | --run

  --enable    register a launchd agent that runs one update pass daily (10:00)
  --disable   remove the agent and record the opt-out
  --status    print one of: on / off / unset
  --run       one unattended pass (what the agent invokes; appends to
              $LOG)
EOF
}

# Escaping and teardown live in install.sh; lift them rather than fork them.
# bootout_if_loaded matters here too: launchd teardown is asynchronous, and an
# immediate re-bootstrap of the same label fails with an I/O error.
eval "$(sed -n '/^xml_escape() {/,/^}/p;/^subst_value() {/,/^}/p;/^bootout_if_loaded() {/,/^}/p' "$ROOT/install/install.sh")"

# 24h HH:MM into HOUR/MINUTE integers (launchd rejects leading zeros as octal-ish).
parse_at() {
  printf '%s' "$1" | grep -qE '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' \
    || { echo "error: --at wants HH:MM (24h), got: $1" >&2; exit 2; }
  HOUR=$((10#${1%%:*})); MINUTE=$((10#${1##*:}))
}

write_agent_plist() {
  sed -e "s|__LABEL__|$(subst_value "$LABEL")|g" \
      -e "s|__ROOT__|$(subst_value "$ROOT")|g" \
      -e "s|__STATE__|$(subst_value "$STATE_DIR")|g" \
      -e "s|__HOUR__|$HOUR|g" \
      -e "s|__MINUTE__|$MINUTE|g" \
      -e "s|__PATH__|$(subst_value "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")|g" \
      "$TEMPLATE" > "$1"
}

autoupdate_status() {
  if [ -f "$PLIST" ]; then
    local h m
    h="$(/usr/libexec/PlistBuddy -c 'Print :StartCalendarInterval:Hour' "$PLIST" 2>/dev/null || echo 0)"
    m="$(/usr/libexec/PlistBuddy -c 'Print :StartCalendarInterval:Minute' "$PLIST" 2>/dev/null || echo 0)"
    printf 'on — daily at %02d:%02d, log: %s\n' "$h" "$m" "$LOG"
  elif [ -f "$OPTOUT" ]; then
    echo "off — declined $(cat "$OPTOUT" 2>/dev/null || true)"
  else
    echo "unset — never configured; \`easel autoupdate on\` enables it, docs/usage.md § Auto-update explains it"
  fi
}

# The whole unattended policy in one function, printed as a single verdict line
# so --run can act on it and tests can assert it without touching launchd.
plan_update() {
  cd "$ROOT"
  [ -z "$(git status --porcelain 2>/dev/null)" ] || { echo "skip: working tree dirty"; return; }
  local branch default upstream head
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || { echo "skip: not a git checkout"; return; }
  default="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  default="${default#origin/}"; [ -n "$default" ] || default=main
  [ "$branch" = "$default" ] || { echo "skip: on $branch, not $default"; return; }
  git fetch --quiet origin 2>/dev/null || { echo "skip: fetch failed"; return; }
  upstream="$(git rev-parse '@{u}' 2>/dev/null)" || { echo "skip: no upstream"; return; }
  head="$(git rev-parse HEAD)"
  [ "$head" != "$upstream" ] || { echo "current $(git rev-parse --short HEAD)"; return; }
  git merge-base --is-ancestor HEAD "$upstream" || { echo "skip: history diverged"; return; }
  echo "update $(git rev-parse --short HEAD) $(git rev-parse --short "$upstream")"
}

run() {
  mkdir -p "$STATE_DIR"
  exec >>"$LOG" 2>&1
  echo "== $(stamp)"
  # Honor an installed node pin the same way update.sh does.
  v="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:EASEL_NODE' \
    "$HOME/Library/LaunchAgents/com.sentience.easeld.plist" 2>/dev/null || true)"
  [ -n "$v" ] && export EASEL_NODE="${EASEL_NODE:-$v}"
  # The launcher owns node resolution; lift it so npm/node under launchd are
  # the same ones the daemon itself would run.
  eval "$(sed -n '/^resolve_node() {/,/^}/p' "$ROOT/install/easeld-launcher.sh")"
  local node_bin plan
  if node_bin="$(resolve_node)"; then
    PATH="$(dirname "$node_bin"):$PATH"; export PATH
  else
    echo "skip: no node interpreter found"; exit 0
  fi
  plan="$(plan_update)"
  echo "$plan"
  case "$plan" in update\ *) ;; *) exit 0 ;; esac
  # The incoming commits, logged before they land — the log is the audit trail.
  git -C "$ROOT" log --oneline 'HEAD..@{u}' | sed 's/^/  + /'
  local before; before="$(cut -d' ' -f2 <<<"$plan")"
  bash "$ROOT/install/update.sh"
  # update.sh pulls again, so origin may have moved past the plan — record what
  # actually landed, or the trail could omit code that is now running.
  echo "landed:"; git -C "$ROOT" log --oneline "$before..HEAD" | sed 's/^/  = /'
  echo "== done $(stamp)"
}

enable_agent() {
  mkdir -p "$STATE_DIR" "$(dirname "$PLIST")"
  local tmp; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
  write_agent_plist "$tmp"
  cp "$tmp" "$PLIST"
  bootout_if_loaded
  launchctl bootstrap "gui/$UID" "$PLIST"
  rm -f "$OPTOUT"
  printf '== %s enabled — daily at %02d:%02d\n' "$(stamp)" "$HOUR" "$MINUTE" >> "$LOG"
  say "auto-update on — daily at $(printf '%02d:%02d' "$HOUR" "$MINUTE"), log: $LOG"
}

disable_agent() {
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  mkdir -p "$STATE_DIR"
  date '+%Y-%m-%d' > "$OPTOUT"
  echo "== $(stamp) disabled" >> "$LOG"
  say "auto-update off — choice recorded, agents will stop suggesting it"
}

MODE="" AT="10:00"
while [ $# -gt 0 ]; do
  case "$1" in
    --enable|--disable|--status|--run) MODE="$1"; shift ;;
    --at) AT="${2:?--at needs HH:MM}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$MODE" in
  --enable) parse_at "$AT"; enable_agent ;;
  --disable) disable_agent ;;
  --status) autoupdate_status ;;
  --run) run ;;
  *) usage >&2; exit 2 ;;
esac
