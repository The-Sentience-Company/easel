# page template

The escape hatch: hand-authored HTML through the same shell, chrome, annotation layer, and design system. Use it when the content genuinely is not a review or an eval.

```
easel open --template page --data page.json --title "..."
```

## Input schema

```jsonc
{
  "html": "string",   // required, body-inner HTML
  "title": "string"   // optional
}
```

`html` is passed through unchanged. It is validated, not sanitized — you own what you write.

## Rules the template enforces

Input is rejected with a `TemplateError` if it contains:

- `<html>`, `<head>`, or `<body>` tags — supply body-inner HTML only; the daemon owns the document shell.
- `data-sid` — the daemon assigns stable node ids at publish, and annotations anchor to them.
- any `sf-` class — that prefix belongs to the chrome.

## Compose, don't transcribe

A `page` is a layout, not a document. Content drafted as markdown and wrapped in a card arrives as headings and paragraphs — the only structure markdown can say — so the design system is out of the game before a single class is chosen. Author the HTML directly, and pick structure from the shape of the content:

| The content is | Structure it as |
|---|---|
| the 3–5 facts that frame everything else — where it runs, what it costs, what it may do, what failure looks like | an `sd-metrics` row, first thing on the page |
| a mechanism with 2–4 separable parts | an `sd-grid` of `sd-card`s, one part per card, named by its `sd-card-title`; decisive tokens in `<strong>`, identifiers in `<code>` |
| behavior with an accept path and a reject path | one worked example each way, side by side in an `sd-grid`: `sd-callout-success` beside `sd-callout-error` |
| edge cases, states, failure modes | a table in `sd-tablewrap` with a status column — `sd-badge-success` handled, `sd-badge-info` by design, `sd-badge-warning` known gap |
| a flow with branches | `<pre class="mermaid">` |
| a verbatim payload — prompt, config, transcript | `sd-collapse` |

The pre-publish test: when most body text sits in `<p>` runs inside one `sd-card`, the page is a transcription — restructure it.

### Eval shapes that land here, for now

Adjudicating labeled cases and goldens have their own template (`rulings`); two-candidate blind compares have `eval`. Two eval shapes still have no template and belong on a page — a season of boards converged on the same structure, so use it rather than reinventing:

- **Blind compare with 3+ arms or per-case context**: one `sd-section` per case with the context (the day's input, the run's parameters) above the candidates, candidates as an `sd-grid` of `sd-card`s labelled A/B/…, and one `vote` widget per case whose options are the labels plus `tie`/`all-bad`. Keep the blind key in the harness, never in the page.
- **Image votes**: an `sd-grid` of `sd-card`s, each an image plus its `vote` widget; keep per-image options identical so votes aggregate.

The shape, compressed:

```html
<div class="sd-metrics">
  <div class="sd-metric">
    <div class="sd-metric-label">Where it runs</div>
    <div class="sd-metric-value">Last step before write</div>
    <div class="sd-metric-note">after folds and the cap</div>
  </div>
</div>

<div class="sd-grid">
  <div class="sd-card"><div class="sd-card-title">1 · What flags a pair</div>…</div>
  <div class="sd-card"><div class="sd-card-title">2 · The one model call</div>…</div>
  <div class="sd-card"><div class="sd-card-title">3 · The collapse guard</div>…</div>
</div>

<div class="sd-grid">
  <div class="sd-callout sd-callout-success"><div class="sd-callout-title">Merge accepted</div>…</div>
  <div class="sd-callout sd-callout-error"><div class="sd-callout-title">Merge rejected by the guard</div>…</div>
</div>

<div class="sd-tablewrap"><table>
  <thead><tr><th>Edge case</th><th>What happens</th><th>Status</th></tr></thead>
  <tbody><tr><td>…</td><td>…</td><td><span class="sd-badge sd-badge-warning">known gap</span></td></tr></tbody>
</table></div>
```

## Use the design system

The `sd-` classes carry the layout and contrast guarantees, so prefer them over hand-written styles:

| Class | For |
|---|---|
| `sd-card`, `sd-card-title` | bordered content blocks |
| `sd-grid`, `sd-row`, `sd-col` | layout; children already have `min-width: 0` |
| `sd-badge` + `sd-badge-success\|warning\|error\|info` | status pills; they wrap instead of clipping |
| `sd-badge-key` + `sd-badge-value` inside an `sd-badge` | two-voice pill: filled mono key, weighted value — `<span class="sd-badge"><span class="sd-badge-key">model</span><span class="sd-badge-value">GPT sol</span></span>`; a tone class colours the key segment |
| `sd-tablewrap` wrapping a `<table>` | every table, so the page never scrolls sideways |
| `sd-pick-row` on a `<tr>` | a row of judgment widgets belonging to the row above — no separator between them |
| `sd-metrics`, `sd-metric`, `sd-metric-label`, `sd-metric-value`, `sd-metric-note` | stat tiles |
| `sd-collapse` on `<details>`, `sd-collapse-body` | expandable sections |
| `sd-muted`, `sd-mono` | de-emphasized and monospace text |
| `sd-diff` on a `<pre>` | a unified diff, rendered green/red per line |

