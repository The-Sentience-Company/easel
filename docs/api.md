# easel daemon API (authoritative)

Authoritative API reference for the easel daemon: routes, payloads, and event shapes that `client.js`, the CLI, and templates/styles code against. If code and this doc disagree, this doc wins until the code is fixed.

Daemon listens on `http://127.0.0.1:4400` (default; override with `EASEL_PORT`). All API request/response bodies are JSON (`Content-Type: application/json`). Errors return a non-2xx status with `{"error": "<readable message>"}`.

## Identifiers and conventions

- **`key`** — board key, short hex string, server-assigned at `open`, stable for the life of the board.
- **`sid`** — stable node id, server-assigned to block-level content nodes at publish time as a `data-sid` attribute (content+path hash, carried forward through the round diff). Templates and hand-authored HTML never set `data-sid`.
- **Feedback `id`** — integer, strictly increasing per board (global autoincrement; per-board ordering is what cursor semantics rely on). Cursors and `since` are always compared as `id > N`.
- **`agent`** — agent id string for `await` cursors. CLI defaults it from `$CLAUDE_SESSION_ID`; `--agent` overrides.
- **`clientId`** — browser-side id (random, persisted in the tab's localStorage) that scopes draft feedback and chat authorship. Drafts live in SQLite keyed by it; a reloaded tab with the same clientId sees its queue intact.
- Timestamps are ISO-8601 UTC strings.

## Pages and static assets

| Route | Returns |
|---|---|
| `GET /` | HTML session index (connected tabs first, then recency; ended sessions folded). |
| `GET /b/:key` | The board page: shell HTML wrapping the current round's body. |
| `GET /assets/client.js` | Chrome runtime. |
| `GET /assets/easel.css` | Design system + chrome styles. |
| `GET /health` | `{"ok": true, "app": "easel", "version": "0.1.0", "commit", "onDisk", "stale", "branch", "dirty"}` — the build being served. `stale` is commit drift, which `easel update` fixes; `branch`/`dirty` describe the checkout as it is right now, because an uncommitted edit never moves HEAD but `chrome/` is read per request. `easel publish` and `easel await` print one stderr line when any of the three is set. Cached 15s. |
| `GET /island-frame?key&index&round` | Sandboxed document for one island (below). `round` is a seq or `wip`; 404 when that round has no such island. Readable on ended boards — it is a read. |

### Islands — per-section freeform override

An author marks a section `<div data-island>` (optional `data-island-title`, `data-island-height`). At publish, its **inner html is extracted verbatim** — before sanitization — and stored with the round; the page keeps an empty `sd-island` placeholder (one sid, annotatable as a whole, painted when empty). The chrome mounts `/island-frame` into the placeholder as `<iframe sandbox="allow-scripts">`: an opaque origin, so author CSS runs with full freedom and no reach into this origin. The frame's CSP allows inline style and `data:` assets only — no network, and the only script that runs is the daemon's nonced height reporter (`{easelIsland, index, height}` via postMessage; the chrome clamps 40–4000px). Feedback lands on the island block, not inside it. Round html bakes at publish as usual — an island belongs to its round.

`GET /b/:key` ships `#sf-content` **empty** and `client.js` paints it, so without a gate every board opens on a blank page. The shell therefore renders `body.sf-gated` plus a `.sf-gate` cover, and the reveal path is an **inline** script — a `client.js` that never loads must not be able to strand a reader behind it. Three ways out, in order of preference:

1. **client.js reveals it** after the first render actually paints. This is the normal path and shows no banner.
2. **"Show anyway"** — the reader's own escape hatch. Reveals immediately and shows `.sf-gate-banner`.
3. **The safety timeout** (4s, inline) force-reveals and shows `.sf-gate-banner`. Review is never blocked.

**The timeout reveals content, not a blank page.** If `#sf-content` is still empty at the deadline there is nothing to free, so the gate stays up and says *"This board did not load"* with a Reload button (`.sf-gate-stalled`) instead of swapping one blank page for another. Content that arrives late still reveals itself normally. `<noscript>` does the same thing for a JS-disabled reader: it keeps the gate and states that JavaScript is required, because revealing would only expose an empty `<main>`.

An **error-severity** audit finding holds the gate in a "Fixing a layout issue…" state rather than revealing a broken layout — but the safety timeout still applies to that state, so a held gate is bounded too. Warnings do not hold it; they surface in the existing `.sf-audit` indicator.

The shell page emitted by `GET /b/:key`:

```html
<!doctype html>
<html lang="en" data-theme="{light-theme-value}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{board title}</title>
  <script>/* inline, before CSS: sets data-theme on <html> from prefers-color-scheme,
     and re-syncs on change. Theme values documented at the top of easel.css. */</script>
  <link rel="stylesheet" href="/assets/easel.css">
</head>
<body class="sf-shell" data-key="{key}">
  <main id="sf-content"><!-- current round body html, data-sid annotated --></main>
  <div id="sf-chrome"></div>
  <script type="module" src="/assets/client.js"></script>
</body>
</html>
```

Template output (`render(data)`) and hand-authored `page` HTML is the inner HTML of `#sf-content` — never a full document. The chrome mounts entirely inside `#sf-chrome`.

Theming: `data-theme` is set on the `<html>` element itself and synced to `prefers-color-scheme` — never on a wrapper div (DaisyUI themes break under wrapper-div theming). The daemon emits `data-theme="light"` / `data-theme="dark"` for the default family and `<family>-light` / `<family>-dark` for a picked or ?theme=-pinned family (`lantern`, `fig`); `easel.css` documents the families and maps them onto the design system.

## State sync

### `GET /api/b/:key/state`

Full sync for a (re)connecting tab. The browser tab is a dumb view: on every SSE (re)connect and on `round`/`wip` events it re-fetches this and re-renders.

```json
{
  "board": {
    "key": "a1b2c3d4",
    "title": "JobQ decisions",
    "file": "/abs/path/or/null",
    "template": "review",
    "status": "open",
    "createdAt": "…",
    "updatedAt": "…"
  },
  "currentRound": { "seq": 2, "note": "round 2: tightened scope", "publishedAt": "…", "html": "<…data-sid'd body html…>" },
  "rounds": [ { "seq": 1, "note": null, "publishedAt": "…" }, { "seq": 2, "note": "…", "publishedAt": "…" } ],
  "wip": null,
  "diff": { "added": ["s-4f2a"], "removed": ["s-9c81"], "removedDetail": [{ "sid": "s-9c81", "excerpt": "text of the removed node…" }], "modified": ["s-77d0"], "moved": ["s-1e0b"] },
  "feedback": [ /* this clientId's drafts + all submitted items, feedback-item shape below */ ],
  "chat": [ { "id": 7, "role": "user", "agent": null, "text": "…", "at": "…" } ],
  "agentWaiting": false,
  "audit": { "findings": [], "at": "…" }
}
```

- `wip` is `null` or `{ "html": "…", "updatedAt": "…" }` — when non-null the tab renders it and shows the unpublished-changes marker (no pills, no diff for WIP).
- `diff` classifies `currentRound` against the previous round by `sid`; `null` for round 1.
- Pass `?clientId=…` so `feedback` includes that client's drafts.
- `?round=N` returns that historical round in `currentRound` (with its diff); omitted = latest.

### `GET /b/:key/events` (SSE)

Named events, each with a JSON `data` payload. Client reconnects with exponential backoff; events are triggers to re-fetch `/state`, not data carriers — payloads stay tiny.

Every event payload (and the `/state` response) carries `seq`, a per-key in-memory counter bumped on each broadcast. `hello` reports it too: a reconnecting client compares the hello `seq` against the last one it saw and re-syncs on any gap — this is what makes reconnects lossless for chat/feedback/agent state, which `round`/`wipAt` alone can't detect. Restarting the daemon resets counters, which reads as a gap and forces a sync (the safe direction).

| Event | Payload | Meaning |
|---|---|---|
| `hello` | `{"key", "round": 2, "wipAt": null\|"…", "seq": 7, "agentWaiting": false}` | Sent on connect. Client re-syncs on round/wip/seq drift and applies `agentWaiting` unconditionally (both true and false). |
| `round` | `{"seq": 3}` | New round published. Re-fetch state, re-render, rebuild pills. |
| `wip` | `{"updatedAt": "…"}` | Source file changed without publish. Re-fetch state, render WIP + marker. |
| `chat` | `{"id": 8}` | New chat message (either role). Re-fetch state or append. |
| `agent` | `{"waiting": true}` | An `await` is currently blocked on this board (shows presence; enables cancel). |
| `feedback` | `{"id": 12}` | Feedback item changed server-side (e.g. acked). |
| `end` | `{}` | Board ended. |
| `ping` | `{}` | Keepalive, every 25s. |

### `GET /events?keys=k1,k1,k2` (SSE, origin-wide)

One stream for the whole origin. Browsers cap HTTP/1.1 at 6 connections per origin, and all boards share one origin — so per-tab streams starve the 7th concurrent tab's own navigation (it renders blank). The chrome therefore holds a single stream in a `SharedWorker` (`/assets/events-worker.js`) and fans events out to tabs over `MessagePort`; browsers without `SharedWorker` fall back to the per-key stream above, released while the tab is hidden.

- `keys` is a comma list of subscribed board keys; **repeats mean tab counts** (`k1,k1` = two tabs on `k1`), which is how `connectedTabs` stays accurate — counts die with the connection, so they self-heal. Unknown keys are ignored; counts cap at 32 per key and 512 entries total so a hostile param can't inflate `connectedTabs`.
- Events are the per-key events above with `key` added to the payload, filtered to subscribed keys.
- `hello` differs: `{"boards": {"k1": {"round": 2, "wipAt": null, "seq": 7, "agentWaiting": false}, …}}` — one entry per subscribed live board. The worker re-subscribes (reopening the stream) whenever its tab set changes; events broadcast during that reopen window are recovered by the fresh hello's `seq` comparison.

## Feedback

### Feedback item shape

Payload discipline: **stable node id + short excerpt only. No DOM snapshots. No selector chains.** `excerpt` is the anchored node's text clipped to 200 chars; `quote` is the exact user selection (absent for element-level annotations). `context` (computed at submit from the annotated round, absent when it adds nothing) disambiguates anchors whose text repeats: nearest preceding heading, enclosing `sd-card-title`, and `nth`/`of` among same-tag nodes with identical text.

Island pins: a click inside an island frame anchors to the island's sid plus `anchor.x`/`anchor.y` — the click point as fractions (0–1, 4 dp) of the island document's width/height. `quote` then carries the clicked element's nearest text (the frame's shim derives it), and each distinct point is its own marker on the page. Map a pin back to a design element by locating (x, y) in the island's source html.

