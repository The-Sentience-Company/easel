# What a board must carry

The template decides the shape. These decide whether the reader can act on it. Each one is here because boards kept failing the same way and the reader had to spend a comment asking for it.

## Ship the artifact, never a description of it

When the board's subject IS a change to something concrete, or to how something behaves, the change is on the board:

- a real unified diff in a ` ```diff ` fence for any text, prompt, config, or rule edit — **the fence works in every template's prose field**, not only `page`
- the verbatim payload in an `sd-collapse` for anything being reasoned about
- a rendered mockup for every UI option, showing every state the decision turns on — selected, opened, hovered — plus the surface it sits in; islands allow full CSS, so those states render
- real images for an image vote, at the size they ship at
- a worked example for a decision about behaviour: one real input (a message, a settings row, a request) and what the person sees under each option, side by side, because a behaviour described in prose reads the same for every option until the reader sees two outputs differ
- a diagram in a ` ```mermaid ` fence when the flow crosses more than two parts (an app, a server, a third-party service), its boxes labelled with what happens
- a state table for a control with three or more states: one row per state, what the person sees and what a click does

A round that asks about an option and does not render that option burns the round. "Proposed, not applied" and "we'll show this next round" are for cosmetics only.

## Gloss every internal name, the first time it appears

Table, column, service, job, model id, flag, code path, acronym, campaign shorthand — and the board's own numbering. An internal name is any name that did not exist before this project, or that this session coined: a card id, a pane callsign, a label like "Fix 4(a)" or "arm B", a phrase from a design note. The test is not whether *you* know it; it is whether the reader could have met it anywhere but here. The gloss is the words themselves, not a link out, in the sentence that first uses the name; when the board leans on three or more such names, gloss them in a term | meaning table before the first section. This is the single most common reason a reader stops to ask a question instead of answering the one you asked.

## Say what the work is before the ask

Write the board's `about` for a reader who has not seen the project: what the thing does for a person today, what was wrong, what this round changes, and what is left. A reader who meets only the ask spends the round asking what they are looking at, and a diff they cannot place is one they cannot approve. Match the depth to how far the reader stands from the subject:

| The board is about | `about` carries |
|---|---|
| product behaviour: a reply the product gives, a tool it runs, a message it sends, a test of one of those | a short paragraph on each of the four points; a term table when they lean on internal names; a before-and-after diagram or a worked example (the message, the reply) |
| the reader's own tooling: a rule in their config, a skill, a step of a process they run | one or two sentences; the reader knows the system, and the ask is the content |

The ask stays in `summary`. The review template refuses a board whose `about` is missing, and the publish check names an `about` that opens on the ask or a status.

RIGHT, product behaviour:

> The chat gets a fixed list of tools at the start of every conversation; a tool it rarely needs is found by searching an index, then run. Until now a found tool was added to that list, which threw away the provider's cache and made every later message in the conversation pay for the whole history again. The fix keeps the list fixed: the search reply carries the found tool's settings as text, and one always-present tool runs it by name. That changed the words the model reads in five places, one section each below.
>
> *(then a before-and-after diagram of the two paths)*

RIGHT, the reader's own tooling:

> A rule in your config asks every pull request that changes a screen to ship before-and-after captures; only your agents follow it. This moves the rule into the repo so every agent loads it.

WRONG, the ask with nothing on the work (the reader cannot tell a good diff from a bad one):

> **What I need from you.** Read five diffs below, one per file, each with its own Approve button.

## Restate, never point

Anything quoted or decided on another board, an earlier round, or a prior ruling is restated in full where it is used. "Your round-9 ruling", "Decision 6", "as we discussed on the other board" all fail. A link may accompany the restatement; it never replaces it.

## A decision carries the three facts a cold reader needs

Write every decision for a reader who has not seen the project. Directly above the buttons, in this order:

1. **What this is** (`what`): one sentence on what a person using the product, or the reader as its operator, gets or sees when this ships.
2. **Why you decide** (`why_you`): one sentence on what this decision alone settles, or what goes wrong for the person if the wrong option ships. An earlier ruling it rests on is restated here, never pointed at. The line is specific to its decision; the template refuses two decisions on one board carrying the same line, because a sentence true of every decision tells the reader nothing about any of them. RIGHT: "If the search reply's next line is unclear, the model calls the found tool by a name it no longer has, and the user sees a failed turn." WRONG, on every decision of one board: "Every line a model reads is yours to approve before merge."
3. **What each option changes** (`basis`, one per option, `recommended` on the pick): the consequence that person or the reader would notice, with an example where the options give different output.