### Diffs

A diff you have already produced renders in colour rather than as a monochrome code block. Write a ` ```diff ` fence in any markdown body, or a `<pre class="sd-diff">` in hand-authored `page` HTML — both reach the same publish-time step, which splits the block into one element per line.

````
```diff
@@ -1,3 +1,3 @@
 unchanged context
-the quick brown fox
+the quick red fox
```
````

Removed lines take a red tint, added lines green, context stays untinted, and hunk and file headers recede to the muted tier. The tint covers the **whole** line box, so a paragraph-length line in a prose diff stays tinted where it wraps instead of colouring only its first line; wrapped lines hang past the marker so the prose edge stays straight.

Where N removed lines are followed by N added lines they pair by position, and where a single removed line is followed by several added lines it pairs with the first; the paired lines get word-level emphasis — the words that actually changed take a deeper tint of the same hue — and any further added lines are treated as wholly new. Punctuation and HTML entities are their own tokens, so a sentence extended past its full stop (`this is words` → `this is words. more words`) marks the addition alone rather than dragging the mark back over text that did not change. The two lines are aligned by longest common subsequence, so several edits on one line mark as several spans — `timeout 30 retries 3` → `timeout 60 retries 5` tints the two numbers, not everything between them. Unequal runs (three out, two in) have no correspondence to read, so they get the line tint only. A line that was rewritten rather than edited shares incidental words with its old self; past a few separate edits the emphasis covers the changed middle whole, because four scattered tints stop reading as "these words changed".

This renders a diff; it does not compute one. Supply real unified-diff text — the marker character at the start of each line is the entire input contract. Two traps follow directly from that contract:

- **The marker must be an ASCII hyphen (0x2D).** A typographic minus (U+2212 `−`) — which LLM-generated or copy-pasted prose swaps in silently — is not classified, so the line renders as plain context with no red. If a diff looks half-coloured, check the bytes first.
- **Only diff text belongs inside the block.** Embedded prose whose lines start with `-` (markdown bullets in a prompt, YAML lists) renders as deletions — red tint, del semantics — even though nothing changed. Put verbatim payloads in an `sd-collapse` code block instead and diff only what actually differs.

Two things worth knowing before styling around it:

- **The `+`/`-` glyph is deliberately still legible** (measured ≥4.5:1 on its tint). It is de-emphasised against the line text, but the red and green tints differ almost only in hue, so the glyph is the one add/remove signal that survives colourblindness. Dimming it further makes the diff unreadable for those readers.
- **Each line is separately annotatable.** Every line is a block element and gets its own `data-sid`, so a comment anchors to one line rather than to the whole block. A blank context line is the exception: it paints nothing and takes no sid.

### Editorial structure

| Class | For |
|---|---|
| `sd-masthead` | wraps the title block above the first section |
| `sd-lede` | one serif paragraph above body scale; `sd-intro` applies it to its first paragraph automatically |
| `sd-eyebrow`, `sd-eyebrow-strict` | mono uppercase kicker labelling what follows; the strict variant takes the accent |
| `sd-secnum` | section number in accent mono, placed inside the heading |
| `sd-tag`, `sd-taglist` | outlined mono label carrying no status colour, and its row |
| `sd-flag` | the one filled label, reserved for a hard stop |
| `sd-badge-row` | spacing for a row of `sd-badge`es |
| `sd-section`, `sd-count` | a numbered content section and its item count |
| `sd-entries`, `sd-entry`, `sd-entry-name`, `sd-entry-meta` | a grid of per-subject cards |
| `sd-steps`, `sd-step`, `sd-step-index`, `sd-step-body`, `sd-step-title` | a hairline-separated ordered list |
| `sd-rules`, `sd-rule` | side-by-side rule columns |
| `sd-focus`, `sd-focus-list` | a bordered checklist panel |
| `sd-claims`, `sd-note`, `sd-evidence`, `sd-evidence-pointer`, `sd-evidence-text` | claim lists and their quoted support |
| `sd-code-title`, `sd-colophon` | a heading above a code block, and closing small print |

### Islands — freeform sections

`<div data-island data-island-title="Diff view" data-island-height="360">…any html + css…</div>` renders its inner content in a sandboxed frame: full CSS freedom (inline `<style>` included), no scripts, no network, `data:` images/fonts only. Use for layouts the `sd-*` system cannot express — image comparisons, custom diffs — and stay in `sd-*` everywhere else: no diff markers inside an island. `data-island-height` is the pre-load height; the frame then self-sizes. In annotate mode a click inside an island drops a **pin** — a point annotation carrying fractional coordinates and the clicked element's text — so individual design elements are commentable with no authoring change; the island as a whole stays annotatable via its placeholder.

### Callouts, accents and citations

| Class | For |
|---|---|
| `sd-callout` + `sd-callout-info\|success\|warning\|error` | a block that holds prose. Use this, never a badge stretched over a paragraph — badge colours are sized for a short pill. The status accent rides the top edge; coloured left bars are reserved for the chrome's round-diff marks |
| `sd-callout-title` | the first line inside a callout |
| `sd-accent`, `sd-accent-alt` | an opt-in left edge on an `sd-entry` or `sd-card`, for telling one entry from the next. `alt` is the teal second accent |
| `sd-cites` | wraps a run of citations |
| `sd-cite` | one citation: a left gutter and a content column |
| `sd-cite-meta` + `sd-cite-date`, `sd-cite-label` | the gutter — when and where it came from |
| `sd-cite-body` + `sd-cite-title` | the content column: what it says and why it matters |

```html
<div class="sd-callout sd-callout-warning">
  <div class="sd-callout-title">Heads up</div>
  <p>A whole paragraph of explanation reads at body contrast here.</p>
