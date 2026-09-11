# queue template

One board per campaign: a thin list of the decisions waiting for the user, nothing else. A card is one question, the options with what each one causes, the recommended one marked, and a link to the board that orients the reader — written by the agent that did the work, not relayed by the one filing the card. Open asks render first, then a table of what the user has reviewed vs. what changed since, then the campaign's open PRs in merge order.

**The card is not the place for the context.** When the ask comes from another agent, that agent publishes its own board (a `review` board with the design, the evidence, the diff) and the card carries it as `read_first`. A `context_link` to a ticket or a PR can ride along; it does not orient anyone. A card whose `body` runs past a few sentences is a relay that should have been a board.

```
easel open --template queue --data queue-<campaign>.json --title "Decision queue — <campaign>"
```

The board is orchestrator-owned: one writer edits the data file and republishes; executors never touch it. Run each drafted entry through `queue-lint` (installed next to the `easel` CLI) before filing — a context-free cheap model flags shorthand the reader could not decode. `queue-lint` shells out to the `claude` CLI, so it needs Claude Code installed; without it it exits 2 immediately naming what is missing, rather than failing per entry.

## Input schema

```jsonc
{
  "campaign": "string",              // required
  "entries": [{
    "id": "string",                  // required, unique among open entries — becomes the widget id
    "pane": "string",                // required — which agent pane asked
    "kind": "decision|review|merge", // required
    "question": "string",            // required, plain English — the one-line ask; the sentence the reader answers
    "title": "string",               // optional — short card title above the badges; not a second question
    "read_first": {                  // optional — the board that orients the reader, by the agent that did the work
      "url": "string", "title": "string", "by": "string"
    },
    "body": "string",                // optional, markdown — a few sentences at most; collapses past ~400 chars
    "options": [                     // optional; default ["approve", "reject", "discuss"]
      { "value": "string", "label": "string",   // label: two or three words, the words on the button
        "basis": "string",                      // one line: what picking it causes
        "recommended": true }                   // at most one
    ],
    "context_link": "string",        // optional — ticket/PR URL; rides beside read_first, never replaces it
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

**An open `decision` or `review` entry must carry a `body` or a `context_link` — rendering throws otherwise.** A vote stripped of its brief leaves the reader choosing from a single sentence and three buttons, and that has produced a rejected sign-off; `merge` entries are exempt because the PR link is the context.

## Rendering rules

- Open entries render before answered ones, each an accented card with a vote widget (`data-widget-id` = entry id). Answered entries render muted, badge only, no widget, inside a collapsed `sd-collapse` details block.
- `read_first` renders as "Read first: <title> by <agent>" above the question. `title` renders as the card title; `body` renders as markdown under the question, folding into an `sd-collapse` when longer than ~400 characters.
- Each option's `basis` renders as one bullet above the buttons, with the recommended one marked; the button shows only the `label`. **The consequence goes in `basis`, never in the label** — a label is also the value routed back to the pane, so a sentence-long label makes the recorded answer a paragraph. Options listed in the `question` or `body` as `(a) … (b) …` with the default approve/reject/discuss buttons underneath cannot be answered with a click; make them the options.
- Each open entry carries `<time data-live-age datetime="...">` — the chrome recomputes "waiting 2h" from `filed_at` every 30s, so a long-open tab never shows a stale age.
- A `review_stamps` row whose versions differ gets a warning badge; matching versions get "current".
- Empty sections vanish; an empty `entries` list renders "Nothing waiting." — so a freshly seeded board (`{"campaign": "...", "entries": [], "review_stamps": [], "open_prs": []}`) publishes cleanly at wiring time.

Each open-PR row renders a **Mark merged** button (widget id `pr-<number>`, single option `merged`). A click queues it as ordinary draft feedback; the listener receives `widgetId: "pr-<number>", value: "merged"` and updates the data file (drop or restate the row) before republishing.

## Answer flow

Votes ride the standard widget protocol: a click queues a draft, Send delivers it, and `easel await <key> --agent <id>` returns it with `widgetId` = the entry id. The listener routes the answer to the pane that asked, flips the entry's `status` to `answered` in the data file, and republishes.
