# queue template

One board per campaign: the single surface where decisions wait for the user. Open asks render first as cards with vote widgets, then a table of what the user has reviewed vs. what changed since, then the campaign's open PRs in merge order.

```
easel open --template queue --data queue-<campaign>.json --title "Decision queue — <campaign>"
```

The board is orchestrator-owned: one writer edits the data file and republishes; executors never touch it. Run each drafted entry through `queue-lint` (installed next to the `easel` CLI) before filing — a context-free cheap model flags shorthand the reader could not decode. `queue-lint` shells out to the `claude` CLI, so it needs Claude Code installed; without it every entry fails with `model call failed`.

## Input schema

```jsonc
{
  "campaign": "string",              // required
  "entries": [{
    "id": "string",                  // required, unique among open entries — becomes the widget id
    "pane": "string",                // required — which agent pane asked
    "kind": "decision|review|merge", // required
    "question": "string",            // required, plain English
    "options": ["string"],           // optional; default ["approve", "reject", "discuss"]
    "context_link": "string",        // optional — board/PR/doc URL
    "filed_at": "ISO-8601 string",   // required
    "status": "open|answered"        // required
  }],
  "review_stamps": [{                // optional
    "artifact": "string",
    "last_reviewed_version": "string",
    "current_version": "string"      // != last_reviewed_version renders "changed since review"
  }],
  "boards": [{                       // optional — the campaign's other active easel boards
    "title": "string",
    "url": "string",
    "note": "string"                 // optional — what the board holds
  }],
  "open_prs": [{                     // optional; array order is merge order
    "number": 123,
    "url": "string",
    "title": "string",
    "pane": "string",                // optional — the agent pane that owns the PR; renders as its own column, "—" when absent
    "blocked_by": 122                // optional — renders "waits on #122"
  }]
}
```

## Rendering rules

- Open entries render before answered ones, each an accented card with a vote widget (`data-widget-id` = entry id). Answered entries render muted, badge only, no widget, inside a collapsed `sd-collapse` details block.
- Each open entry carries `<time data-live-age datetime="...">` — the chrome recomputes "waiting 2h" from `filed_at` every 30s, so a long-open tab never shows a stale age.
- A `review_stamps` row whose versions differ gets a warning badge; matching versions get "current".
- Empty sections vanish; an empty `entries` list renders "Nothing waiting." — so a freshly seeded board (`{"campaign": "...", "entries": [], "review_stamps": [], "open_prs": []}`) publishes cleanly at wiring time.

Each open-PR row renders a **Mark merged** button (widget id `pr-<number>`, single option `merged`). A click queues it as ordinary draft feedback; the listener receives `widgetId: "pr-<number>", value: "merged"` and updates the data file (drop or restate the row) before republishing.

## Answer flow

Votes ride the standard widget protocol: a click queues a draft, Send delivers it, and `easel await <key> --agent <id>` returns it with `widgetId` = the entry id. The listener routes the answer to the pane that asked, flips the entry's `status` to `answered` in the data file, and republishes.
