# easel

A local review board for work an agent wants a human to look at.

![A comment and a pin queued on a board, sent, and picked up by an agent that was blocked waiting for them](docs/demo/easel-loop.gif)

*Above: the board in a browser. Below: the agent, blocked on one command, taking the feedback and republishing — the round it publishes lands in the open tab.*

The agent publishes a page. You open it in a browser, annotate anything on it, and click Send. The agent — which has been blocked on a single command this whole time — gets your feedback back as JSON, applies it, and republishes. The second round arrives with diff markers showing exactly what changed since you last looked.

Nothing runs in the cloud. A `easeld` daemon runs under launchd on `http://127.0.0.1:4400` and owns all state, so a board outlives the session that published it, survives a daemon restart, and can be handed between agents.

**[Screenshot tour →](docs/demo.md)** — a real review, round by round: annotations, decision widgets, diffs.

## Why it exists

Agents produce work that is painful to review in a terminal: a plan, an eval run, a prompt diff, a comparison table, a design. The usual fallbacks are a wall of scrollback or a screenshot, and the feedback going back is a paragraph of prose describing which part you meant.

easel gives that exchange a page and a cursor. You point at the thing. The agent gets the annotation attached to the element you pointed at, and the next round shows you what moved.

## Quickstart

Requires macOS and Node 22+. The install pulls a Chromium through Puppeteer, which mermaid-cli uses to render diagrams to SVG at publish time — expect the first `npm install` to be slow and roughly a gigabyte on disk.

```
git clone https://github.com/The-Sentience-Company/easel.git && cd easel
npm install                                    # deps + postinstall builds the whiteboard bundle
install/install.sh                             # idempotent; writes the plist, puts `easel` on PATH, waits for health
easel open --template page --data page.json    # → board key + URL
easel await <key> --agent my-project:claude    # blocks until you send feedback
```

Open the URL, annotate, hit Send — the blocked `easel await` returns your feedback as JSON and exits. Apply it, then `easel publish <key> --note "round 2: …"` republishes to the same key with diff markers against the previous round.

`http://127.0.0.1:4400/` lists every board and marks which ones have an agent waiting on you.

