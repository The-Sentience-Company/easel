# What a board must carry

The template decides the shape. These decide whether the reader can act on it. Each one is here because boards kept failing the same way and the reader had to spend a comment asking for it.

## Ship the artifact, never a description of it

When the board's subject IS a change to something concrete, the change is on the board:

- a real unified diff in a ` ```diff ` fence for any text, prompt, config, or rule edit — **the fence works in every template's prose field**, not only `page`
- the verbatim payload in an `sd-collapse` for anything being reasoned about
- a rendered mockup for every UI option, showing every state the decision turns on — selected, opened, hovered — plus the surface it sits in; islands allow full CSS, so those states render
- real images for an image vote, at the size they ship at

A round that asks about an option and does not render that option burns the round. "Proposed, not applied" and "we'll show this next round" are for cosmetics only.

## Gloss every internal name, the first time it appears

Table, column, service, job, model id, flag, code path, acronym, campaign shorthand — and the board's own numbering. The gloss is the words themselves, not a link out. This is the single most common reason a reader stops to ask a question instead of answering the one you asked.

## Restate, never point

Anything quoted or decided on another board, an earlier round, or a prior ruling is restated in full where it is used. "Your round-9 ruling", "Decision 6", "as we discussed on the other board" all fail. A link may accompany the restatement; it never replaces it.

## A decision carries the basis for answering it

Adjacent to the widget: one line per option saying what it costs or buys, the recommendation and why, and the evidence it rests on. A question plus a list of option labels is not a decision — it is a board that comes back unanswered.

## Every proposed step earns its place in one line

Each new component, table, column, job, CLI, or extra PR states why it exists and what breaks without it — and where a simpler option existed, why it lost. A deliberately deferred choice states the tradeoff both ways and whether it can be swapped later.

## Every problem ships its recommended fix

A findings table has a "recommended" column with no empty cells. Where you genuinely have no recommendation, say so — "no fix proposed, I need your steer" — rather than trailing off. Diagnosing and stopping makes the reader supply the fix.

## Name a process, state its three facts

Cadence ("nightly 05:00 UTC", "once a month", "by hand"), trigger (what fires it), invoker (which agent, service, or human) — in the same block as the name. Without cadence the reader cannot size the cost or the risk.

## Source every non-obvious claim, or mark it a hypothesis

The query, the commit sha, the trace, the `file:line`. "Is there any way to prove this?" must be answerable from the board with no round trip. Any per-item verdict the board renders ships the evidence it came from, not just the label.

## Model output ships its run manifest

Above the first case: date window of the input, dataset or account, model id, number of runs, and the one-line delta versus the round being compared to. `eval` and `compare` both take a `run` object for exactly this. A blind arm label that maps to nothing stated on the board is unvotable.

## A population number is a distribution

p50 / p90 / p95, per user, per day. A bare total or a single mean fails when the ask is a sizing or pricing call.

## Prose has a budget

A section body past ~200 words with no table, list, diff, callout, diagram, metrics row, or collapse is a transcription — restructure it through `page.md`'s compose table. Wrap major sections in `sd-section` and give cards an `sd-card-title`: that is what earns the chrome's collapse control, and a bare `<h2>` silently forfeits it.

## Never fan a cohort across sibling boards

Work judged as a set — three people, three runs, four arms, before-and-after — is one board: one case per subject, one verdict per subject. Sibling boards differing only by subject go unread.
