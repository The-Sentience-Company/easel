# easel

A local review board. An agent publishes a page, you annotate it in the browser, and the agent reads your feedback back — without either side polling or holding a session open.

A published page is a **board**. A `easeld` daemon runs under launchd on `http://127.0.0.1:4400` and owns all state, so a board outlives the session that published it.

## Quickstart

```
easel/install/install.sh                       # idempotent; writes the plist, puts `easel` on PATH, waits for health
easel open --template page --data page.json    # → board key + URL
easel await <key> --agent <workspace>:<name>   # blocks until you send feedback
```

Open the URL, annotate, hit Send — the blocked `easel await` returns your feedback as JSON and exits. Apply it, then `easel publish <key> --note "round 2: …"` republishes to the same key with diff markers against the previous round.

`http://127.0.0.1:4400/` lists every board and marks which ones have an agent waiting on you.

## The commands

| Command | Does |
|---|---|
| `easel open <file.md>` | publish a plain document |
| `easel open --template <review\|eval\|answer-key\|page> --data <file.json>` | publish a structured board |
| `easel publish <key> --note "…"` | re-render the source as a new round |
| `easel await <key> --agent <id>` | block until feedback, cancel, or board end |
| `easel feedback <key> --since N` | read feedback without touching any cursor |
| `easel status [key]` | list boards; warns when the daemon is behind its checkout |
| `easel end <key>` | close a board — reads keep working, writes 409 |
| `easel purge [--older-than 30d]` | delete untouched boards and shrink the DB |
| `easel update` | pull, rebuild, restart, health-check the installed checkout |

## Two things that bite

**Sources need a durable home.** Every publish re-reads the source file, so a path under `/tmp` or a session scratchpad breaks republish after a reboot. Keep sources in `~/.easel/sources/`. Baked rounds survive regardless — it is only re-rendering that breaks.

**`--agent` ids are workspace-scoped.** Use `<worktree>:<callsign>`, e.g. `dev_workflows-a3-d02:a3`. A bare callsign collides with another workspace's, and the two then share a cursor and supersede each other's waits. The server keeps one cursor per id, so the same id always resumes with exactly its unacked backlog — while a brand-new id replays the board's entire history.

## Layout

| Path | Holds |
|---|---|
| `daemon/` | the server: HTTP, SSE, waiters, store |
| `cli/easel.js` | every command above |
| `chrome/` | the browser UI wrapped around a rendered round |
| `templates/` | the four publishable shapes |
| `render/` | mermaid, diff, and excalidraw pre-render |
| `install/` | installer, updater, launchd plist template |
| `docs/` | `usage.md` (flow), `api.md` (routes), `templates/page.md` (the `sd-*` vocabulary), `design-system.md` |

## Development

```
npm test                          # 520 tests, node --test
node render/build-excalidraw.mjs  # rebuild the whiteboard bundle
```

The e2e harness spawns scratch daemons on allocated ports, so the suite never touches your running daemon. Editing anything under `chrome/`, `render/`, `daemon/`, or `templates/` and skipping the bundle rebuild fails the whole suite with a stale-bundle error rather than a scatter of unrelated assertion failures.

After merging, `easel update` is what moves the resident daemon onto the new code. Until then `easel status` says the daemon is behind its checkout.
