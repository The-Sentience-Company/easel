---
name: easel
description: Publish review boards (docs, evals, decisions) via the local easel daemon, and collect the user's annotations/widget clicks/chat as feedback. Use whenever work needs their eyes or a decision — a plan, design doc, eval round, comparison, or report — or when about to paste anything long or visual into chat that they'd rather review as a rendered, annotatable page.
---

# easel — publish for review, listen for feedback

The daemon (`easeld`) runs under launchd on `http://127.0.0.1:4400` and owns all state; nothing is tied to the session that published. A published artifact is a **board**. Full references live in the repo: `docs/usage.md` (flow), `docs/templates/page.md` (the `sd-*` vocabulary), `docs/api.md` (routes), `docs/design-system.md`. If the daemon is not running, `install/install.sh` registers it.

## Publish

```
easel open --template <review|eval|answer-key|page|queue> --data <file.json> --title T   # → key + URL
easel open <file.html>                                                            # plain doc
```

**Every template has an authoring doc at `docs/templates/<template>.md` — read it before writing that template's data file.** They carry the data schemas and per-template workflow rules (e.g. queue entries must pass `queue-lint` before filing, which needs the `claude` CLI on PATH) that this skill doesn't repeat.

**Always pass `--title`: 4–6 words naming the work, not the document.** It is the only handle on the dashboard, where boards outlive the session that made them — write what a reader months from now needs to tell this board from its neighbours. "Extractor arms — 2.5-flash vs 3.5-flash-lite", not "Eval results" or "Analysis". Omitted, it falls back to the data's own `title`, which is the page heading and usually too long or too generic to scan.

`page` data is `{"title", "html"}`. Markup passes a sanitizer allowlist: no `input`/`form`/`select`/`textarea`/`style` — decision UI is the widget protocol (`data-widget` / `data-widget-id` / `data-option` on plain divs/buttons), which the daemon binds and queues as drafts. Diagrams: `<pre class="mermaid">` is the render hook. Style only with the shared `sd-*` classes.

**Sources need a durable home:** the daemon re-reads the source (`file`, or `template` + `data` JSON) on every publish, and `/tmp`/scratchpad paths die on reboot — baked rounds survive but republish breaks. Put sources in `~/.easel/sources/<key-or-name>.json` (`mkdir -p` it), never a session scratchpad.

**Publish reads the REGISTERED path, nothing else.** The source path is fixed at `easel open`; `easel status <key>` shows it under `file`. Before every publish, write your new content to THAT path — writing any other file (including the conventional sources dir, when the board was opened from somewhere else) makes `publish` silently re-ship the stale registered file as a new round. This shipped two stale rounds once; check `status` when in doubt.

**Compose `page` HTML natively in `sd-*`.** Pick structure from content shape: the load-bearing facts as an `sd-metrics` row first, mechanism parts as an `sd-grid` of titled `sd-card`s, worked examples both directions as `sd-callout-success` beside `sd-callout-error`, edge cases as a table with `sd-badge-success|info|warning` status per row, verbatim payloads in `sd-collapse`. Content drafted as markdown and wrapped in a card arrives as flat prose — if most body text ends up in `<p>` runs inside one card, restructure before publishing.

## Listen — always `easel await`, never hand-rolled waiters

```
easel await <key> [--agent ID] [--ack N]
```

Blocks until real feedback, cancel, or board end — it re-attaches across long-poll timeouts, dropped connections, and daemon restarts, so run it once and stop polling. `easel publish --agent ID` (the same ID as the await — the drop matches on it) drops your own parked listener on that board in-turn (`dropped: true`, exit 0 — expected, not a failure): relaunch the await once after each publish, and never pre-emptively relaunch a listener that hasn't fired — a parked listener survives rounds and delivers newer feedback fine. Annotations, widget clicks, and chat all ride the same stream. Answer chat with `easel reply <key> "msg" --agent ID` — same ID as the await, so the bubble carries your callsign. To get the turn back, background it only as a harness-tracked background command (`run_in_background: true`) — its exit is what wakes you to read the batch; a shell `&`/`nohup` launch exits into a file no one reads.

