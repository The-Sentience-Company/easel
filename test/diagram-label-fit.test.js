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