The review template renders them in that order and refuses a decision that lacks any of them, because a question phrased in the author's terms (a column, a counter, a prompt line) reads as clear and still cannot be answered. An author who cannot write the `why_you` line has found a decision that is the lane's to make, not the reader's. The evidence the options rest on goes in `detail`, above the frame. The button label itself is two or three words — "Size floor", "Leave them", "Ticket it" — never the consequence, the caveat, or "(recommended)". **A question plus a list of option labels is not a decision, and a basis that describes the build ("the fix lands on the pull request") instead of its effect is not a basis.**

When the answer can differ from one item to the next — per row, file, or case — write one decision per item, its `detail` carrying that item's evidence and diff, because the reader judges one item at a time and needs that item's facts at that item's buttons. **Never a table of every item above one decision about the set.**

## Every proposed step earns its place in one line

Each new component, table, column, job, CLI, or extra PR states why it exists and what breaks without it — and where a simpler option existed, why it lost. A deliberately deferred choice states the tradeoff both ways and whether it can be swapped later.

## Every problem ships its recommended fix

A findings table has a "recommended" column with no empty cells. When the reader rules on each finding, each row becomes that finding's decision instead, its fix the recommended option. Where you genuinely have no recommendation, say so — "no fix proposed, I need your steer" — rather than trailing off. Diagnosing and stopping makes the reader supply the fix.

## Name a process, state its three facts

Cadence ("nightly 05:00 UTC", "once a month", "by hand"), trigger (what fires it), invoker (which agent, service, or human) — in the same block as the name. Without cadence the reader cannot size the cost or the risk.

## Source every non-obvious claim, or mark it a hypothesis

The query, the commit sha, the trace, the `file:line`. "Is there any way to prove this?" must be answerable from the board with no round trip. Any per-item verdict the board renders ships the evidence it came from, not just the label.

A premise one command settles (a count, a flag's value, whether a file exists) is run before the round goes out, and the board shows the command and its output; every other premise carries the word *reasoned*, so the reader can tell a checked fact from an inference before acting on it.

## Model output ships its run manifest

Above the first case: date window of the input, dataset or account, model id, number of runs, and the one-line delta versus the round being compared to. `eval` and `compare` both take a `run` object for exactly this. A blind arm label that maps to nothing stated on the board is unvotable.

## A population number is a distribution

p50 / p90 / p95, per user, per day. A bare total or a single mean fails when the ask is a sizing or pricing call.

## Every paragraph takes the shape of what it is made of

Choose the shape per paragraph, not per section. The template shapes the board; inside a prose field — `summary`, a section `body`, a decision's `detail`, a queue entry's `body` — markdown is the whole vocabulary, and a section that already has a table still owes each paragraph around it its own shape. A reader scans shape, not sentences; a run of parts typed as one paragraph is what comes back annotated "wall of text". Before writing a paragraph, name what it is made of and write that:

| The paragraph is made of | Write it as |
|---|---|
| terms and their meanings — a glossary, `*X* = …, *Y* = …` | a two-column table, term \| meaning |
| options and what each costs or buys — `"Leave": …; "Add": …`, `(a) … (b) …` | one bullet per option, label in bold; three or more with the same attributes → a table |
| labeled facts — `Cost: … User-visible: … Persisted: …` | one bullet per label, label in bold |
| what happens, then what, then what | a numbered list, one step per item |
| several questions | a numbered list, one per item, each with its own answer or widget |
| a verbatim sample — a model reply, a digest, a payload | a fence, a blockquote, or an `sd-collapse` |
| a claim and where it came from | the claim in prose; the source on its own `Source:` line or in the table row it supports |

The tells of a list typed without line breaks: `(a)` or `(1)` inside a sentence, a second `Label:` run, a second `"term" =`, a third inline `code` span. **Any of these in a paragraph means restructure it before publishing.** One idea per paragraph, about four sentences; a section that is only paragraphs is a transcription. On a `page` the same rule runs through the compose table with `sd-` classes, inside an `sd-section` whose heading is a real `<h2>` — that is what the chrome sizes as a heading (27px against 16px) and what earns its collapse toggle and the "collapse section" control. An `sd-card-title` is a card's label: directly under an `sd-section` it renders at card size and earns no control at all. Use it inside an `sd-card`, never as a section heading.

## Never fan a cohort across sibling boards

Work judged as a set — three people, three runs, four arms, before-and-after — is one board: one case per subject, one verdict per subject. Sibling boards differing only by subject go unread.
