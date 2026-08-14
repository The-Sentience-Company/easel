# review template

Plans, designs, comparisons, proposals — prose the human reads plus the decisions you need answered.

```
easel open --template review --data plan.json --title "Retry budget"
```

## Input schema

```jsonc
{
  "title": "string",                 // required
  "summary": "string",               // optional, markdown

  "metrics": [                       // optional — stat tiles above the first section
    { "label": "string", "value": "string|number", "note": "string" }
  ],

  "sections": [                      // optional
    {
      "heading": "string",           // required
      "body": "string",              // optional, markdown
      "collapse": "string",          // optional — fold the body behind this summary label
      "badges": [                    // optional
        "plain label",
        { "label": "string", "tone": "success|warning|error|info" }
      ],
      "decisions": [ ... ],          // optional, same shape as top-level; renders inside the section
      "votes": [ ... ]               // optional, same shape as top-level; renders inside the section
    }
  ],

  "decisions": [                     // optional — board-wide only; see placement rule below
    {
      "id": "string",                // required, unique across the board
      "question": "string",          // required
      "context": "string",           // optional, one-line help
      "options": [                   // required, non-empty
        "value",
        { "value": "string", "label": "string" }
      ],
      "detail": "string"             // optional, markdown shown under the widget
    }
  ],

  "votes": [                         // optional
    {
      "id": "string",                // required, unique across the board
      "question": "string",          // required
      "type": "vote|approve",        // optional, default "vote"
      "options": ["yes", "no"],      // optional, default ["yes","no"]
      "context": "string"            // optional
    }
  ]
}
```

At least one of `sections`, `decisions`, or `votes` must be present. `id` values must be unique across decisions *and* votes on the board — inline and top-level alike — a collision throws, because two widgets sharing an id would record to the same key.

**Placement rule: put each decision inside the section that motivates it** (`sections[].decisions`), so the reader answers with the relevant context directly above — never make them scroll back up from a pile at the bottom. Top-level `decisions`/`votes` render in a trailing "Decisions"/"Votes" section; reserve those for calls that genuinely span the whole board (final approve, overall verdict). A board whose every decision sits at the bottom is almost always mis-authored.

**Metrics frame the sections below them** — the 3–5 numbers that decide how the reader reads everything else (what it costs, how many, how often, what breaks). They render as a tile row above the first section. A board of only metrics throws: there is nothing to frame.

**`collapse` folds depth, never the ask.** Give it the summary label the reader clicks (`"the full derivation"`, `"all 41 rows"`) and the section's prose starts closed; badges, decisions, and votes stay outside the fold, so a collapsed section still shows what it wants from the reader. Use it for background a reader may already hold — not to hide something they need in order to answer. This is authored, default-closed depth; the chrome separately gives *every* headed section a reader-controlled collapse toggle, which starts open.

## Markdown supported in prose fields

Headings, ordered and unordered lists, blockquotes, fenced code, ` ```mermaid ` fences, tables, inline `` `code` ``, `**bold**`, `*italic*`, `[links](https://example.com)`, and `![images](https://example.com/x.jpg)` (rendered bounded — max-height 340px; pin a width in px with `![alt|96](url)`). Only `http(s):` and `mailto:` URLs survive; anything else is dropped; image `src` is `http(s):` only.

### Tables

GitHub-flavoured. Leading and trailing pipes are optional, alignment colons work (`:---`, `:---:`, `---:`), inline formatting works inside cells, and `\|` is a literal pipe. Every table ships inside `sd-tablewrap`, so a wide one scrolls in its own container rather than making the page scroll sideways.

Row width is the header's: **a short row is padded with empty cells, and a long row's surplus cells are dropped.** That matches GitHub — but it means an extra cell disappears silently, so keep rows the width of the header.

Alignment is carried on a class, not a `style` attribute. The publish sanitizer strips `style`, so any hand-authored HTML that aligns via inline style will lose it — use the same `sd-align-left` / `sd-align-center` / `sd-align-right` classes.

## Behavior

Decisions and votes render as widgets. A click queues the choice as a draft on the same queue as annotations — reselecting replaces it — and **Send** delivers everything together; nothing reaches the agent before that.

Diagrams in a `mermaid` fence are rendered to inline SVG when the board is published. Write `<br/>` normally in a node label. Unstyled diagrams render every node one uniform colour — when the nodes differ in kind (pipeline vs external system, happy vs failure path), paint them with the palette in `mermaid.md`'s authoring section.

## Errors

`render` throws a `TemplateError` naming the exact path — for example `review.sections[2].heading must be a non-empty string`. Fix the data; the template never silently renders a partial board.
