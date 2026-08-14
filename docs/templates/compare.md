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

**`rows` — aligned comparison.** One table, one row per topic, one column per arm. Tokens that are not present in every sibling cell render `<strong>`, so identical prose recedes and the divergence pops. This is the mode for "make the entries that are the same side by side so I can easily see the diffs" — the reader's eye should land on what differs without reading both cells.

**`columns` — whole documents.** One `sd-card` per arm in a grid, arm name as the card title, markdown inside. Use when the arms are long enough that a table cell would be unreadable and the reader wants to read each one through.

## One verdict per case

Each case renders exactly one vote widget, after the comparison. Options default to the arms plus `tie` and `all-bad`.

**There is no per-row widget and adding one is not an oversight.** A reader asked to rule on every line stops reading and rules on none; the recorded ask is "which arm wins this case", and per-row detail belongs in annotations, which anchor to the row anyway. When the reader only wants to look and not vote — a variance or before/after board published for information — set `"verdict": false` on the case.

## Errors

Fewer than 2 or more than 6 arms, duplicate arm names, duplicate case ids, a case with both `columns` and `rows` or neither, mixed modes across cases, an empty `rows`, and a cell object missing an arm all throw a `TemplateError` naming the path.