**Ack what you have already handled.** The server replays a cursor's unacked backlog, so an await relaunched after applying a round re-delivers that same round and looks like fresh feedback. Pass `--ack <upto>` (the `upto` from the batch you just handled) when relaunching, or you will answer the same annotations twice.

**Anchors carry `context`** — `{heading, card, nth, of}`, computed from the annotated round — so when the same text repeats across sections (four tables with an identical header), read `context.heading` and `nth/of` to place the feedback instead of guessing from `excerpt`.

**Refer to feedback by its chip ID, never the internal item id.** The board UI labels each annotated anchor with a two-character chip (A1, A2, … A9, B1, …) — that is what the user sees, so "your A2" is meaningful and "item 816" is not. The await/feedback JSON carries no chip field; derive it: take the round's annotation items in id order and number each anchored item's unique anchor by first appearance (first → A1, second → A2), skipping widget clicks — the anchor is `sid` alone, or `sid@x,y` for island pins (`anchor.x`/`anchor.y` present: a pinned click point inside an island; its `quote` names the clicked element, and each distinct point is its own chip). Chat carries no anchor and so no chip.

**`--agent` IDs are workspace-scoped and durable**: worktree basename + callsign, e.g. `my-project-a3-d02:a3`. A bare callsign collides with another workspace's — shared cursor, mutual await-supersede. The server keeps one cursor per ID: the same ID always resumes with exactly the unacked backlog (a re-run re-delivers it; a newer await from the same ID supersedes the old one), while a NEW ID starts at cursor 0 and replays the board's entire feedback history — ack the replay (`--ack <upto>`) if that's not wanted. `easel feedback <key> --since N` browses without touching any cursor. A handoff that names live boards must name the agent ID they were listened on.

## Iterate

Applying three or more annotations: write one script that makes every edit and run it, rather than an Edit call per change. Guard each replacement with an assertion that it matched exactly once — a silent no-op and an unintended second match are the two failure modes — and leave deliberate global renames unguarded. Keep a global rename off short blocks: replacing most of a badge or cell's text drops it under the differ's similarity floor, so the round reads as remove+add rather than modified. Chat feedback usually can't be pre-committed to string literals; edit those directly.

Apply feedback, then `easel publish <key> --note "round 2: ..." --agent ID` — same ID as your await so the daemon drops your parked listener in-turn; same key, diff markers show what changed. For a clean visual round with no diff markers, `easel end <key>` and re-open from the same data file (an ended board releases its (template, data) pair; the re-open returns a fresh round 1).

## Cleanup

`easel purge [--older-than 30d]` deletes boards untouched past the cutoff and shrinks the DB — discretionary, never auto-run. Details: [references/cleanup.md](references/cleanup.md).

## Gotchas

- A change that touches `chrome/`, `render/`, `daemon/`, or `templates/` needs `easel update` before the resident daemon serves it — one command: pulls the installed checkout, rebuilds, restarts, health-checks. The installed checkout is the one `install/install.sh` was run from, which may not be where you are editing.
- Round HTML is baked at publish — a stored round never picks up later template/CSS changes.
- Writes to an ended board 409; reads and replay keep working. `easel end <key> --reopen` flips it back to open.
- Mermaid `subgraph` is unsupported by the excalidraw converter (2026-08-02): the diagram silently falls back to plain themed mermaid and cannot open in the whiteboard. Group via node labels instead of subgraph boxes.
- Auto-open — opening a board in the browser when an agent starts waiting or a round publishes and no tab is viewing it — is **off by default**; the toggle lives on the dashboard at `http://127.0.0.1:4400/`, which also shows which boards have an agent waiting.