```json
{
  "id": 42,
  "key": "a1b2c3d4",
  "round": 2,
  "kind": "annotation",
  "state": "submitted",
  "anchor": { "sid": "s-4f2a", "quote": "the selected text", "prefix": "…20 chars…", "suffix": "…20 chars…" },
  "excerpt": "short text of the anchored node…",
  "context": { "heading": "user A — weekly entries", "card": "Fix 1", "nth": 1, "of": 4 },
  "comment": "user's comment text",
  "createdAt": "…",
  "submittedAt": "…"
}
```

**Agent-facing reads (`/await`, `/feedback`) drop `key`, `state`, `createdAt` and `submittedAt`** — the agent named the board in the request, everything it collects is submitted, and it reads no timestamps. `id` (its cursor) and `round` (which change a comment predates) stay. The browser's `/state` keeps the full shape, since the queue panel draws drafts from `state`. The saving is per item, so it scales with the batch, not with the board.

Widget items: `"kind": "widget"`, plus `"widgetId": "verdict-case-3"`, `"value": "approve"`, `anchor.sid` of the widget node, no `comment`/`quote`. Widget clicks are born `draft` and ride the same queue as annotations (by design: everything waits for Send). At most one live draft exists per (widget, client) — a reclick replaces its value in place; only Send freezes it.

