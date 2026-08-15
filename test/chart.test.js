/* Unit guards for render/chart.js — which <pre> blocks the transform claims,
   what a malformed chart degrades to, and the geometry the marks are drawn at. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preRender, fmtNum } from '../render/chart.js'
import { markdown, esc } from '../templates/_html.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(HERE, '..', 'chrome', 'easel.css'), 'utf8')

const fence = (obj) => markdown('```chart\n' + (typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n```')
const render = (obj) => preRender(fence(obj))

const paths = (html, cls) => [...html.matchAll(/<path class="sd-chart-(?:bar|line) sd-chart-s(\d)"[^>]*\bd="([^"]*)"/g)]
  .filter((m) => (cls === undefined ? true : m[1] === String(cls)))
  .map((m) => m[2])

/* Walks the subset of path commands the renderer emits (M/V/H/Q/Z) so a bar's
   drawn extent is measured, not inferred from the string. */
function bbox(d) {
  const tok = d.match(/[MVHQZ]|-?\d+(?:\.\d+)?/g) ?? []
  let x = 0
  let y = 0
  const xs = []
  const ys = []
  const put = () => { xs.push(x); ys.push(y) }
  for (let i = 0; i < tok.length;) {
    const cmd = tok[i++]
    if (cmd === 'M') { x = +tok[i++]; y = +tok[i++]; put() }
    else if (cmd === 'V') { y = +tok[i++]; put() }
    else if (cmd === 'H') { x = +tok[i++]; put() }
    else if (cmd === 'Q') { i += 2; x = +tok[i++]; y = +tok[i++]; put() }
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
}

const axisY = (html) => +html.match(/<line class="sd-chart-axis" x1="[\d.]+" y1="([\d.]+)"/)[1]
const axisX = (html) => +html.match(/<line class="sd-chart-axis" x1="([\d.]+)"/)[1]
const tickTexts = (html) => [...html.matchAll(/<text class="sd-chart-tick"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
const labelTexts = (html) => [...html.matchAll(/<text class="sd-chart-label"[^>]*>([^<]*)/g)].map((m) => m[1])
const titles = (html) => [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1])

const bars = (n, values) => ({ type: n, x: values.map((_, i) => `c${i}`), series: [{ values }] })

describe('the chart fence reaches the renderer and nothing else does', () => {
  test('a ```chart fence becomes pre.sd-chart with escaped source', () => {
    const html = markdown('```chart\n{"type":"bar","x":["<a>"]}\n```')
    assert.match(html, /^<pre class="sd-chart">/)
    assert.match(html, /&lt;a&gt;/)
    assert.doesNotMatch(html, /<a>/)
  })

  test('json and bare fences still take the plain code path', () => {
    assert.match(markdown('```json\n{}\n```'), /<pre><code class="language-json">/)
    assert.match(markdown('```\nplain\n```'), /<pre><code>plain<\/code><\/pre>/)
  })

  test('a pre whose content merely mentions the class is untouched', () => {
    // hasClass walks attributes in order for exactly this case.
    const html = '<pre><code>class="sd-chart"</code></pre>'
    assert.equal(preRender(html), html)
  })

  test('markup around the fence survives the replacement', () => {
    const html = preRender('<p>before</p>' + fence(bars('bar', [1, 2])) + '<p>after</p>')
    assert.match(html, /^<p>before<\/p><figure class="sd-chart"/)
    assert.match(html, /<\/figure><p>after<\/p>$/)
  })
})

describe('a chart that cannot be drawn degrades to an error block', () => {
  const errored = (source) => preRender(`<pre class="sd-chart">${esc(source)}</pre>`)

  test('bad JSON keeps the source, escaped, inside the error block', () => {
    const html = errored('{not json <b>}')
    assert.match(html, /class="sd-diagram-error"/)
    assert.match(html, /Chart did not render/)
    assert.match(html, /&lt;b&gt;/)
    assert.doesNotMatch(html, /<b>/)
  })

  for (const [name, data] of [
    ['an unknown type', { type: 'pie', x: ['a'], series: [{ values: [1] }] }],
    ['a values/x length mismatch', { type: 'bar', x: ['a', 'b'], series: [{ values: [1] }] }],
    ['six series', { type: 'bar', x: ['a'], series: Array.from({ length: 6 }, (_, i) => ({ label: `s${i}`, values: [1] })) }],
    ['121 categories', { type: 'bar', x: Array.from({ length: 121 }, (_, i) => `c${i}`), series: [{ values: Array(121).fill(1) }] }],
    ['41 hbar categories', { type: 'hbar', x: Array.from({ length: 41 }, (_, i) => `c${i}`), series: [{ values: Array(41).fill(1) }] }],
    ['a non-numeric value', { type: 'bar', x: ['a'], series: [{ values: ['12'] }] }],
    ['an unknown size', { type: 'bar', size: 'xl', x: ['a'], series: [{ values: [1] }] }],
    ['a missing label on a second series', { type: 'bar', x: ['a'], series: [{ values: [1] }, { values: [2] }] }],
  ]) {
    test(`${name} errors rather than throwing`, () => {
      const html = render(data)
      assert.match(html, /class="sd-diagram-error"/, `${name} should have errored`)
      assert.doesNotMatch(html, /<svg/)
    })
  }

  test('120 categories is inside the cap and still renders', () => {
    const html = render({ type: 'bar', x: Array.from({ length: 120 }, (_, i) => `c${i}`), series: [{ values: Array(120).fill(1) }] })
    assert.match(html, /<svg/)
  })
})

describe('text from the author is decoded once and escaped once', () => {
  test('an entity-escaped title parses as its literal text', () => {
    // The source sits escaped inside the <pre>; decodeEntities must run before
    // JSON.parse or the title arrives as the literal string "A&amp;B".
    const html = preRender(`<pre class="sd-chart">${esc('{"type":"bar","title":"A&B","x":["a"],"series":[{"values":[1]}]}')}</pre>`)
    assert.match(html, /<figcaption>A&amp;B<\/figcaption>/)
    assert.doesNotMatch(html, /A&amp;amp;B/)
  })

  test('a hostile category label appears only entity-escaped', () => {
    const html = render({ type: 'bar', x: ['<script>alert(1)</script>'], series: [{ values: [1] }] })
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  })
})

describe('series identity: legend, classes, tooltips', () => {
  test('a single series has no legend and an unprefixed tooltip', () => {
    const html = render({ type: 'bar', x: ['Jan'], series: [{ values: [120] }], unit: '$' })
    assert.doesNotMatch(html, /sd-chart-legend/)
    assert.deepEqual(titles(html), ['Jan: $120'])
  })

  test('two series get a legend, ordered classes, and prefixed tooltips', () => {
    const html = render({ type: 'bar', x: ['Jan'], series: [{ label: 'Chat', values: [1] }, { label: 'Batch', values: [2] }] })
    assert.match(html, /<span class="sd-chart-swatch sd-chart-s0"><\/span>Chat/)
    assert.match(html, /<span class="sd-chart-swatch sd-chart-s1"><\/span>Batch/)
    assert.deepEqual(titles(html), ['Chat · Jan: 1', 'Batch · Jan: 2'])
  })

  test('the figure carries an aria-label and a source hash', () => {
    assert.match(render({ type: 'bar', title: 'Spend', x: ['a'], series: [{ values: [1] }] }), /aria-label="Spend"/)
    assert.match(render(bars('bar', [1])), /aria-label="bar chart"/)
    assert.match(render({ type: 'line', x: ['a'], series: [{ values: [1] }] }), /aria-label="line chart"/)
    assert.match(render(bars('bar', [1])), /data-chart-hash="[0-9a-f]{12}"/)
  })
})

describe('bar geometry', () => {
  test('bar heights hold the value ratio and share one baseline', () => {
    const html = render(bars('bar', [50, 100]))
    const [a, b] = paths(html).map(bbox)
    const base = axisY(html)
    assert.equal(a.y1, base)
    assert.equal(b.y1, base)
    const ratio = (base - a.y0) / (base - b.y0)
    assert.ok(Math.abs(ratio - 0.5) < 0.02, `expected a 1:2 height ratio, got ${ratio}`)
  })

  test('a negative value hangs below the zero line, which is not the plot floor', () => {
    const html = render(bars('bar', [100, -50]))
    const [pos, neg] = paths(html).map(bbox)
    const base = axisY(html)
    const bottom = 12 + 220
    assert.ok(base < bottom, `zero line should sit above the plot floor, got ${base} of ${bottom}`)
    assert.ok(pos.y0 < base, 'the positive bar should rise above zero')
    assert.ok(neg.y1 > base, 'the negative bar should hang below zero')
  })

  test('grouped bars sit side by side inside one category slot', () => {
    const html = render({ type: 'bar', x: ['a', 'b'], series: [{ label: 'one', values: [1, 1] }, { label: 'two', values: [1, 1] }] })
    const s0 = paths(html, 0).map(bbox)
    const s1 = paths(html, 1).map(bbox)
    assert.equal(s0.length, 2)
    assert.ok(s0[0].x1 <= s1[0].x0, 'series 0 should sit left of series 1 in the same slot')
    assert.ok(s1[0].x1 < s0[1].x0, 'the first slot should end before the second begins')
  })

  test('a null value draws no bar and no tooltip', () => {
    const html = render(bars('bar', [1, null, 3]))
    assert.equal(paths(html).length, 2)
    assert.deepEqual(titles(html), ['c0: 1', 'c2: 3'])
  })
})

describe('horizontal bar geometry', () => {
  test('bar widths hold the value ratio and share one baseline', () => {
    const html = render(bars('hbar', [50, 100]))
    const [a, b] = paths(html).map(bbox)
    const base = axisX(html)
    assert.equal(a.x0, base)
    assert.equal(b.x0, base)
    const ratio = (a.x1 - base) / (b.x1 - base)
    assert.ok(Math.abs(ratio - 0.5) < 0.02, `expected a 1:2 width ratio, got ${ratio}`)
  })

  test('a negative value extends left of the zero line', () => {
    const html = render(bars('hbar', [100, -50]))
    const [pos, neg] = paths(html).map(bbox)
    const base = axisX(html)
    assert.ok(pos.x1 > base)
    assert.ok(neg.x0 < base)
  })

  test('every category gets a label — hbar never samples or rotates', () => {
    const x = Array.from({ length: 40 }, (_, i) => `c${i}`)
    const html = render({ type: 'hbar', x, series: [{ values: x.map(() => 1) }] })
    assert.equal(labelTexts(html).length, 40)
    assert.doesNotMatch(html, /class="sd-chart-label"[^>]*rotate/)
  })

  test('a long category is truncated and keeps its full text in a title', () => {
    const long = 'an extremely long category name that will not fit'
    const html = render({ type: 'hbar', x: [long, 'short'], series: [{ values: [1, 2] }] })
    assert.match(html, /…</)
    assert.ok(titles(html).includes(long), 'the full name should survive in a <title>')
    assert.doesNotMatch(labelTexts(html)[0], /not fit/)
  })

  test('height follows the row count, not a fixed plot box', () => {
    const two = render(bars('hbar', [1, 2]))
    const four = render(bars('hbar', [1, 2, 3, 4]))
    const h = (html) => +html.match(/viewBox="0 0 \d+ (\d+)"/)[1]
    assert.equal(h(four) - h(two), 2 * 26)
  })
})

describe('line geometry', () => {
  test('a null splits the path rather than bridging the gap', () => {
    const html = render({ type: 'line', x: ['a', 'b', 'c'], series: [{ values: [1, null, 3] }] })
    const d = paths(html)[0]
    assert.equal((d.match(/M/g) ?? []).length, 2, `expected two segments, got ${d}`)
    assert.equal((html.match(/<circle/g) ?? []).length, 2, 'the null point should carry no dot')
  })

  test('dots disappear once the slot is too narrow to hold them', () => {
    const x = Array.from({ length: 120 }, (_, i) => `c${i}`)
    const html = render({ type: 'line', size: 'sm', x, series: [{ values: x.map((_, i) => i) }] })
    assert.doesNotMatch(html, /<circle/)
  })

  test('line points centre on the slot, as bars do', () => {
    const line = render({ type: 'line', x: ['a', 'b'], series: [{ values: [1, 2] }] })
    const bar = render(bars('bar', [1, 2]))
    const cx = +line.match(/<circle[^>]*cx="([\d.]+)"/)[1]
    const box = bbox(paths(bar)[0])
    assert.ok(Math.abs(cx - (box.x0 + box.x1) / 2) < 1.5, 'the first point should sit over the first bar')
  })
})

describe('scale, ticks and number formatting', () => {
  test('gridlines land on round numbers spanning the data', () => {
    const html = render(bars('bar', [97]))
    assert.deepEqual(tickTexts(html), ['0', '20', '40', '60', '80', '100'])
  })

  test('an all-zero series still gets a usable scale', () => {
    const html = render(bars('bar', [0, null]))
    assert.deepEqual(tickTexts(html), ['0', '0.2', '0.4', '0.6', '0.8', '1'])
  })

  test('magnitudes are abbreviated and thousands are grouped', () => {
    assert.equal(fmtNum(1234), '1,234')
    assert.equal(fmtNum(12345), '12.3k')
    assert.equal(fmtNum(2_500_000), '2.5M')
    assert.equal(fmtNum(0.125), '0.13')
  })

  test('a currency unit prefixes and any other unit suffixes', () => {
    assert.ok(titles(render({ type: 'bar', x: ['a'], series: [{ values: [12] }], unit: '$' }))[0].endsWith('$12'))
    assert.ok(titles(render({ type: 'bar', x: ['a'], series: [{ values: [12] }], unit: 'ms' }))[0].endsWith('12 ms'))
  })

  test('a yLabel is drawn rotated at the left edge', () => {
    assert.match(render({ type: 'bar', x: ['a'], series: [{ values: [1] }], yLabel: 'tokens' }), /transform="rotate\(-90 [^"]*\)">tokens</)
  })
})

describe('x-axis labels thin out before they collide', () => {
  test('dense categories are sampled to the size budget', () => {
    const x = Array.from({ length: 36 }, (_, i) => `c${i}`)
    const html = render({ type: 'bar', x, series: [{ values: x.map(() => 1) }] })
    assert.equal(labelTexts(html).length, 9)
    assert.deepEqual(labelTexts(html).slice(0, 2), ['c0', 'c4'])
  })

  test('labels wider than their slot are rotated', () => {
    const x = ['a considerably long category label', 'another long one', 'a third long one']
    const html = render({ type: 'bar', x, series: [{ values: [1, 2, 3] }] })
    assert.match(html, /class="sd-chart-label"[^>]*text-anchor="end"[^>]*transform="rotate\(-35/)
  })
})

describe('sizes change the box, not the data', () => {
  const widthOf = (html) => +html.match(/<svg viewBox="0 0 (\d+)/)[1]

  test('md is the default and sm/lg step around it', () => {
    assert.equal(widthOf(render(bars('bar', [1, 2]))), 480)
    assert.equal(widthOf(render({ ...bars('bar', [1, 2]), size: 'sm' })), 320)
    assert.equal(widthOf(render({ ...bars('bar', [1, 2]), size: 'lg' })), 640)
  })

  test('the svg carries a width attribute so a small chart renders small', () => {
    assert.match(render({ ...bars('bar', [1, 2]), size: 'sm' }), /<svg viewBox="0 0 320 \d+" width="320"/)
  })

  test('the same data reads the same ticks at every size', () => {
    const at = (size) => tickTexts(render({ ...bars('bar', [97]), size }))
    assert.deepEqual(at('sm'), at('lg'))
    assert.deepEqual(at('md'), at('lg'))
  })
})

describe('the transform is safe to run twice', () => {
  test('a second pass changes nothing', () => {
    const html = fence({ type: 'bar', x: ['a', 'b'], series: [{ values: [1, 2] }] }) + fence('{broken')
    const once = preRender(html)
    assert.equal(preRender(once), once)
  })

  test('each figure keeps its own ordinal, error blocks included', () => {
    const html = preRender(fence('{broken') + fence(bars('bar', [1])))
    assert.deepEqual([...html.matchAll(/data-chart-index="(\d)"/g)].map((m) => m[1]), ['0', '1'])
  })
})

describe('easel.css covers every sd-chart class the renderer emits', () => {
  // design-vocab.test.js scans templates/ only, so render/ needs its own guard.
  const src = readFileSync(join(HERE, '..', 'render', 'chart.js'), 'utf8')
  const emitted = new Set()
  for (const m of src.matchAll(/class="([^"$]*)"/g)) {
    for (const token of m[1].split(/\s+/)) if (token.startsWith('sd-chart')) emitted.add(token)
  }

  test('the scan finds the vocabulary it is meant to guard', () => {
    assert.ok(emitted.size >= 6, `scan found only ${[...emitted].join(', ')}`)
  })

  test('every emitted class has a rule', () => {
    const missing = [...emitted].filter((cls) => !new RegExp(`\\.${cls}\\b`).test(css))
    assert.deepEqual(missing, [], `no rule for: ${missing.join(', ')}`)
  })

  test('all five series slots are painted in both token blocks', () => {
    for (let i = 1; i <= 5; i++) {
      assert.ok(css.split(`--color-chart-${i}:`).length === 3, `--color-chart-${i} needs a light and a dark value`)
    }
    for (let i = 0; i < 5; i++) {
      for (const kind of ['bar', 'line', 'dot', 'swatch']) {
        assert.match(css, new RegExp(`\\.sd-chart-${kind}\\.sd-chart-s${i}\\b`), `no ${kind} rule for s${i}`)
      }
    }
  })
})
