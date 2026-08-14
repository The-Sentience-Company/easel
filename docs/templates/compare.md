# compare template

Two to six named arms side by side, one verdict per case. Use it when the reader's job is "which of these wins", and the arms are known to them — a prompt before and after, three extractor variants, shipped vs certified.

```
easel open --template compare --data arms.json --title "Extractor arms — flat vs split vs certified"
```

**Not this template:** a *blind* two-candidate compare is `eval`'s compare mode, which hides which arm is which behind a blind key. `compare` renders the arm names as column headers, so use it when knowing the arm is part of the judgment. Adjudicating labeled cases one at a time is `rulings`. Image candidates are `gallery`.

## Input schema

```jsonc
{
  "title": "string",                 // required
  "summary": "string",               // optional, markdown lede
  "run": {                           // optional — renders as ONE prose line, muted keys / strong values
    "dataset": "frozen-2026-08-11",  // put the manifest here: what ran, over what, when
    "judge": "claude-opus-5"
  },
  "arms": ["flat", "split"],         // required, 2–6, unique — column headers AND the default vote options
  "rowColumn": "string",             // optional, rows mode only — first column header, default "what"

  "cases": [{
    "id": "string",                  // required, unique across the board
    "name": "string",                // optional heading, defaults to id
    "context": "string",             // optional markdown above the comparison
    "badges": ["label", { "label": "string", "tone": "success|warning|error|info" }],

    // exactly one of columns / rows, and every case on a board uses the same one:
    "columns": { "flat": "markdown", "split": "markdown" },     // whole documents side by side
    "rows": [{                                                   // aligned, topic by topic
      "label": "string",             // required — what this row compares
      "note": "string",              // optional, muted under the label
      "cells": { "flat": "text", "split": "text" }   // required — every arm needs a cell
    }],

    "ask": "string",                 // optional widget prompt, default "Which arm wins this case?"
    "askHelp": "string",             // optional one-line help
    "verdict": ["a","b"] | false     // optional — options override, or false for a read-only case
  }]
}
```

Every cell object must carry a key for **every** arm — a missing arm throws rather than rendering a ragged row, because a blank cell reads as "this arm produced nothing" when it usually means the author forgot.

## The two modes

**`rows` — aligned comparison.** One table, one row per topic, one column per arm. A token most cells share is the baseline and renders plain; only the deviation renders `<strong>`, so the eye lands on what differs without reading both cells. A row that shares nothing emphasizes nothing — there is no baseline to diverge from, and marking all of it says the same as marking none.

**`columns` — whole documents.** One `sd-card` per arm in a grid, arm name as the card title, markdown inside. Use when a table cell would be too small to read the arm through.

## One verdict per case

Each case renders exactly one vote widget, after the comparison. Options default to the arms plus `tie` and `all-bad`.

**There is no per-row widget and adding one is not an oversight.** A reader asked to rule on every line rules on none; per-row detail belongs in annotations, which anchor to the row anyway. For a board published to be looked at rather than voted on, set `"verdict": false` on the case.

## Errors

Fewer than 2 or more than 6 arms, duplicate arm names, duplicate case ids, a case with both `columns` and `rows` or neither, mixed modes across cases, an empty `rows`, and a cell object missing an arm all throw a `TemplateError` naming the path.
