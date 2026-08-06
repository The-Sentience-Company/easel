# Creating a new template

How to add a template type to easel, and the contract it has to honor. The existing templates are the reference implementations — `review.js` is the smallest complete one, `page.js` shows validation without generation, `eval.js` shows mode-switching on data shape.

## Should this be a template at all?

A template earns its place when a *shape of work* recurs: the same kind of data, reviewed the same way, wanting the same validation. One-off layouts belong in the `page` template — it takes hand-authored HTML through the same chrome and design system, and it already exists.

The test: if you can't name the second and third board that would use it, use `page`.

## What a template is

One ES module in `templates/`, exporting two things:

```js
export const name = 'my-template'
export function render(data) { ... }   // data (parsed JSON) → body-inner HTML string
```

`render` runs at publish time, on the daemon. It gets the parsed contents of the board's `--data` file and returns the HTML that becomes the round. That's the whole interface — no lifecycle, no client code, no registration object.

## The contract

These rules are enforced by the contract suite in `test/templates.test.js`, which runs every template through them automatically. They exist because the output of `render` flows into machinery that depends on them:

- **Body-inner HTML only.** No `<html>`, `<head>`, or `<body>` — the daemon owns the document shell.
- **Never emit `data-sid`.** The daemon assigns stable node ids at publish; annotations anchor to them. A template that sets its own would collide.
- **Never emit `sf-` classes.** That prefix belongs to the chrome (`chrome/easel.css`). Style with the `sd-*` design system only — every class is documented in [page.md](page.md).
- **No `style` attributes.** The publish sanitizer drops them. Alignment, tone, and layout all ride `sd-*` classes (see `tableMarkup` in `_html.js` for the pattern).
- **Escape everything.** `esc()` for text, `attr()` for attribute values, `markdown()` for prose fields. Raw interpolation of data into HTML is how a board becomes an injection vector — the daemon's origin also serves the unauthenticated API.
- **Deterministic output.** Same data → same HTML, byte for byte. Round-to-round diffing matches nodes structurally; anything random (ids, timestamps, ordering from object iteration) makes every round look fully rewritten.

## Validation is the user interface

A template is *validated, not sanitized*: bad data must throw, never render wrong or drop content silently. The agent authoring the data file sees your error message at `easel open` / `easel publish` time — it is the only feedback they get, so make it name the path and the expectation:

```js
requireString(s.heading, `review.sections[${i}].heading`)
// → "review.sections[3].heading must be a non-empty string"
```

`_html.js` provides `fail()`, `requireObject`, `requireArray`, `requireString`, and `TemplateError`. Two rules of thumb from the existing templates:

- **Reject, don't repair** — `page.js` rejects `sf-` classes rather than stripping them, so the author learns the rule.
- **Pad, don't drop** — the markdown table parser pads ragged rows rather than losing cells. When data is merely *incomplete*, preserving it beats failing; when it's *wrong*, fail loudly. Never the quiet middle path.

## Use the shared helpers

`templates/_html.js` is the toolkit, and using it is what keeps templates consistent:

| Helper | What it guarantees |
|---|---|
| `markdown(src)` | Prose fields: headings, lists, tables, fences. A ```` ```mermaid ```` fence becomes the element `render/mermaid.js` replaces with SVG at publish; ` ```diff ` likewise for `render/diff.js` |
| `widget({type, id, prompt, help, options})` | Decision UI. Native buttons, so the annotation layer can't swallow the click; `client.js` owns all behavior |
| `makeIdGuard(name)` | Widget-id uniqueness per render — two widgets sharing an id would record to the same key |
| `badge(label, tone)` | Validated against the five tones; wraps instead of clipping |
| `table(columns, rows)` | Always inside `sd-tablewrap`, so a wide table scrolls instead of breaking the page |

Widget clicks arrive in feedback as `{kind: "widget", widgetId, value}` — nothing to build on the template side.

## Registration: four places, checked by tests

A new template lands in four places. The contract suite fails with a named message for each one you miss:

1. `templates/<name>.js` — the module
2. `daemon/server.js` — the `TEMPLATES` allowlist (one string in a Set)
3. `test/preview.js` — the `TEMPLATES` map
4. `test/samples/<name>.json` — realistic sample data, plus adding the module to the `TEMPLATES` array in `test/templates.test.js`

Step 4 is what buys you the automatic coverage: document-tag checks, `sf-`/`data-sid` checks, TemplateError-on-garbage, preview and allowlist registration.

Then write `docs/templates/<name>.md` — the data-format doc for the people (and agents) who will author boards with it. Follow the shape of the existing ones: what the template is for, the input schema as annotated JSONC, and any workflow rules that only apply inside this flow. The agent skill tells authors to read that file before writing data, so it is not optional.

## Iterate without the daemon

```
node test/preview.js my-template test/samples/my-template.json --out /tmp/p.html --theme dark
```

renders your template inside the real shell and CSS, no daemon involved. Add `--mermaid` to run diagram rendering, `--chrome` for the full chrome. Sample data doubles as your development fixture, so invest in making it realistic — it's also what appears in the contract tests and any future screenshot sweep.

## Two design lessons from the existing set

**Switch on data shape, not flags.** `eval.js` renders dossiers, a blind two-column compare, or an item matrix depending on whether the data carries `notes`, `candidates`, or `items`. There is no `mode` field. The data already says what it is; a flag would just be a second way to say it that can disagree with the first.

**Round HTML is baked.** A published round never re-renders — template changes affect future rounds only. That's a feature (rounds are a stable record), but it means a template bug ships permanently into any round published while it existed. The preview harness plus a real sample file before first publish is cheaper than a board full of broken rounds.
