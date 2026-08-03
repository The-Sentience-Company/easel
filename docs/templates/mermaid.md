# Mermaid pre-rendering

A ```` ```mermaid ```` fence in any prose field becomes `<pre class="mermaid">source</pre>` at template-render time. `render/mermaid.js` `preRender()` then replaces each of those with an inline SVG at publish time, via the bundled `mmdc`. No mermaid runtime ships to the browser.

## Two things that will bite you

**The source must be entity-decoded before it reaches mmdc.** Template output is HTML-escaped, so a label written as `A[a<br/>b]` arrives as `&lt;br/&gt;`. mmdc renders a literal `<br/>` as a line break but prints the escaped form as visible garbage inside the node. `decodeEntities()` is the single most load-bearing function in this file — if diagrams start showing raw entity text, that is what broke.

**Every diagram gets its own timeout** (`options.timeoutMs`, default 20s). The headless render can hang rather than exit, and `execFile`'s timeout kills the process instead of waiting on it. Without the cap one bad diagram stalls a publish indefinitely.

`<br/>` in a label is honoured everywhere: mmdc renders it as a line break, and the excalidraw sketch and whiteboard paths normalize it to a real newline in the parsed label text (excalidraw has no label markup). The normalization lives in `PAGE_JOB` and is mirrored in `chrome/whiteboard-frame.js`.

## Failure behavior

`preRender()` never throws and never emits an error-bomb SVG. A diagram that fails to render degrades to a small `sd-diagram-error` block carrying the reason and the original source, and the surrounding document still publishes.

This is deliberately not symmetric with the templates, which *do* throw `TemplateError` on bad input. The reasoning: bad template data is an authoring error worth stopping for, while a diagram that will not render is worth shipping the document without.

## Info strings

The fence's first token is the language, and anything after it is ignored — so ```` ```mermaid theme=dark ```` still routes to `pre.mermaid`. A fence whose first token is not a plausible language name (```` ``` {1,3} ````) is treated as having no language rather than inventing a bogus `language-` class.
