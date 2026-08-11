# answer-key template

Hand-authored eval goldens laid out for human review: what the model *should* say about someone, what it must *never* say, and the evidence behind each call.

```
easel open --template answer-key --data key.json --title "Preference extraction key v4"
```

## What this template is for

An answer key is a judgement call about content, and the reviewer's job is to check the judgement — not the facts. So the page opens by teaching its own rules, then shows one card per category × person, then asks for a verdict at two altitudes.

## Input schema

```jsonc
{
  "title": "string",                    // required
  "intro": "string",                    // required, markdown
  "footer": "string",                   // required, markdown — provenance line

  "status_badges": [                    // optional
    { "text": "key v4", "style": "success|warning|error|info|neutral" }
  ],

  "teach": {                            // required — rendered before any content
    "lead": "string",                   // required, markdown
    "steps": [                          // required, non-empty
      { "title": "string", "desc": "string" }
    ],
    "positives": "string",              // required, markdown — what "should include" means
    "negatives": "string",              // required, markdown — what "must not include" means
    "footnote": "string"                // optional, markdown
  },

  "check_focus": [                      // required, non-empty
    { "label": "string", "text": "string", "style": "success|..." }
  ],

  "category_labels": {                  // required — every category used by a cell
    "internal_name": "Plain language label"
  },

  "reasons": {                          // required — every reason used by a negative
    "internal_name": {
      "label": "string",                // required, the badge text
      "desc": "string",                 // required, plain-language explanation
      "style": "success|..."            // optional
    }
  },

  "cells": [                            // required, non-empty
    {
      "category": "internal_name",      // required, must appear in category_labels
      "person": "string",               // required
      "header": ["412 messages"],       // optional, small context lines
      "entry_options": [],              // optional, overrides the top-level entry_options for this cell
      "positives": [
        {
          "content": "string",          // required
          "note": "string",             // optional
          "must_not_violate": true,     // optional — the zero-tolerance tier
          "evidence": [{ "pointer": "messages:4471", "text": "resolved excerpt" }]
        }
      ],
      "negatives": [
        {
          "content": "string",          // required
          "reason": "internal_name",    // required, must appear in reasons
          "note": "string",
          "evidence": [ /* same shape */ ]
        }
      ]
    }
  ],

  "must_not_violate_label": "string",   // optional, overrides the default badge wording
  "entry_options": ["agree", "rule differently"],  // optional — compact vote buttons under EVERY entry; a cell's own entry_options overrides ([] switches them off for that cell)
  "cell_options": ["looks right", "has a problem"],          // optional
  "verdict_options": ["scope is right", "mis-scoped", "…"],  // optional
  "evidence_copy_prefix": "evrow ",     // optional; a SHORT visible token (max 16 chars, enforced) rendered inline before each pointer — not click-to-copy

  "how_to_test": {                      // optional
    "review_steps": ["string"],
    "code_blocks": [{ "title": "string", "code": "string", "note": "string" }]
  }
}
```

A cell needs at least one positive or one negative — an empty cell tells the reviewer nothing and throws.

## Evidence arrives resolved

Each evidence entry is `{ pointer, text }`, where `text` is the excerpt the pointer resolves to. **Resolution happens at data-prep time; the template never queries a database.** Whoever builds the JSON is responsible for turning `messages:4471` into the row's text.

The chip renders the pointer as selectable monospace followed by the excerpt. It is inert — no click behavior — because templates emit markup and the chrome owns behavior. `evidence_copy_prefix` is therefore visible page text repeated on every chip, not a clipboard payload — the render throws past 16 chars. If the reviewer needs a runnable command around the pointer, put it once in `how_to_test.code_blocks`. An entry with no `text` renders an explicit *"evidence text was not resolved at build time"* note rather than a bare pointer, so an unresolved lookup cannot pass for a deliberately pointer-only chip.

## What the board already provides — don't rebuild it

This template is deliberately smaller than the standalone HTML builder it replaces, because the daemon owns most of that machinery:

| The old builder did this | Here it is |
| --- | --- |
| Per-entry flag buttons | The annotation layer — select any text and annotate it |
| Per-cell confirms and per-category verdicts | `approve` and `decision` widgets, emitted by this template |
| Key-version stamp on every queued prompt | Board rounds — republish and the round advances |
| Prompt queueing, one-click-to-queue | The feedback queue and **Send** |
| Inline correction textareas | The annotation popover's comment box |

The last row is not a preference. The publish sanitizer's element allowlist has no `input`, `textarea`, or `select`, so a correction textarea **cannot** be expressed as template markup at all.

Layout rides existing `sd-*` classes only; this template adds no CSS. Alignment and spacing must never use a `style` attribute — publish drops it.

## Two feedback altitudes

Every cell gets an `approve` widget, and every category gets a `decision` widget beneath its cells. Both altitudes exist because a systemic mis-scoping otherwise arrives as N scattered per-entry notes, leaving the reviewer's real point to be inferred during synthesis.

A third, finer altitude is opt-in: `entry_options` puts a compact vote row (small quiet buttons, no rule line) under every entry, so ruling on an individual case is one click instead of a text annotation. Turn it on when the board's entries are individual judgments a reviewer accepts or rejects one by one (an answer key's cases); leave it off — globally, or per cell with `entry_options: []` — for bulk/skim sections where a button per line would be noise.

Widget ids are derived from the category and person (`cell-comms-pref-dana-whitfield`, `verdict-comms-pref`). Two cells with the same category *and* person collide and throw.

## Errors

`render` throws a `TemplateError` naming the exact path, and the template never renders a partial board.

Two checks are stricter here than in the Python builder that preceded this template, which only printed warnings:

- **A category with no entry in `category_labels` throws.**
- **A negative whose reason has no `desc` throws**, as does a reason absent from `reasons` entirely.

Both are deliberate. The review protocol requires that an internal name never reach the reviewer without a plain-word explanation, and a warning on stderr does not stop the page from being published with `comms_pref` as a heading. Invented jargon has cost a review round before; making it unpublishable is the point.
