# gallery template

Image candidates the reader judges by looking at them — design concepts, generated imagery, UI states, before-and-after screenshots.

```
easel open --template gallery --data concepts.json --title "Life Threads UI — seven concepts"
```

**Not this template:** text arms are `compare`; a single hand-authored layout is `page`. Reach for `gallery` the moment the thing being judged is a picture — describing a design in prose and asking for a vote is the failure this template exists to prevent.

## Input schema

```jsonc
{
  "title": "string",                 // required
  "summary": "string",               // optional, markdown lede
  "groups": [{                       // required (or a bare top-level "candidates" for a single group)
    "id": "string",                  // optional, defaults to g1, g2 … — becomes the widget id
    "heading": "string",             // optional
    "context": "string",             // optional markdown above the grid
    "badges": ["label", { "label": "string", "tone": "success|warning|error|info" }],
    "candidates": [{                 // required, non-empty
      "label": "string",             // required, unique in the group — the card title AND the vote option
      "src": "https://…",            // required, http(s) only
      "width": 154,                  // optional px — pin it to the size the image actually ships at
      "note": "string"               // optional markdown under the image
    }],
    "ask": "string",                 // optional widget prompt, default "Which one ships?"
    "askHelp": "string",             // optional
    "options": ["string"],           // optional — defaults to the labels plus "none of these"
    "vote": false                    // optional — omit the widget for a look-only group
  }]
}
```

## Rendering rules

- Each group is a section: heading, badges, context, then an `sd-grid` of `sd-card`s — one card per candidate, label as the card title, image, optional note — then one vote widget for the whole group.
- **Pin `width` to the size the design actually ships at.** A concept judged at full bleed and shipped at 154px is a different design; images without a width render bounded at 340px tall, which flatters everything equally.
- `src` must be `http(s):` — anything else is dropped by the publish sanitizer, and a dropped image renders an empty card that reads as a failed generation rather than an authoring bug, so it throws instead.
- Labels are reviewer-facing: they are the card titles *and* the vote options, so name them for what the reader sees (`orbs`, `ribbon`) rather than run ids or filenames.
- Keep options identical across candidates in a group so votes aggregate; override the whole option list with `options` when the choice is not simply "pick one" (`["peek", "stack", "neither — try again"]`).

## Iterating

A design call is rarely one round. Annotations anchor per card, so the reader can say why a specific concept is wrong; the next round replaces the losers and keeps the survivors under the same group id, so their widget history stays attached. When the reader asks for replacements ("drop the bad ones and come up with 3 replacements"), keep the winners in place rather than regenerating the whole grid — a shuffled grid makes their earlier votes unreadable.
