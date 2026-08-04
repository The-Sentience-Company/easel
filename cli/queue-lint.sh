#!/usr/bin/env bash
# queue-lint [file|stdin] — a context-free cheap model flags terms a queue entry
# reader couldn't understand. Exit: 0 clear, 1 flagged, 2 infrastructure error.
set -euo pipefail

MODEL="${QUEUE_LINT_MODEL:-claude-haiku-4-5-20251001}"

if [ $# -ge 1 ] && [ "$1" != "-" ]; then
  entry="$(cat "$1")"
else
  entry="$(cat)"
fi
if [ -z "${entry//[[:space:]]/}" ]; then
  echo "queue-lint: empty entry" >&2
  exit 2
fi

prompt="You are screening one queue entry before it is shown to the project's owner for a decision.
The owner knows their own product and ordinary software-engineering vocabulary, but has NOT followed the day-to-day work — and neither have you. That is the point: shorthand you cannot decode from the entry alone, they cannot either.

FAIL only for invented or internal shorthand that plain English plus general software knowledge cannot decode: code names, color/letter codes, unexplained abbreviations or token IDs (e.g. 'father class red', 'C6', 'the delta stage'). Descriptive English like 'the extraction pipeline card' or 'the schema PR' is fine, and pointing at a linked note or board for detail is fine.
Mark OPTIONS UNCLEAR only if the owner could not tell what choosing an option would cause to happen.

Entry:
---
$entry
---

Reply with exactly these three lines and nothing else:
VERDICT: PASS or FAIL
TERMS: comma-separated undecodable terms, or: none
OPTIONS: CLEAR, or UNCLEAR - one short reason"

out="$(claude -p "$prompt" --model "$MODEL" 2>/dev/null)" || {
  echo "queue-lint: model call failed" >&2
  exit 2
}

verdict="$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*VERDICT:[[:space:]]*//p' | head -1)"
case "$verdict" in
  PASS*)
    echo "OK"
    exit 0
    ;;
  FAIL*)
    echo "FLAGGED — rewrite in plain language before filing:"
    printf '%s\n' "$out" | grep -E '^[[:space:]]*(TERMS|OPTIONS):' || printf '%s\n' "$out"
    exit 1
    ;;
  *)
    echo "queue-lint: unparseable model reply:" >&2
    printf '%s\n' "$out" >&2
    exit 2
    ;;
esac
