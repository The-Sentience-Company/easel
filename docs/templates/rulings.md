# rulings template

Labeled cases adjudicated one by one, grouped by decision. Use it when the work is a set of individual judgments a reviewer accepts or overrules — a classification answer key, a triage list, a batch of model-vs-human disagreements, extraction goldens with include/exclude tiers as labels — rather than eval *output* to compare (that is the eval template).

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
      "options": ["good", "…"],         // optional — per-case vote options; [] = skim section, no votes
      "cases": [
        {
          "title": "string",            // required
          "label": "internal_name",     // required, must appear in labels
          "rationale": "string",        // optional, markdown — the KEY'S reasoning only (renders labeled "key rationale")
          "ask": "string",              // optional — YOUR commentary to the reviewer, a labeled "your agent" callout
                                        //   after the vote; or { "text": "…", "options": ["…"] } when you need an
                                        //   answer — the options render as the callout's own decision widget
          "model": "internal_name",     // optional — the model's verdict on this case; same label as the
                                        //   key renders one green "key + model aligned" pill, a different
                                        //   one contests the case exactly as `counter` does
          "borderline": true,           // optional — renders a tie-break badge
          "image": "https://…",         // optional — the judged object, rendered under the title;
                                        //   or { "src": "https://…", "px": 44, "round": true }
          "quote": { "text": "…", "source": "table:id" },          // optional evidence block
          "counter": {                                             // optional dissent (e.g. the model's verdict)
            "label": "…",                                          // required — renders as the "model vote:" pill
            "saw": "string",                                       // optional, markdown — the input the model judged
            "reason": "…"                                          // required — the model's own reasoning
          },
          "footnote": "string"          // optional — muted small print, rendered last (citations, dates)
        }
      ]
    }
  ],

  "case_options": ["…"],                // optional board-wide fallback (e.g. keep/drop for candidate content);
                                        //   a section's own `options` always wins — this does NOT override it
  "section_options": ["section is right", "needs amending"]   // optional, the per-section verdict widget
}
```

A case's `label` must appear in `labels` — an undefined label throws: a reviewer must never meet an internal name without a plain-word definition.

**The verdicts open the case as colored pills, the reasoning follows.** A case body leads with `key says: <label>` and, when contested, `model vote: <counter label>` — colored apart so the disagreement registers before any prose and a reader can skip cases where the two agree. That is why the blocks underneath name only their *reasoning* ("key rationale", "model rationale"): repeating the verdict in a block header is the noise the pills exist to remove. A skim case (no rationale, no vote) has no body to lead, so its pills sit on the title line instead.

**Record the model's verdict on every case, not only the disagreements.** On a key-vs-model board, a case with no model pill is indistinguishable from one where the model agreed — the reviewer cannot tell "we checked and it matched" from "nobody looked", and asks. Carry `model` on every case: matching the key renders a single green `key + model aligned` pill, and differing contests the case (orange `model vote:` pill plus the adjudication vote) exactly as `counter` does. Use `counter` instead of `model` when you also have the model's reasoning to show; the two express the same disagreement, so a case needs only one.

**Give the model's input when it explains the split.** `counter.saw` renders as "what the model saw", muted, directly above the model's rationale. Reach for it when the key and the model were working from different information — the usual cause of a defensible-looking model error, and impossible to adjudicate without seeing what the model had. When both judged the same text, leave it out; the `quote` block already carries the evidence.

**The vote names what it rules on.** When a section simply has no `options` field (leave it out — no explicit `null` needed), a case that carries a `counter` votes on the actual contest — `key is good: <label>` / `model is good: <counter label>` / `neither` — and an uncontested case gets the plain `good` / `bad` confirm. Set options explicitly only when the ruling isn't label-shaped. And `ask` is not the vote: give it options only when you genuinely need the reviewer's answer to a separate question — a reflex ask on every case competes with the vote for attention, which is the exact failure this design removed.

**One voice per field — never merge them.** A case speaks in up to four voices and each has its own field with its own labeled treatment: the key's reasoning in `rationale` ("key rationale"), the source excerpt in `quote`, the model's dissent in `counter` ("model disagreed"), and *your* framing or question to the reviewer in `ask` ("your agent"). Prose like "Key says X… iterate the prompt or accept the miss?" is your voice and belongs in `ask` — packing it into `rationale` leaves the reviewer unable to tell your commentary from the ruling they are reviewing, which has made a real board near-unreadable.

**Size the image to the surface it ships to.** Before authoring an image case, find where the image renders in the product and pass that display size: a thread chip that ships at ~40px is judged at `{ "px": 44, "round": true }`, not as a 200px hero. An oversized review image passes judgments the real surface fails — detail that reads at 200px vanishes at 40px. Default (no `px`) renders bounded at 200px, which is only right when the product shows it at least that large. If the data doesn't say where the image ships, ask — or state the surface you assumed on the board — rather than silently picking a size.

## Feedback altitudes

Three: per-case vote (compact buttons), per-section verdict widget, and the board-wide `questions` block for policy rulings that are not any single case's property. Annotations remain available everywhere as the free-text channel.
