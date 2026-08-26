# replay template

Conversation exchanges replayed through two to four named arms, one verdict per exchange. Use it when the reader's job is "did this arm's reply hold up" — a message sent to the same agent under different configurations (a flag off and on, two prompts, shipped vs candidate), judged reply against reply.

```
easel open --template replay --data pairs.json --title "Summarizer replay — full vs summary"
```

**Not this template:** documents or artifacts side by side with no message that produced them is `compare`. A *blind* two-candidate compare is `eval`'s compare mode. Adjudicating labeled cases one at a time with no arms is `rulings`.

## Input schema

```jsonc
{
  "title": "string",                 // required
  "summary": "string",               // optional, markdown lede
  "run": {                           // optional — renders as ONE prose line, muted keys / strong values
    "results": "run-stem-or-manifest",
    "judge": "claude-opus-5"
  },
  "arms": ["full context", "summary"],   // required, 2–4, unique — reply headings AND default vote options

  "cases": [{
    "id": "string",                  // required, unique across the board
    "name": "string",                // optional heading, defaults to id
    "context": "string",             // optional markdown above the exchange
    "badges": ["label", { "label": "string", "tone": "success|warning|error|info" }],

    "user": "string",                // required — the message every arm received; past ~700 chars it
                                     // renders as a lead plus the full text in a collapse
    "replies": {                     // required — every arm needs a reply, markdown
      "full context": "markdown",
      "summary": "markdown"
    },
    "judge": {                       // optional — the model judge's call, rendered to be checked
      "verdict": "equivalent",       // required inside judge
      "tone": "success|warning|error|info",   // optional, default info
      "reasons": "markdown"          // optional — the judge's reasoning, muted under the badge
    },
    "reference": {                   // optional — collapsed under the replies
      "label": "what actually happened",      // optional, default "reference"
      "text": "markdown"             // required inside reference
    },

    "ask": "string",                 // optional widget prompt, default "Your call on this exchange?"
    "askHelp": "string",             // optional one-line help
    "verdict": ["a","b"] | false     // optional — options override, or false for a read-only case
  }]
}
```

Every `replies` object must carry a key for **every** arm — a missing arm throws rather than rendering a lopsided exchange, because a blank column reads as "this arm said nothing" when it usually means the author forgot.

## Layout

Each case renders top to bottom: heading, badges, context, the user message as a card, one reply card per arm in a grid, the judge's badge and reasoning, the reference collapsed, then the verdict widget. The user message past ~700 characters shows its lead inline with the full text one click away — long pastes must not bury the replies they produced. The lead cuts at a paragraph break, never inside a code fence, so it always renders as valid markdown.

## One verdict per case

Options default to the arms plus `tie` and `all-bad`; override `verdict` when the ruling isn't "which arm wins" — e.g. `["equivalent", "summary weaker", "full weaker"]` when checking a judge's equivalence call, or recovery options for probe questions. Per-line detail belongs in annotations, which anchor to the reply cards anyway. For a case published to be looked at rather than voted on, set `"verdict": false`.

## Errors

Fewer than 2 or more than 4 arms, duplicate arm names, duplicate case ids, a missing `user`, a `replies` object missing an arm, a `judge` without a `verdict`, and a `reference` without `text` all throw a `TemplateError` naming the path.