</div>

<div class="sd-entry sd-accent">…</div>

<div class="sd-cites">
  <div class="sd-cite">
    <div class="sd-cite-meta">
      <span class="sd-cite-date">2026-07-14</span>
      <span class="sd-cite-label">payload 40</span>
    </div>
    <div class="sd-cite-body">
      <div class="sd-cite-title">Contrast regression</div>
      <p>Why this source matters.</p>
    </div>
  </div>
</div>
```

**The relation is spatial, not inline.** Date and source sit in the gutter, the claim sits beside them, and a hairline separates one citation from the next — so a reader sees at a glance which source backs which statement. Below 720px the gutter collapses and the meta keeps its own line above the content. To add "why it matters" as a distinct block, nest an `sd-callout` inside `sd-cite-body`.

### Highlighting

`<mark>` renders as **accent-coloured text with no fill**. The browser default paints a yellow block that is unreadable on a dark ground and whose padding breaks the line box, so the fill is removed rather than recoloured. It stays `display: inline`, so a mark never pushes onto its own line.

### The stepper

A progress rail. State comes from a class on each node, never from its position, so a rail can show a failure anywhere in the sequence:

```html
<ol class="sd-stepper">
  <li class="sd-stepper-node sd-stepper-done">
    <span class="sd-stepper-mark"></span>
    <div class="sd-stepper-body"><div class="sd-stepper-title">Fetched</div>
      <div class="sd-stepper-note">412 rows</div></div>
  </li>
  <li class="sd-stepper-node sd-stepper-error">
    <span class="sd-stepper-mark"></span>
    <div class="sd-stepper-body"><div class="sd-stepper-title">Upload failed</div></div>
  </li>
</ol>
```

`sd-stepper-done` draws a tick, `sd-stepper-error` a cross, `sd-stepper-current` an accent outline, and a node with none of them reads as pending. An empty node paints nothing and so is not annotatable — always give a node a body.

### Two text tiers

Body prose renders at `--color-body-content`, deliberately softer than `--color-base-content`, which is reserved for emphasis (`<strong>`), headings, table cells and controls. Hierarchy is carried by that difference, so do not reach for `<strong>` on a whole paragraph — it flattens the page back to one tier.

## Interactive elements

Only native controls stay clickable inside a session — `button`, `input`, `select`, `textarea`, and `<details>`/`<summary>`. A styled `div` acting as a toggle becomes an annotation target instead and never fires.

To collect structured input, use the widget protocol rather than rolling your own handler:

```html
<div data-widget="vote" data-widget-id="ship-it">
  <div class="sd-widget-prompt">Ship it?</div>
  <div class="sd-widget-options">
    <button type="button" data-option="yes">yes</button>
    <button type="button" data-option="no">no</button>
  </div>
</div>
```

The daemon binds the click and queues the value as a draft; Send delivers it.

## Diagrams

Put mermaid source in `<pre class="mermaid">…</pre>`. It is rendered to inline SVG at publish time, so there is no client-side renderer to configure and no startup race. Write `<br/>` normally in node labels — the source is entity-decoded before rendering, and the sketch and whiteboard render it as a line break. Unstyled diagrams render every node one uniform colour — when the nodes differ in kind, paint them with the palette in `mermaid.md`'s authoring section.

Avoid `subgraph`: the excalidraw converter reports it unsupported, so the diagram silently falls back to a plain mermaid SVG with no whiteboard scene and no look toggle. Redraw grouped flows without subgraphs (e.g. prefix node labels) to keep the diagram whiteboardable.
