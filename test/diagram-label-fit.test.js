/* A converted label must fit the box drawn around it: measuring against a system
   fallback reserves ~20% less than the export paints, which is what clips text. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createConverter } from '../render/excalidraw.js'

const SLOW = { timeout: 180000 }

// Long enough that a mis-measured label overflows rather than merely looking odd.
const SOURCE = `graph LR
  A[client.js Escape handler] --> B[no nothing, annotate survives]
  B --> C[parent posts fullscreenChanged to frame]`

let converter
let browser

before(async () => {
  converter = await createConverter({ timeoutMs: 60000 })
  browser = await (await import('puppeteer')).default.launch({ headless: 'shell', args: ['--no-sandbox'] })
}, SLOW)

after(async () => {
  await browser?.close()
  await converter?.close()
})

/** Every <text> in the exported SVG, measured against the box it belongs to. */
async function labelOverflows(svg) {
  const page = await browser.newPage()
  try {
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`)
    await page.evaluate(() => document.fonts.ready)
    await new Promise((r) => setTimeout(r, 500))
    return page.evaluate(() => {
      // Excalidraw draws boxes as hand-drawn paths, never rects.
      const rects = [...document.querySelectorAll('svg path')].map((r) => r.getBBox())
      return [...document.querySelectorAll('svg text')]
        .map((t) => {
          const b = t.getBBox()
          // The box this label sits in: the smallest rect that contains its centre.
          const cx = b.x + b.width / 2
          const cy = b.y + b.height / 2
          const box = rects
            .filter((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height)
            .sort((p, q) => p.width * p.height - q.width * q.height)[0]
          if (!box) return null
          return { text: t.textContent, overflow: Math.round(b.width - box.width) }
        })
        .filter((row) => row && row.overflow > 0)
    })
  } finally {
    await page.close()
  }
}

test('no converted label paints wider than its own box', SLOW, async () => {
  const out = await converter.convert(SOURCE)
  assert.equal(out.ok, true, `conversion must succeed: ${out.message || ''}`)

  const spills = await labelOverflows(out.light)
  assert.deepEqual(spills, [], `labels must fit their boxes, but these spilled: ${JSON.stringify(spills)}`)
})

// Measured truthfully, a label too wide for its box wraps; measured against a
// fallback it stays on one over-wide line and spills out.
test('a label too wide for its box wraps instead of overflowing', SLOW, async () => {
  const out = await converter.convert(SOURCE)
  assert.equal(out.ok, true, `conversion must succeed: ${out.message || ''}`)

  const texts = [...out.light.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, '').trim()
  )
  assert.ok(
    !texts.includes('no nothing, annotate survives'),
    `the long label must wrap, but rendered on one line: ${JSON.stringify(texts)}`
  )
  assert.ok(texts.includes('no nothing, annotate'), `expected a wrapped first line, got ${JSON.stringify(texts)}`)
})

// mmdc sizes each node box around a label laid out at mermaid's metrics. The page
// it lands in has its own line-height, and an SVG clips what leaves its viewBox.
test('a mermaid label still fits its box inside the board page', SLOW, async () => {
  const { preRender } = await import('../render/mermaid.js')
  const { annotateAndDiff } = await import('../daemon/differ.js')
  const { readFile } = await import('node:fs/promises')
  const source = `graph LR
  A["Executor needs your call<br/>(decision / review / merge OK)"] --> B["Round report to the orchestrator<br/>over the bridge — already<br/>happens today, nothing new"]`
  const rendered = await preRender(`<pre class="mermaid">${source.replaceAll('<', '&lt;')}</pre>`, { excalidraw: false })
  // Through the publish path, not the raw render: the sanitizer is what used to
  // drop the label's own metrics and leave the page's line-height to reflow it.
  const { html: published } = annotateAndDiff(rendered)
  const css = await readFile(new URL('../chrome/easel.css', import.meta.url), 'utf8')

  const page = await browser.newPage()
  try {
    await page.setContent(
      `<!doctype html><html data-theme="lantern"><head><style>${css}</style></head>` +
        `<body class="sf-shell"><main id="sf-content">${published}</main></body></html>`
    )
    await page.evaluate(() => document.fonts.ready)
    const spills = await page.evaluate(() => {
      const out = []
      for (const svg of document.querySelectorAll('.sd-diagram .sd-svg-light svg')) {
        const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width || 1
        for (const fo of svg.querySelectorAll('foreignObject')) {
          const div = fo.firstElementChild
          if (!div) continue
          const top = div.getBoundingClientRect().top
          const bottom = Math.max(...[...div.querySelectorAll('*')].map((k) => k.getBoundingClientRect().bottom))
          const over = Math.round((bottom - top) / scale - fo.height.baseVal.value)
          if (over > 1) out.push({ text: div.textContent.trim().slice(0, 30), over })
        }
      }
      return out
    })
    assert.deepEqual(spills, [], `labels must fit the boxes mmdc drew, but these spilled: ${JSON.stringify(spills)}`)
  } finally {
    await page.close()
  }
})
