# rulings template

Labeled cases adjudicated one by one, grouped by decision. Use it when the work is a set of individual judgments a reviewer accepts or overrules — a classification answer key, a triage list, a batch of model-vs-human disagreements — rather than eval *output* to compare (that is the eval template) or extraction goldens with include/exclude tiers (that is answer-key).

```
easel open --template rulings --data key.json --title "Dropped-balls key v2"
```

## What makes it different

The section grouping IS the decision structure: sections come in the order of judgment needed (contested rulings first, skim bulk last), every case can carry a one-click vote, and a case states its label, its rationale, the load-bearing quote, and — when a model or other party disagreed — that dissent as a visually distinct block. A skim section (`options: []`) costs one line per case and no buttons.

## Input schema

```jsonc
{
  "title": "string",                    // required
  "intro": "string",                    // required, markdown
  "footer": "string",                   // required, markdown — provenance line
  "status_badges": [ { "text": "…", "style": "success|info|warning|error|neutral" } ],   // optional

  "teach": {                            // required — rendered before any case
    "lead": "string",                   // required, markdown; label definitions render after it automatically
    "footnote": "string"                // optional, markdown
  },

  "labels": {                           // required — every label used by a case; plain-language description
    "internal_name": "what this label means, in words the reviewer knows"
  },

  "questions": [                        // optional — open policy questions as first-class decision widgets
    { "prompt": "string", "help": "string?", "options": ["…"] }
  ],

  "sections": [                         // required, non-empty
    {
      "heading": "string",              // required
      "help": "string",                 // optional, markdown
      "options": ["agree", "…"],        // optional — per-case vote options; [] = skim section, no votes
      "cases": [
        {
          "title": "string",            // required
          "label": "internal_name",     // required, must appear in labels
          "rationale": "string",        // optional, markdown
          "borderline": true,           // optional — renders a tie-break badge
          "image": "https://…",         // optional — the judged object, rendered under the title;
                                        //   or { "src": "https://…", "px": 44, "round": true }
          "quote": { "text": "…", "source": "table:id" },          // optional evidence block
          "counter": { "label": "…", "reason": "…" },              // optional dissent (e.g. the model's verdict)
          "footnote": "string"          // optional — muted small print, rendered last (citations, dates)
        }
      ]
    }
  ],

  "case_options": ["agree", "rule differently"],          // optional default for all sections
  "section_options": ["section is right", "needs amending"]   // optional, the per-section verdict widget
}
```

A case's `label` must appear in `labels` — an undefined label throws, same policy as answer-key's category rule: a reviewer must never meet an internal name without a plain-word definition.

**Size the image to the surface it ships to.** Before authoring an image case, find where the image renders in the product and pass that display size: a thread chip that ships at ~40px is judged at `{ "px": 44, "round": true }`, not as a 200px hero. An oversized review image passes judgments the real surface fails — detail that reads at 200px vanishes at 40px. Default (no `px`) renders bounded at 200px, which is only right when the product shows it at least that large.

## Feedback altitudes

Three: per-case vote (compact buttons), per-section verdict widget, and the board-wide `questions` block for policy rulings that are not any single case's property. Annotations remain available everywhere as the free-text channel.