Updates never install themselves. `easel update` is the manual upgrade; `easel autoupdate on` opts into a daily one — off by default because an auto-updater is standing permission to run whatever the remote ships next, and [docs/usage.md § Auto-update](docs/usage.md#auto-update) explains the shipped one and why writing your own is worth the exercise.

To back out, `install/install.sh --uninstall` removes the agent, the plist, and the `easel` entry point. It leaves `~/.easel/` — your boards and database — deliberately intact; `rm -rf ~/.easel` is the separate, deliberate step that erases them.

## The commands

| Command | Does |
|---|---|
| `easel open <file.html>` | publish a plain document |
| `easel open --template <review\|eval\|rulings\|queue\|page> --data <file.json>` | publish a structured board |
| `easel publish <key> --note "…"` | re-render the source as a new round |
| `easel await <key> --agent <id>` | block until feedback, cancel, or board end |
| `easel feedback <key> --since N` | read feedback without touching any cursor |
| `easel reply <key> <message> --agent <id>` | answer a chat message on the board |
| `easel status [key]` | list boards; warns when the daemon is behind its checkout |
| `easel end <key>` | close a board — reads keep working, writes 409 |
| `easel purge [--older-than 30d]` | delete untouched boards and shrink the DB |
| `easel update` | pull, rebuild, restart, health-check the installed checkout |
| `easel autoupdate on\|off\|status` | opt-in daily unattended update — off by default, deliberately |

## What you get on the page

- **Annotations on anything** — any element or text selection. Each one gets a two-character badge (`A1`, `A2`, …) shown both in the page gutter and on its feedback row, so you and the agent are always talking about the same anchor.
- **Rounds with diffs** — republishing to the same key keeps the history. Round pills let you page back through every version, and changed blocks are marked added / modified / moved, down to word-level marks inside a diff block.
- **Widgets** — declare a `data-widget="vote|decision|approve|rating"` with options and the daemon binds the behavior. Clicks queue as drafts alongside annotations and are delivered together on Send.
- **Diagrams you can draw on** — a ```` ```mermaid ```` fence renders to inline SVG at publish time, and opens as an editable Excalidraw whiteboard in the browser.
- **Chat** — for the feedback that has no anchor.

Nothing is delivered until you click Send, so a half-finished thought never wakes the agent.

## Templates

| Template | Use it for |
|---|---|
| `review` | plans, designs, comparisons — prose sections plus decisions and votes |
| `eval` | eval runs — dossiers, blind compare, or an item matrix, chosen on data shape |
| `compare` | 2–6 named arms side by side — before/after, variants — one verdict per case |
| `replay` | conversation exchanges replayed through 2–4 named arms — one reply per arm, one verdict per exchange |
| `gallery` | image candidates judged by looking — design concepts, generated imagery, UI states |
| `rulings` | labeled cases adjudicated one by one — answer keys, goldens, triage lists |
| `queue` | a worklist of items to triage |
| `page` | anything else — hand-authored HTML through the same shell and design system |

Templates take JSON and own their markup, so a generated board cannot reproduce the layout and contrast problems hand-written HTML kept hitting. Reach for `page` only when the shape genuinely is not one of the others; it accepts HTML composed from the shared `sd-*` class vocabulary.

## Two things that bite

**Sources need a durable home.** Every publish re-reads the source file, so a path under `/tmp` breaks republish after a reboot. Keep sources somewhere permanent — `~/.easel/sources/` is the convention. Already-published rounds survive regardless; it is only re-rendering that breaks.

**Agent ids are workspace-scoped.** Use `<workspace>:<name>`, e.g. `my-project-worktree:claude`. A bare name collides with another workspace's, and the two then share a feedback cursor and supersede each other's waits. The server keeps one cursor per id, so the same id always resumes with exactly its unacked backlog — while a brand-new id replays the board's entire history.

## Layout

| Path | Holds |
|---|---|
| `daemon/` | the server: HTTP, SSE, waiters, store |
| `cli/easel.js` | every command above |
| `chrome/` | the browser UI wrapped around a rendered round |
| `templates/` | the publishable shapes |
| `render/` | mermaid, diff, and excalidraw pre-render |
| `skills/` | [the agent-side guide](skills/easel/SKILL.md) — how an agent drives all of the above |
| `install/` | installer, updater, launchd plist template |
| `docs/` | [usage.md](docs/usage.md) (flow), [api.md](docs/api.md) (routes), [templates/page.md](docs/templates/page.md) (the `sd-*` vocabulary), [design-system.md](docs/design-system.md) |

## Development

```
npm test                          # node --test
node render/build-excalidraw.mjs  # rebuild the whiteboard bundle
```

The e2e harness spawns scratch daemons on allocated ports, so the suite never touches your running daemon. Editing anything under `chrome/`, `render/`, `daemon/`, or `templates/` and skipping the bundle rebuild fails the whole suite with a stale-bundle error rather than a scatter of unrelated assertion failures.

`chrome/easel.css` is read from disk per request, so style changes are live on save. Everything else is cached by the running daemon and needs a restart — `install/install.sh` does that for you, and after merging, `easel update` is what moves the resident daemon onto new code.

## Credits

easel was built after using [lavish-axi](https://github.com/kunchenguid/lavish-axi), which pioneered this loop — an agent writes an artifact, a local browser UI collects annotations, and a long poll carries the feedback back. easel takes the same idea toward durable multi-round boards: a persistent daemon, rounds with visual diffs between them, and per-agent feedback cursors that survive restarts. The dark theme and table treatment started from lavish's, which is MIT licensed.

## License

Copyright © 2026 The Sentience Company.

easel is fully open source — not open core — under the [Apache License 2.0](LICENSE). Run it at work, modify it, put it on every machine in the company, ship it inside something you sell. Nothing you write stays open because of us: the boards easel renders are yours, and so is anything that drives it over the HTTP API or the `easel` command. There is no separate commercial edition; this is the whole thing.

The one reservation is the name. Apache 2.0 grants no trademark rights (§6) — a fork is yours to distribute, but call it something other than easel. See [NOTICE](NOTICE).
