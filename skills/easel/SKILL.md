---
name: easel
description: Publish review boards (docs, evals, decisions) via the local easel daemon, and collect the user's annotations/widget clicks/chat as feedback. Use whenever work needs their eyes or a decision — a plan, design doc, eval round, comparison, or report — or when about to paste anything long or visual into chat that they'd rather review as a rendered, annotatable page.
---

# easel — publish for review, listen for feedback

The daemon (`easeld`) runs under launchd on `http://127.0.0.1:4400` and owns all state; nothing is tied to the session that published. A published artifact is a **board**. If the daemon is not running, `install/install.sh` in the easel repo registers it (repo: `/Users/aleks/repos/easel`; if moved, the root is named in the comment atop `~/.local/bin/easel`).

## Publish

```
easel open --template <review|eval|rulings|page|queue> --data <file.json> --title T   # → key + URL
easel open <file.html>                                                                # plain doc
```

**Pick the template by the shape of the work:**

| Template | The work is |
|---|---|
| `review` | a plan, design, or proposal to read, plus decisions to answer |
| `eval` | eval output — dossiers, a 2-arm blind compare, or an item matrix; the data shape picks the mode. 3+ arms or image candidates is a `page` for now |
| `rulings` | labeled cases adjudicated one by one — an answer key, goldens, triage list, or model-vs-key disagreements |
| `queue` | a campaign's open decisions on one board, orchestrator-owned |
| `page` | none of the above — hand-authored HTML through the same chrome and annotation layer |

**Then Read that template's authoring doc — `references/templates/<template>.md` under this skill's base directory — before writing the data file; never write the JSON from memory of the schema.** Memory silently produces boards the template accepts but renders wrong (top-level `decisions` renders as one pile at the bottom instead of inline under each section — this shipped a real mis-authored board). Each doc carries its schema and the rules that only matter inside that flow, so this file doesn't repeat them and they can't drift.

Two rules hold across every template: decision UI is the widget protocol (`data-widget` / `data-widget-id` / `data-option` on plain divs/buttons — the daemon binds it and queues clicks as drafts), never form elements; and a ```` ```mermaid ```` fence in any prose field renders to inline SVG at publish time — **before writing any fence, read `references/templates/mermaid.md`**: an unstyled diagram renders every node one uniform colour, and its authoring section carries the palette that paints node kinds apart.

**Always pass `--title`: 4–6 words naming the work, not the document.** It is the only handle on the dashboard, where boards outlive the session that made them. "Extractor arms — 2.5-flash vs 3.5-flash-lite", not "Eval results".

**Sources need a durable home:** the daemon re-reads the source on every publish, and `/tmp`/scratchpad paths die on reboot. Put sources in `~/.easel/sources/<key-or-name>.json`, never a session scratchpad.

**Publish reads the REGISTERED path, nothing else.** The source path is fixed at `easel open`; `easel status <key>` shows it. Before every publish, write your new content to THAT path — writing any other file makes `publish` silently re-ship the stale registered file as a new round. This shipped two stale rounds once.

## Listen — always `easel await`, never hand-rolled waiters

```
easel await <key> [--agent ID] [--ack N]
```

Blocks until real feedback, cancel, or board end — it re-attaches across long-poll timeouts and daemon restarts, so run it once and stop polling (`--timeout-s` sizes one poll window, never the overall wait). Annotations, widget clicks, and chat ride the same stream; answer chat with `easel reply <key> "msg" --agent ID`.

- **Background it as a harness-tracked command** (`run_in_background: true`) — its exit wakes you to read the batch. A shell `&`/`nohup` launch exits into a file no one reads.
- **Relaunch once after each publish** — publishing with your own agent ID drops your parked listener (`dropped: true`, exit 0, expected).
- **A killed listener is a non-event**: relaunch the identical bare await in one call and say nothing — the cursor is server-side, nothing was lost. If it's killed instantly twice running, or for why this is safe: `references/listening.md`.
- **Ack what you've handled**: relaunch with `--ack <upto>` from the batch you just applied, or the backlog re-delivers and you answer the same annotations twice.
- **`--agent` IDs are workspace-scoped and durable** — worktree basename + callsign (`my-project-a3:a3`); a bare callsign collides with other workspaces. A NEW ID replays the board's whole history. A handoff that names live boards must name the agent ID they were listened on.
- **Refer to feedback by chip ID (A1, A2 …), never internal item ids** — the chips are what the user sees. Derivation, and placing feedback via anchor `context`: `references/listening.md`.

## Iterate

Applying 3+ annotations: one script that makes every edit, each replacement asserted to match exactly once — a silent no-op and a double match are the failure modes. Then `easel publish <key> --note "round 2: ..." --agent ID` — same key, diff markers show what changed.

**Earlier rounds are never buried.** The chrome has a round picker (r1/r2 pills, Q/W); an agent reads one with `GET /api/b/<key>/state?round=N`. Point at the round ("the map is r5"), never republish old content to resurface it. For a clean visual round with no diff markers: `easel end <key>` and re-open from the same data file.

## Cleanup

`easel purge [--older-than 30d]` deletes boards untouched past the cutoff — discretionary, never auto-run. Details: `references/cleanup.md`.

## Gotchas

- Changes under `chrome/`, `render/`, `daemon/`, or `templates/` need `easel update` before the resident daemon serves them; round HTML is baked at publish, so template fixes only show on rounds published after them.
- Writes to an ended board 409; `easel end <key> --reopen` flips it back.
- Mermaid `subgraph` can't open in the whiteboard (silent fallback to plain SVG) — group via node labels.
- Auto-open on publish/wait is off by default; the toggle and the "agent waiting" badges live on the dashboard at `http://127.0.0.1:4400/`.