### Browser-facing routes

Once a board is no longer open, `POST /feedback`, `POST /send` and `POST /widget` (and `POST /chat`, and the agent-facing `POST /await`) are refused with **409 `{"error": "board ended"}`** — an accepted write would be stored where nothing can collect it. `DELETE /feedback/:id` stays open deliberately, so a client can still clear its own drafts, and it can add nothing. Reads are unaffected: `/state`, `/s/:key` and feedback replay keep working, and `end --reopen` restores every refused path.

| Route | Body | Response |
|---|---|---|
| `POST /api/b/:key/feedback` | `{"clientId", "round", "anchor": {"sid", "quote?", "prefix?", "suffix?", "x?", "y?"}, "comment"}` | The created item, `state: "draft"`. Called when a comment is **queued** (not per keystroke). `x`/`y` (island pins) are clamped to 0–1 and rounded to 4 dp; one without the other is dropped. |
| `DELETE /api/b/:key/feedback/:id` | — | `{"deleted": true}`. Removes a draft from the queue. Drafts only; submitted items are immutable. |
| `POST /api/b/:key/send` | `{"clientId"}` | `{"submitted": [42, 43]}`. Flips that client's drafts to `submitted`, stamps `submittedAt`, wakes `await`. |
| `POST /api/b/:key/widget` | `{"clientId" (required), "round", "widgetId", "value", "sid"}` | The live draft for (widget, client) — created on first click, value-replaced in place on a reclick (same `id`). `state: "draft"`; `await` receives nothing until `/send` submits it. Removing it is the ordinary draft `DELETE` above. |

