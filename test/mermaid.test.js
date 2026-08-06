import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { preRender, decodeEntities, scopeSvgId } from '../render/mermaid.js'

const VALID = 'flowchart LR\n  A[start] --> B[end]'
const BR_LABEL = 'flowchart LR\n  A[vegetarian&lt;br/&gt;tagged] --> B[ok]'
const INVALID = 'flowchart LR\n  A[unclosed --> B{{{\n  ???'

const block = (src) => `<pre class="mermaid">${src}</pre>`

describe('decodeEntities', () => {
  test('decodes the named entities that appear in escaped diagram source', () => {
    assert.equal(decodeEntities('a&lt;br/&gt;b'), 'a<br/>b')
    assert.equal(decodeEntities('&amp;&quot;&apos;'), '&"\'')
  })

  test('decodes numeric and hex references', () => {
    assert.equal(decodeEntities('&#60;br/&#62;'), '<br/>')
    assert.equal(decodeEntities('&#x3C;br/&#x3E;'), '<br/>')
  })

  test('drops out-of-range code points instead of throwing', () => {
    assert.equal(decodeEntities('&#1114112;'), '')
  })
})

describe('preRender', () => {
  test('leaves html without a mermaid block untouched', async () => {
    const html = '<p>no diagrams here</p>'
    assert.equal(await preRender(html), html)
  })

  test('replaces a valid diagram with an inline svg', async () => {
    const out = await preRender(block(VALID))
    assert.match(out, /class="sd-diagram[^"]*"/)
    assert.match(out, /<svg/)
    assert.doesNotMatch(out, /<pre class="mermaid">/)
  })

  test('decodes escaped br so the label line-breaks instead of showing markup', async () => {
    const out = await preRender(block(BR_LABEL))
    assert.match(out, /<svg/)
    // Undecoded source renders the label as the literal text "vegetarian&lt;br/&gt;tagged".
    assert.doesNotMatch(out, /&lt;br\s*\/?&gt;/, 'escaped br leaked into the rendered label')
    // Each line is its own <text> on the sketch path, so both words must survive.
    assert.match(out, /vegetarian/, 'first label line lost')
    assert.match(out, /tagged/, 'second label line lost')
    // Mermaid's pair line-breaks via a real <br> in foreignObject — fine there.
    const sketch = out.slice(out.indexOf('sd-svg-sketch-light'))
    assert.doesNotMatch(sketch, /<br\s*\/?>[^<]*tagged/, 'br reached the sketch label as markup text')
  })

  test('a br label stays on the whiteboardable path — normalized to a newline, not markup text', async () => {
    const out = await preRender(block(BR_LABEL))
    assert.ok(out.includes('sd-diagram-dual'), 'br label fell off the whiteboardable dual path')
  })

  test('a subgraph diagram falls back to themed-only — no sketch pair, no scene', async () => {
    const out = await preRender(block('flowchart TD\n  subgraph G\n    A --&gt; B\n  end'))
    assert.match(out, /class="sd-diagram sd-diagram-themed"/)
    assert.ok(!out.includes('sd-svg-sketch'), 'unsupported subgraph still baked a sketch pair')
  })

  test('an invalid diagram degrades to a small error block and never throws', async () => {
    const out = await preRender(block(INVALID))
    assert.match(out, /class="sd-diagram-error"/)
    assert.match(out, /Diagram did not render/)
    assert.doesNotMatch(out, /<svg/, 'must not emit an error-bomb svg')
  })

  test('an empty diagram block degrades rather than rendering', async () => {
    const out = await preRender(block('   '))
    assert.match(out, /class="sd-diagram-error"/)
    assert.match(out, /empty diagram source/)
  })

  test('renders every block in a document with several diagrams', async () => {
    const out = await preRender(`<p>a</p>${block(VALID)}<p>b</p>${block(INVALID)}<p>c</p>`)
    assert.match(out, /class="sd-diagram[^"]*"[^>]*>(<span[^>]*>)?<svg/)
    assert.match(out, /class="sd-diagram-error"/)
    assert.match(out, /<p>a<\/p>/)
    assert.match(out, /<p>b<\/p>/)
    assert.match(out, /<p>c<\/p>/)
  })

  test('a timeout degrades to an error block rather than hanging', async () => {
    const out = await preRender(block(VALID), { timeoutMs: 1 })
    assert.match(out, /class="sd-diagram-error"/)
  })

  test('every url(#…) reference in a baked sequence diagram resolves to an id', async () => {
    const seq = 'sequenceDiagram\n  A->>B: hello\n  B--xA: bye'
    const out = await preRender(block(seq), { excalidraw: false })
    assert.match(out, /<svg/, 'sequence diagram must render')
    const ids = new Set([...out.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
    // mermaid's own dark theme ships a dangling gradient ref; markers are ours.
    const refs = [...out.matchAll(/marker-[a-z]+="url\(#([^)]+)\)"/g)].map((m) => m[1])
    assert.ok(refs.length > 0, 'a sequence diagram must carry marker refs')
    for (const ref of refs) assert.ok(ids.has(ref), `dangling marker url(#${ref})`)
  })
})

describe('scopeSvgId', () => {
  const SVG =
    '<svg id="my-svg"><style>#my-svg .m{stroke:red}</style>' +
    '<marker id="my-svg-arrowhead"></marker>' +
    '<line class="m" marker-end="url(#my-svg-arrowhead)"/></svg>'

  test('renames prefixed ids and their references together', () => {
    const out = scopeSvgId(SVG, '0l')
    assert.match(out, /<svg id="my-svg-0l">/)
    assert.match(out, /#my-svg-0l \.m/)
    assert.match(out, /<marker id="my-svg-0l-arrowhead">/)
    assert.match(out, /url\(#my-svg-0l-arrowhead\)/)
  })

  test('an svg without an id passes through untouched', () => {
    const bare = '<svg><line/></svg>'
    assert.equal(scopeSvgId(bare, '1'), bare)
  })
})
