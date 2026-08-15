---
name: easel
description: Publish review boards (docs, evals, decisions) via the local easel daemon, and collect the user's annotations/widget clicks/chat as feedback. Use whenever work needs their eyes or a decision — a plan, design doc, eval round, comparison, or report — or when about to paste anything long or visual into chat that they'd rather review as a rendered, annotatable page.
---

# easel — publish for review, listen for feedback

The daemon (`easeld`) runs under launchd on `http://127.0.0.1:4400` and owns all state; nothing is tied to the session that published. A published artifact is a **board**. If the daemon is not running, `install/install.sh` in the easel repo registers it (repo: `/Users/aleks/repos/easel`; if moved, the root is named in the comment atop `~/.local/bin/easel`).

## When to publish instead of typing

Publishing is not the last step of a long reply — it replaces it. Publish when the reply would carry **more than one table, more than ~25 lines of analysis, a before/after or N-way comparison, or more than two coupled decisions**. Eval results, root-cause writeups with open decisions, and "here are N things I need your judgment on" are never chat.

Two failure modes, both common:

- **The thread crept.** No single message crossed the bar, but the last two or three carried tables or run comparisons — the board is already overdue. Publish instead of sending a fourth.
- **A decision needed evidence.** A picker with no evidence in front of it is a board, not a question.

After publishing, the chat message is the link, one line on what changed, and where the widget is — the substance lives on the board. While a board is open it IS the status surface: a chat message restating what is already on it is the signal to publish a round. Any correction or answer that lands in chat must also land on the board before the session ends, or the artifact outlives the session still asserting what you no longer believe.

**A subagent has the Artifact tool and does not have this skill.** When you delegate work that ends in something the user reviews, say in the prompt that the deliverable is an easel board and hand over the key — otherwise it publishes an Artifact the user cannot annotate.

## Publish

```
easel open --template <review|eval|compare|gallery|rulings|page|queue> --data <file.json> --title T   # → key + URL
easel open <file.html|file.md>                                                                        # plain doc
```

**Pick the template by the shape of the work:**

| Template | The work is |
|---|---|
| `review` | a plan, design, or proposal to read, plus decisions to answer |
| `eval` | eval output — dossiers, a *blind* 2-arm compare, or an item matrix; the data shape picks the mode |
| `compare` | 2–6 *named* arms side by side — before/after, variants, shipped vs certified — one verdict per case |
| `gallery` | image candidates judged by looking — design concepts, generated imagery, UI states |
| `rulings` | labeled cases adjudicated one by one — an answer key, goldens, triage list, or model-vs-key disagreements |
| `queue` | a campaign's open decisions on one board, orchestrator-owned |
| `page` | none of the above — hand-authored HTML through the same chrome and annotation layer |

**Then Read that template's authoring doc — `references/templates/<template>.md` under this skill's base directory — before writing the data file; never write the JSON from memory of the schema.** Memory silently produces boards the template accepts but renders wrong (top-level `decisions` renders as one pile at the bottom instead of inline under each section — this shipped a real mis-authored board). Each doc carries its schema and the rules that only matter inside that flow, so this file doesn't repeat them and they can't drift.

**The template decides the shape; `references/authoring.md` decides whether the reader can act on it** — glossing internal names, shipping the diff rather than describing the edit, giving a decision the basis for answering it, sourcing claims, and the run manifest behind any model output. Read it before authoring any board, not only ones carrying decisions.

Two rules hold across every template: decision UI is the widget protocol (`data-widget` / `data-widget-id` / `data-option` on plain divs/buttons — the daemon binds it and queues clicks as drafts), never form elements; and a ```` ```mermaid ```` fence in any prose field renders to inline SVG at publish time — **before writing any fence, read `references/templates/mermaid.md`**: an unstyled diagram renders every node one uniform colour, and its authoring section carries the palette that paints node kinds apart.

A ```` ```chart ```` fence renders a small themed bar/hbar/line chart at publish time — a table is the default for numbers, so before reaching for one, read `references/templates/chart.md`.

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
- **An answer given in prose is still an answer.** When the reader states a decision plainly — in board chat, in an annotation, or in the session itself — record it and act on it. Never hold a decision open waiting for the matching widget click, and never re-ask what they already answered; the widget is one way to answer, not the only one.

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
