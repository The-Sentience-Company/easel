# Mermaid pre-rendering

A ```` ```mermaid ```` fence in any prose field becomes `<pre class="mermaid">source</pre>` at template-render time. `render/mermaid.js` `preRender()` then replaces each of those with an inline SVG at publish time, via the bundled `mmdc`. No mermaid runtime ships to the browser.

## Two things that will bite you

**The source must be entity-decoded before it reaches mmdc.** Template output is HTML-escaped, so a label written as `A[a<br/>b]` arrives as `&lt;br/&gt;`. mmdc renders a literal `<br/>` as a line break but prints the escaped form as visible garbage inside the node. `decodeEntities()` is the single most load-bearing function in this file — if diagrams start showing raw entity text, that is what broke.

**Every diagram gets its own timeout** (`options.timeoutMs`, default 20s). The headless render can hang rather than exit, and `execFile`'s timeout kills the process instead of waiting on it. Without the cap one bad diagram stalls a publish indefinitely.

`<br/>` in a label is honoured everywhere: mmdc renders it as a line break, and the excalidraw sketch and whiteboard paths normalize it to a real newline in the parsed label text (excalidraw has no label markup). That normalization lives in `render/diagram-palette.js`, which both paths call.

## Authoring: colour is meaning

An unstyled diagram renders every node the same colour (stock lavender; uniform blue boxes with yellow diamonds in the sketch look). That is the truthful rendering when every node is the same kind of thing — but most diagrams have 2–4 *kinds*: the pipeline vs the external system it calls, the happy path vs the failure path, what changes vs what stays. When kinds differ, paint them with `classDef`, one class per meaning:

```
classDef step fill:#a5d8ff,stroke:#1971c2,color:#1a1a1a
classDef decision fill:#ffec99,stroke:#f08c00,color:#1a1a1a
classDef good fill:#b2f2bb,stroke:#2f9e44,color:#1a1a1a
classDef bad fill:#ffc9c9,stroke:#e03131,color:#1a1a1a
classDef ext fill:#d0bfff,stroke:#7048e8,color:#1a1a1a
classDef dim fill:#dee2e6,stroke:#868e96,color:#1a1a1a
classDef warn fill:#ffc078,stroke:#e8590c,color:#1a1a1a
classDef store fill:#66d9e8,stroke:#0c8599,color:#1a1a1a
```

Roles: `step` ordinary work, `decision` branch points, `good` success / the new state, `bad` failure / error path, `ext` external systems outside our control, `dim` context that exists but isn't the point, `warn` degraded / known gap / the smell the diagram exists to point at, `store` data stores and caches (pairs naturally with `[(...)]` cylinder nodes). Attach with `class A,B step` lines or `A:::step`. Works in `flowchart` and `stateDiagram-v2`; other diagram types have no classDef.

- **Once you style anything, class every node.** One `classDef` turns the default palette off for the whole diagram (see below), so a half-painted diagram leaves the rest white — and "unpainted" reads as a third meaning you never wrote.
- **Same meaning, same colour, on every diagram of the board.** A reader who learned red = failure path on diagram one carries that into diagram three.
- **Stay inside this palette.** Every diagram is baked twice, light and dark, with declared fills kept verbatim in both — these light fills with dark text survive both backgrounds; an invented hex usually dies in one of them.
- Two or three kinds is plenty. Colour that doesn't encode a distinction is decoration, and a diagram of genuinely uniform nodes is better left unstyled.

## Sketch and whiteboard colour

The mermaid→excalidraw converter carries only colour the source declared, so an unstyled diagram would convert to white boxes. `normalizeSkeleton()` fills nodes in (decisions apart from the rest) for the sketch look and the whiteboard alike. **One `classDef` or `style` line turns the default palette off for the whole diagram** — a source that paints two nodes keeps every other node neutral, because half-painting would make "neutral" read as a third meaning the author never wrote.

## Failure behavior

`preRender()` never throws and never emits an error-bomb SVG. A diagram that fails to render degrades to a small `sd-diagram-error` block carrying the reason and the original source, and the surrounding document still publishes.

This is deliberately not symmetric with the templates, which *do* throw `TemplateError` on bad input. The reasoning: bad template data is an authoring error worth stopping for, while a diagram that will not render is worth shipping the document without.

## Info strings

The fence's first token is the language, and anything after it is ignored — so ```` ```mermaid theme=dark ```` still routes to `pre.mermaid`. A fence whose first token is not a plausible language name (```` ``` {1,3} ````) is treated as having no language rather than inventing a bogus `language-` class.
