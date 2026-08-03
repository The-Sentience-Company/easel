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

  "sections": [                      // optional
    {
      "heading": "string",           // required
      "body": "string",              // optional, markdown
      "badges": [                    // optional
        "plain label",
        { "label": "string", "tone": "success|warning|error|info" }
      ]
    }
  ],

  "decisions": [                     // optional
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

At least one of `sections`, `decisions`, or `votes` must be present. `id` values must be unique across decisions *and* votes on the board — a collision throws, because two widgets sharing an id would record to the same key.

## Markdown supported in prose fields

Headings, ordered and unordered lists, blockquotes, fenced code, ` ```mermaid ` fences, tables, inline `` `code` ``, `**bold**`, `*italic*`, and `[links](https://example.com)`. Only `http(s):` and `mailto:` URLs survive; anything else is dropped.

### Tables

GitHub-flavoured. Leading and trailing pipes are optional, alignment colons work (`:---`, `:---:`, `---:`), inline formatting works inside cells, and `\|` is a literal pipe. Every table ships inside `sd-tablewrap`, so a wide one scrolls in its own container rather than making the page scroll sideways.

Row width is the header's: **a short row is padded with empty cells, and a long row's surplus cells are dropped.** That matches GitHub — but it means an extra cell disappears silently, so keep rows the width of the header.

Alignment is carried on a class, not a `style` attribute. The publish sanitizer strips `style`, so any hand-authored HTML that aligns via inline style will lose it — use the same `sd-align-left` / `sd-align-center` / `sd-align-right` classes.

## Behavior

Decisions and votes render as widgets. A click queues the choice as a draft on the same queue as annotations — reselecting replaces it — and **Send** delivers everything together; nothing reaches the agent before that.

Diagrams in a `mermaid` fence are rendered to inline SVG when the board is published. Write `<br/>` normally in a node label.

## Errors

`render` throws a `TemplateError` naming the exact path — for example `review.sections[2].heading must be a non-empty string`. Fix the data; the template never silently renders a partial board.
