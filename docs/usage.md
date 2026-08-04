# easel — usage

A review board is a page an agent publishes, a human annotates in the browser, and the agent reads feedback back from. The daemon runs under launchd and owns all state, so nothing is tied to the session that published it.

## Install

```
easel/install/install.sh
```

Idempotent — re-running converges to the same state. It writes `~/Library/LaunchAgents/com.sentience.easeld.plist` (derived from the clone's own location, never a hardcoded path), bootstraps the agent, puts an `easel` entry point on PATH, and waits for `/health`.

`install.sh --uninstall` boots the agent out, removes the plist, and removes the entry point.

**The installer never touches an `easel` it did not create.** The entry point it writes carries a marker naming this checkout; on install an unrecognised `easel` is a hard error telling you to remove it or pass `--bin-dir`, and on uninstall it is left alone. Nothing else on your PATH is at risk.

### Configuration

| Variable | Effect |
|---|---|
| `EASEL_PORT` | Port the daemon listens on. Defaults to 4400. The installed entry point is generated with this port baked in, so the CLI and daemon cannot drift apart — an explicit `EASEL_URL` in your own environment still wins. |
| `EASEL_DATA_DIR` | Where `easel.db` and `daemon.log` live. Defaults to `~/.easel/`. |
| `EASEL_NODE` | Interpreter the agent runs under. Set it at install time and it is written into the plist, because a launchd agent does not inherit your shell. Otherwise the launcher resolves node at every launch. |

All three are read at install time; re-run `install.sh` to change one.

### Editing easel itself — what needs a restart

**`chrome/easel.css` is live on save.** It is read from disk per request, so a style change shows up on the next page load.

**Everything else needs a restart.** `daemon/`, `templates/` and `render/` are JavaScript: the daemon holds a `templateCache` and Node caches ES modules besides, so a running daemon keeps serving the code it started with no matter what is on disk.

```
launchctl kickstart -k gui/$UID/com.sentience.easeld
```

`install.sh` does this for you, so a normal install or upgrade is fine. It only bites when editing in place.

### Upgrading the installed daemon

```
easel update
```

Pulls the installed checkout (`--ff-only`), reinstalls deps, rebuilds the excalidraw bundle, then re-runs `install.sh` — so plist/launcher/shim changes shipped by the pull actually converge — preserving the installed port, state dir, and node pin, and waits for `/health` on the installed port. It always targets the checkout the CLI shim was installed from — never your dev worktree — so the daemon's home can be a dedicated clone (e.g. `~/.easel/app`) that no development ever touches. To move the daemon's home, clone anywhere and re-run `install.sh` from the new clone; the shim and plist converge to it.

**A verification done without that restart is invalid, and it fails in a way that looks like success:** the old template renders without erroring, so the board just quietly shows the pre-change behaviour. Publishing through `--template` after a kickstart is the check that actually exercises the daemon's template path — publishing pre-rendered HTML does not, because that path never loads a template at all.

## The loop

1. `easel open --template review --data plan.json --title "..."` — publishes and returns a URL. Re-opening an existing board returns the same session.
2. The human annotates any element or text selection, and clicks widgets. Annotate mode is on when the page loads, and only its own toolbar button turns it off — Escape never does, so dismissing a panel cannot silently cost you the mode. Comments **and widget clicks** queue as drafts and are only delivered by **Send**, which appears in the topbar whenever drafts exist. Reselecting a widget option replaces the queued value — one draft per widget, never a duplicate. Each annotation gets a 2-char badge (`A1`, `A2`, …) shown both in the page gutter and on its feedback row, so the two are matchable at a glance; hovering either highlights the other, clicking a row scrolls to its element, and hovering a badge shows its comment. To drop a draft, click its badged element again, or use the panel's Remove. `f` toggles the feedback panel and `c` the conversation. Escape dismisses whatever is on top — an open annotation popover, then an open whiteboard, then an open panel — and nothing else. Diagrams open a whiteboard, which opens zoomed to fit the whole diagram rather than clipping a wide one at 100%; the **Fit to diagram** button restores that view after you pan or zoom.
3. `easel await <key>` — one foreground call that blocks until feedback actually arrives. No clock ever wakes it: it silently re-attaches across long-poll windows, dropped connections, and daemon restarts, and exits only on feedback, cancel, or board end. Safe to re-run: the cursor is server-side per agent, so a repeat call re-delivers the same unacked batch rather than losing it, and a new await from the same agent supersedes an abandoned one.
4. Apply the feedback, then `easel publish <key> --note "round 2: ..."` to close a round.

Full command reference and HTTP shapes: `easel/docs/api.md`.

## Choosing a template

| Template | Use it for | Doc |
|---|---|---|
| `review` | plans, designs, comparisons — prose sections plus decisions and votes | [templates/review.md](templates/review.md) |
| `eval` | eval runs — three modes on data shape: dossiers, blind compare, item matrix | [templates/eval.md](templates/eval.md) |
| `answer-key` | hand-authored eval goldens — teach-first, then category × person cells of positives and negatives | [templates/answer-key.md](templates/answer-key.md) |
| `page` | anything else — hand-authored HTML through the same shell | [templates/page.md](templates/page.md) |

Templates are pre-audited, so a generated board cannot hit the layout and contrast problems that hand-written HTML kept reproducing. Reach for `page` only when the shape genuinely is not a review or an eval.

## Authoring rules

These are the whole list. Everything else the old workflow required is now handled by the daemon or the design system.

- **Emit JSON, not HTML.** For `review` and `eval` you supply data; the template owns the markup.
- **Never use the `sf-` class prefix and never set `data-sid`.** Both belong to the chrome and the daemon. The `page` template rejects input that does.
- **Compose `page` HTML natively in the `sd-` vocabulary** — read [templates/page.md](templates/page.md) first and pick structure from content shape: an `sd-metrics` row for the load-bearing facts, an `sd-grid` of `sd-card`s per mechanism part, `sd-callout-success`/`-error` side by side for worked examples, badged status tables for edge cases. The classes carry the layout and contrast guarantees; content drafted as markdown and wrapped in a card arrives flat.
- **Collapses are `<details>`/`<summary>`.** A `tabindex` div is captured by the annotation layer and never opens.
- **Mermaid goes in a ` ```mermaid ` fence** (or a `<pre class="mermaid">` for `page`). It is rendered to inline SVG at publish time — write a normal `<br/>` in a node label, no entity escaping needed.
- **Widgets are declarative**: `data-widget="vote|decision|approve|rating"`, a unique `data-widget-id`, and options carrying `data-option="<value>"`. The daemon binds the behavior.

## What the daemon handles for you

Round tagging (the server diffs rounds and renders the pills), change tracking between rounds, the layout audit (advisory — it never blocks the reveal), and the design system, which ships with the daemon rather than being chosen per board. None of it needs a helper process or a snippet pasted into the page.
