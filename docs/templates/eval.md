# eval template

One template, three modes, switched on the case shape: `notes` renders dossiers, `candidates` renders a blind two-column compare, `items` renders an N-way item matrix. The comparison types serve different jobs, so the data decides — there is no mode flag.

Know the edges before committing to this template: blind compare takes exactly two candidates, and no mode renders images. **A compare with 3+ arms, or named arms the reader is meant to see, is `compare`; conversation exchanges replayed through named arms — same message, one reply per arm — are `replay`; image candidates are `gallery`**; adjudicating labeled cases one by one belongs on `rulings`.

```
easel open --template eval --data results.json --title "Preference extraction run 41"
```

## Shared schema

```jsonc
{
  "title": "string",                 // required
  "summary": "string",               // optional, markdown, rendered as the lede
  "run": {                           // optional; renders as ONE prose line — muted keys, strong values
    "dataset": "frozen-2026-07-28",
    "model": "claude-opus-5"
  },
  "metrics": [                       // optional
    { "label": "string", "value": "string|number", "note": "string" }
  ],
  "cases": [ /* required, non-empty; every case carries the SAME one of notes / candidates / items */ ]
}
```

Two top-level flags turn the per-item asks off when the board is published to be read rather than ruled on: **`"verdicts": false`** drops the per-case verdict widget in dossier mode, **`"picks": false`** drops the per-row `best?` widget in matrix mode (the per-case overall vote stays). Reach for them when the reader has said they only want to look — a widget on every row asks for a ruling per line and gets none.

Every case requires a unique `id`; `name`, `status` (`pass|fail|error|skip|partial`), and `score` are optional. A heading name that starts with the id shows the id once. The Cases summary table renders only when at least one case has a status or score.

## Dossier mode — `cases[].notes`

```jsonc
{ "id": "ahmet", "name": "ahmet — 2 entries", "notes": "markdown document",
  "verdictOptions": ["pass", "needs-work"] }   // optional, this is the default
```

Each case is a section: id heading, notes as markdown in a card, a verdict widget after. When the board has more than 15 cases, cases with `status: "pass"` fold into a native `<details>` collapse; everything else stays open.

## Blind compare mode — `cases[].candidates`

```jsonc
{ "blindKey": { "ahmet": 0, "ben": 1 },        // required at top level: which candidate is output 1
  "cases": [{ "id": "ahmet", "candidates": ["markdown A", "markdown B"],
              "context": "what framed this case",   // optional, markdown
              "group": "ahmet" }] }                 // optional — table grouping
```

Exactly two candidates per case. The blind key decides the order per case and is never rendered — the harness that published the board holds it and unblinds after votes land. One output-1 / output-2 / tie widget per case.

**The candidates' length picks the layout.** When every candidate on the board is a single line of ≤160 characters, cases render as dense table rows — `case | context? | output 1 | output 2 | pick`, compact vote buttons in the row, consecutive cases sharing a `group` under one heading — so a 42-head-to-head board reads on a couple of screens. Any longer candidate anywhere switches the whole board to the two-column section layout, where `context` renders above the pair (collapsed past 400 chars). The context column only appears when at least one case in the group carries one.

## Matrix mode — `cases[].items`

```jsonc
{ "itemColumn": "preference",                  // optional first-column header, default "item"
  "cases": [{ "id": "ahmet", "items": [
    { "id": "ahmet-job",                       // optional widget id, defaults to best-<case>-<index>
      "label": "Job + emails", "note": "B drops the title",
      "candidates": { "B": "text", "C": "text", "D": "text" } }
  ] }] }
```

One table per case: `item | B | C | D`, one row per item, then a plain `best?` row carrying a widget with each candidate, `tie`, and `all-bad`. Every item in a case must carry the same candidate keys. A per-case overall widget follows the table.

Divergence highlighting is the matrix's core value: tokens not present in every sibling candidate render `<strong>`, so identical prose recedes and the differences pop. Matching strips edge punctuation but keeps interior `.`/`@`, so emails compare whole.

**Candidate keys are reviewer-facing.** They render verbatim as column headers and vote buttons (`<key> best`), so name them `1`/`2`/`3` (or `A`/`B`/`C`) — never raw run ids or hashes. Record which arm each number maps to in `footer`; the harness that published the board keeps the mapping for unblinding.

## Errors

Empty `cases`, duplicate case or widget ids, mixed case shapes, a case with none of the three shape fields, a missing/invalid blind key entry, candidate counts other than 2, and mismatched matrix candidate keys all throw a `TemplateError` naming the problem. A metric without a `value` throws rather than rendering a blank tile.