### Agent-facing routes (back the CLI)

| Route | Body / params | Response |
|---|---|---|
| `POST /api/b/:key/await` | `{"agent", "ack?": M, "timeoutS?": 60, "resumed?": false}` | `resumed: true` says this attach continues a wait that had already reached a daemon — the CLI sets it on every attach after one that landed, and auto-open skips it. Without it a daemon restart, which makes every live agent re-attach at once, opens a tab for each. Blocks until items with `id > cursor(agent)` exist (or timeout / cancel / supersede / publish-drop). `{"items": […], "upto": 43, "cursor": 40, "timedOut": false, "cancelled": false, "superseded": false, "dropped": false}`. `dropped: true` means this agent published the board mid-wait; relaunch after the round. The CLI exits 0 on supersede and drop — both are lifecycle events, not failures. If `ack` is given, cursor advances to `M` **first**, then the wait runs. Never advances the cursor by delivering — re-running `await` without ack re-delivers the same batch verbatim. At most one waiter per (board, agent): a new attach from the same agent resolves the old waiter with `superseded: true`, so an abandoned session can never block a fresh await. Attaching to a non-open board is a `409` — a waiter can never park on an ended board. |
| `POST /api/b/:key/ack` | `{"agent", "upto": 43}` | `{"cursor": 43}` |
| `GET /api/b/:key/feedback?since=N` | — | `{"items": […]}`. Non-blocking replay of submitted items with `id > N`, re-fetchable forever. `since` omitted = all. |
| `POST /api/b/:key/reply` | `{"text", "agent?"}` | `{"id": 9}`. Posts to the conversation panel as the agent. `agent` is an optional **caller-supplied alias**, not authenticated identity — the whole API is unauthenticated on the loopback origin, so it labels which agent *claims* to have written a message and must not be relied on as provenance. Rendered on the bubble so several agents sharing one chat stay tellable apart. Non-string values are rejected with 400; omitted or null renders no callsign, as does every user message. The CLI fills it from `--agent`, else `$CLAUDE_SESSION_ID`, else omits it. |
| `POST /api/b/:key/cancel-waiting` | — (browser cancel button also hits this) | `{"cancelled": n}` — resolves blocked `await` calls with `cancelled: true`, delivering nothing and advancing nothing. |

### Chat

| Route | Body | Response |
|---|---|---|
| `POST /api/b/:key/chat` | `{"clientId", "text", "withDrafts?": false}` | `{"id": 8, "submitted": […]}` — user-side message; wakes `await`? **No** — chat messages ride the `await` stream as items of `"kind": "chat"` (`{"id", "kind": "chat", "text"}` on the agent side) so one blocking read covers annotations, widgets, and chat. With `withDrafts: true`, the caller's queued drafts submit in the same wake — one batch, drafts first, chat last — and `submitted` lists their ids (empty when nothing was queued or `clientId` is absent). |

## Lifecycle routes (back the CLI)

| Route | Body | Response |
|---|---|---|
| `POST /api/open` | `{"file?": "/abs.html", "template?": "review\|eval\|answer-key\|page", "data?": "/abs.json", "title?": "…"}` | `{"key", "url", "created": true}`. **Idempotent**: an already-open board for the same `file` (or same `template`+`data` path) returns the existing session with `created: false`. Opening auto-publishes round 1 from current content. The daemon watches the source file(s); changes become WIP. `file` must be `.html`/`.htm` and `data` must be `.json` — anything else is 400 (other formats would store un-diffable, un-annotatable rounds). Without `title` a template board takes the `title` from its data, so the index names it something rather than its key; `publish` fills a still-blank one the same way, and never renames a board that already has one. |
| `POST /api/b/:key/publish` | `{"note?": "round 2: …", "agent?": "id"}` | `{"round": 2, "listenerDropped": false, "diff": {"added": [], "removed": [], "modified": [], "moved": []}, "audit": {"findings": […]}}`. Re-reads the source, renders, assigns `sid`s, diffs vs previous round, runs the advisory audit (never blocks), broadcasts `round`. With `agent` (the CLI sends the same id `await` uses), the publisher's own parked waiter resolves `{dropped: true}` synchronously — the exit lands inside the publish turn, never as a wake after the agent stops; other agents' waiters are untouched. |
| `GET /api/status` | `?limit=&offset=` | `{"boards": [{"key", "title", "file", "dataFile", "template", "status", "rounds", "unacked": {"<agent>": 3}, "updatedAt", "agentWaiting", "connectedTabs"}], "total", "waiting", "offset", "limit"}` — the index page renders from this on a 2s poll, 100 to a page. Boards come ranked (agent waiting → listener lost → live tab → open → ended, then newest first), so a page is a window on one list; `total`/`waiting` always count every board. Without `limit` (the CLI's `easel status`) the whole list comes back. |
| `GET /api/config` | — | `{"autoOpen": true}` — daemon-wide settings, stored in `<data-dir>/config.json`, read fresh per use (no restart). |
| `POST /api/config` | `{"autoOpen": bool}` | The merged config. `autoOpen` (default **off**, toggle lives on the index page) opens `/b/:key` in the browser when an agent starts waiting or a round publishes and no tab is viewing that board, at most once per 15s per board. `EASEL_OPEN_CMD` overrides the `open` binary (tests use a stub). |
| `GET /api/b/:key/status` | — | One element of the above, plus `"connectedTabs": 1` (per-key streams + shared-stream subscriptions for this key). |
| `POST /api/b/:key/end` | `{"reopen?": false}` | `{"status": "ended"}` (or `"open"` with `reopen: true`). Ended boards stay readable and feedback replay keeps working, but every write path (`feedback`, `send`, `widget`, `chat`, `await`) 409s until a `reopen`. A tab open at the moment of the end disables its own controls on the `end` event; a tab that arrives later reads `board.status` from `/state`. |
| `POST /api/gc` | `{"olderThanDays": 7}` | `{"archived": n}`. Archives ended/stale sessions (status flip only — reclaims no space); never deletes source files. |
| `POST /api/purge` | `{"olderThanDays": 30}` | `{"purged": n, "keys": […]}`. **Deletes** every board (any status) untouched past the cutoff — rounds, feedback, chat, cursors, whiteboard scenes (DB rows and on-disk files) — then VACUUMs so the DB actually shrinks. Never deletes source files. Discretionary; nothing runs it automatically. |

## Audit

Publish-time advisory layout audit. Findings shape:

```json
{ "findings": [ { "severity": "warn", "type": "clipped-text", "sid": "s-4f2a", "detail": "…", "width": 800 } ], "at": "…" }
```

Reported in the `publish` response and in `/state`. Never blocks the reveal, never re-fires on repeat identical results (server-side dedupe), renders in the chrome as a small dismissible indicator only.

## CLI mapping

```
easel open <file> [--title]                → POST /api/open {file}
easel open --template T --data D [--title] → POST /api/open {template, data}
easel publish <key> [--note]               → POST /api/b/:key/publish
easel await <key> [--agent] [--cursor N] [--ack M] [--timeout-s T]
                                           → POST /api/b/:key/await, re-attached until resolved
easel feedback <key> --since N             → GET  /api/b/:key/feedback?since=N
easel reply <key> "msg" [--agent ID]       → POST /api/b/:key/reply
easel status [<key>]                       → GET  /api/status | /api/b/:key/status
easel end <key> [--reopen]                 → POST /api/b/:key/end
easel gc [--older-than 7d]                 → POST /api/gc
easel purge [--older-than 30d]             → POST /api/purge
```

Every subcommand: exit 0 on success (period), `--json` for machine output, no resident agent-side processes. `easel await` is **unbounded**: one foreground process that silently re-attaches across server long-poll windows (`--timeout-s` sizes the window, default 600s — it never bounds the total wait) and across dropped connections and daemon restarts (bounded backoff). It exits only on real feedback (exit 0), explicit cancel (exit 0, `cancelled: true`), supersession by a newer await from the same agent (exit 1), or board end. Board end has two faces: ending the board while the wait is attached resolves it as `cancelled: true` (exit 0 — to the agent it means the same thing: stop waiting, nothing is coming), and any attach or re-attach on an already-ended board is a 409 (exit 1). It stays a foreground child — it dies with the session that spawned it. Safe to kill and re-run: the cursor is server-side.

## Threat model

Round html renders on the daemon's own origin (`127.0.0.1:4400`), where the whole unauthenticated API is reachable. The daemon therefore sanitizes every round/WIP at annotate time by **allowlist**, not denylist — a ban list reopens the moment a new active-content vector appears (`<iframe srcdoc>`, `<object>`, `<math>`, …), so only a known-safe set survives storage:

- **Elements**: ordinary document markup (headings, lists, tables, `figure`, `details`, inline formatting, `a`, `img`, the widget `button`) plus the SVG set mermaid emits. Everything else is unwrapped — the element and its attributes are dropped, its text-bearing children kept — so a hand-authored `page` board never silently loses a section. `<script>`, `<template>`, and any HTML-context `<style>` are dropped whole. `iframe`/`object`/`embed`/`base`/`meta`/`form`/`math` are simply not on the list.
- **Attributes**: on HTML elements, an allowlist (`class`, `id`, `href`/`src`, table/`details` structural attrs, `data-*`, `aria-*`, …). Inside the machine-generated SVG island, the element set stays allowlisted but presentation attributes pass by a closed denylist (`on*` and unsafe-URL only), because SVG attributes are open-ended and diagram-specific. `on*` is stripped everywhere; an inbound `data-sid` is always stripped (the daemon owns sid assignment). `href`/`src`/`xlink:href` keep only `#`-fragment, relative, `http(s):`, and `mailto:` values — `javascript:`, `data:`, and protocol-relative `//host` are dropped. HTML-context inline `style` is dropped, with one exception: inside an SVG subtree it is kept and scrubbed like any SVG css, because a mermaid label is HTML in a `<foreignObject>` and mmdc sized the node box around the metrics that `style` carries — dropping it let the page's line-height reflow the label taller than the box, and the SVG clipped it. CSS that does reach the browser — the in-SVG `<style>` element and **every** SVG attribute, since `fill`, `stroke`, `filter`, `clip-path` and `mask` all take a funciri — is parsed rather than pattern-matched, and only two url shapes are permitted through: a same-document `#`-fragment, and the `data:font/woff2;base64` face the sketch diagrams embed. `@import` is dropped, and any other function carrying a string (`image-set()`, `cross-fade()`, …) becomes `none`, so a fetch-capable construct does not need to be known by name to be neutralised. A value that does not parse is dropped rather than passed through — the earlier regex did the opposite, passing an unmatched `url()` through verbatim, so the more hostile the value the likelier it escaped.

Residual risk, stated plainly: Boards are assumed to show locally-authored or agent-authored documents, not hostile ones. The allowlist closes script execution on the privileged origin (including the `iframe srcdoc` bypass), the CSS fetch vectors (`url()`, `@import`, and string-bearing functions such as `image-set()`), and protocol-relative URLs, but is not a substitute for origin isolation. Two known limits: mermaid's in-SVG `<style>` is permitted and is **not** scoped to the diagram in browsers, so its (fetch-scrubbed) CSS still applies document-wide; and mutation-XSS via parser-context confusion is not specifically defended. Rendering content in a sandboxed iframe on an opaque origin (with token-authenticated API calls) is the documented extension point if untrusted documents ever become an input.

## Chrome DOM vocabulary

Everything the chrome creates uses the `sf-` prefix; templates never use `sf-` classes. All chrome lives inside `#sf-chrome` except content-layer marker classes, which client.js applies to nodes inside `#sf-content`.

### Structure

```
body.sf-shell
├── div#sf-chrome                        precedes content so the sticky topbar tops the page
│   ├── .sf-topbar
│   │   ├── a.sf-brand                   links to "/"
│   │   ├── .sf-theme-pick               family picker: button.sf-theme-pick-btn per family (data-family="" | "lantern" | "fig", .sf-on on the active one; choice in localStorage sf-theme-family) + button.sf-tuner-toggle (⚙, opens the tuner popup)
│   │   ├── .sf-title
│   │   ├── .sf-wip-marker               visible only with unpublished changes ("unpublished changes")
│   │   ├── .sf-agent                    agent presence; has .sf-agent-waiting while an await blocks
│   │   │   └── button.sf-cancel-wait    visible only while waiting
│   │   ├── .sf-status                   SSE connection state
│   │   │   └── .sf-status-dot           .sf-connected | .sf-reconnecting
│   │   ├── button.sf-theme-toggle       cycles auto → light → dark ("[T]heme: {mode}"); override in localStorage sf-theme; hotkey "t"
│   │   ├── button.sf-annotate-toggle    .sf-on when annotate mode active (on at load); hotkey "a"
│   │   ├── button.sf-send-now           "Send N" — visible only while drafts exist
│   │   ├── button.sf-queue-toggle       opens/closes the queue panel (.sf-on while open); contains .sf-queue-count; hotkey "f"
│   │   └── button.sf-chat-toggle        opens/closes the chat panel (.sf-on while open)
│   ├── .sf-rounds                       hidden when only 1 round
│   │   ├── button.sf-round-pill         one per round; data-round="N";
│   │   │                                .sf-round-current (latest), .sf-round-active (being viewed)
│   │   ├── .sf-diff-legend
│   │   │   └── .sf-legend-added / .sf-legend-removed / .sf-legend-modified / .sf-legend-moved
│   │           / .sf-legend-annotated   shows a live .sf-item-marker badge, not a swatch
│   │                                    (legend renders whenever there are ≥2 rounds OR any annotation;
│   │                                     the four diff entries only with pills)
│   │   └── button.sf-removed-toggle     "Show [R]emoved (N)" — reveals in-place removal ghosts; .sf-on while
│   │                                    active; only with pills and a non-empty removedDetail; hotkey "r"
│   ├── aside.sf-queue                   feedback queue panel; .sf-open when expanded
│   │   ├── .sf-queue-header             includes .sf-queue-count (draft count badge)
│   │   ├── .sf-queue-list
│   │   │   └── .sf-queue-item           .sf-item-draft | .sf-item-submitted, plus .sf-item-widget on widgets;
│   │   │       │                        carries data-sid + data-marker-hue when anchored
│   │   │       ├── .sf-item-marker      2-char id badge, same id and hue as the page marker
│   │   │       ├── .sf-item-excerpt
│   │   │       ├── .sf-item-comment
│   │   │       ├── .sf-item-round       "r2"
│   │   │       └── button.sf-item-remove   drafts only
│   │   └── button.sf-queue-send         "Send N" — flips drafts to submitted
│   ├── aside.sf-chat                    conversation panel; .sf-open when expanded
│   │   ├── .sf-chat-header              "Conversation"; click also toggles .sf-open
│   │   ├── .sf-chat-log
│   │   │   └── .sf-chat-msg             .sf-msg-user | .sf-msg-agent
│   │   │       ├── .sf-msg-agent-id     callsign chip, only on agent messages that carry one
│   │   │       └── .sf-msg-text
│   │   ├── .sf-chat-working             spinner row, visible while agent waiting after a send
│   │   │   └── button.sf-chat-cancel
│   │   └── form.sf-chat-form
│   │       ├── textarea.sf-chat-input
│   │       └── button.sf-chat-submit
│   ├── .sf-popover                      annotation card, position:fixed at the click point
│   │   ├── .sf-popover-excerpt          what's being annotated (quote or node excerpt)
│   │   ├── textarea.sf-popover-text
│   │   ├── .sf-draft-row                manager variant: one per existing draft on the node
│   │   │   └── button.sf-draft-remove
│   │   └── .sf-popover-actions
│   │       ├── button.sf-popover-queue  primary: queue the comment
│   │       └── button.sf-popover-cancel
│   ├── .sf-audit                        advisory audit indicator; hidden when clean/dismissed
│   │   ├── button.sf-audit-badge        count chip; click toggles .sf-open
│   │   └── .sf-audit-list
│   │       └── .sf-audit-finding        .sf-sev-warn | .sf-sev-error
│   ├── .sf-ended-banner                 visible only on an ended board; reports it, never covers content
│   ├── .sf-gate-banner                  visible only after a FORCED reveal (timeout or "Show anyway")
│   └── .sf-toasts
│       └── .sf-toast                    transient notices (queued, sent, reconnected…)
└── main#sf-content                      rendered round body (template output / page html)
```

### Content-layer classes (applied inside `#sf-content`)

| Class | On | When |
|---|---|---|
| `sf-annotating` | `body` | Annotate mode active (hover/click targeting live). On at load; Escape exits. |
| `sf-hover` | any node | Current annotation hover target. |
| `sf-annotated` | node with `data-sid` | Has at least one queued/submitted annotation. Hosts a `button.sf-marker` — a gutter badge carrying a 2-char id (`A1`, `A2`, …) and a cycling hue from `data-marker-hue`, matching its feedback row. Deliberately not a left bar: that shape belongs to the diff marks. Scroll containers (`pre`, `.sd-diagram`, `.sd-tablewrap`) clip a gutter badge, so they tuck it inside and add a dashed outline; table rows host it in their first cell, since a button is not valid content for a `<tr>`. |
| `sf-linked` | anchored node or `.sf-queue-item` | Hover on either side of an annotation↔row pair highlights the other. |
| `sf-flash` | node with `data-sid` | Transient, ~1.2s: a feedback row was clicked and scrolled its anchor into view. |
| `sf-diff-added` / `sf-diff-modified` / `sf-diff-moved` | node with `data-sid` | Viewing a round with the diff view on. |
| `sf-ghost-item` | `aside` inserted into `#sf-content` | Removed nodes exist only in the previous round; the client inserts each excerpt (with `data-sid`) at the spot it was removed from — after `removedDetail.afterSid`, or first inside `withinSid`. Hidden until `#sf-content.sf-show-removed`, toggled by `button.sf-removed-toggle` ("Removed (N)") in the rounds row. |
| `sf-recorded` | `[data-widget]` node | Widget holds a queued (or sent) value; the queue panel's Remove drops a queued one. |
| `sf-diagram-look` | `button` appended to `.sd-diagram-dual` | Dual-baked diagrams only: flips every diagram between the plain mermaid look (default) and the sketch look by toggling `data-diagram-look="sketch"` on `<html>`; preference persists in localStorage `sf-diagram-look`. Older rounds baked with one look carry no button. |
| `sf-wrappable` / `sf-wrap-toggle` | `pre` measured wider than its box, and the `button` appended to it | The button wraps long lines in every `<pre>` (except `.sd-diff`, which already wraps) by toggling `data-wrap-code="on"` on `<html>`; preference persists in localStorage `sf-wrap-code`. The class reserves the corner the button sits in. Only overflowing blocks get either, so short snippets stay clean. While wrap is on, a `span.sf-wrap-mark` (`↵`) is parked in the right padding beside every line box that continues below — a soft wrap breaks no element, so the client measures each logical line's rects and re-measures on resize. |
| `sf-wip` | `#sf-content` | Rendering unpublished WIP content. |
| `sf-gated` | `body` | The layout gate is up: `#sf-content` and `#sf-chrome` are `visibility: hidden` and `.sf-gate` covers the page. Set by the server in the shell, removed on reveal. |
| `sf-ended` | `body` | Board is no longer open. Annotate, Send, chat and every `[data-option]` are `disabled`; the server refuses those writes too, so a stale tab cannot bypass it. |

### Widget protocol

Template emits `data-widget="vote|decision|approve|rating"`, unique `data-widget-id`, options as descendants with `data-option="<value>"`. client.js binds click on `[data-option]` → `POST /api/b/:key/widget` (queues a draft, reclick replaces it) → adds `sf-recorded` to the widget node. Everything not inside a `[data-widget]` is annotatable by the generic layer.
