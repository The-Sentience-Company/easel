/* Excalidraw-look conversion at publish: sketch when supported, plain mermaid
   when not, and measured AA text contrast in both themes. */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'
import { preRender } from '../render/mermaid.js'
import { scopeFontFamily } from '../render/excalidraw.js'
import { annotateAndDiff } from '../daemon/differ.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const AA = 4.5
const SLOW = { timeout: 120000 }

const FLOW = 'flowchart TD\n  A[Start here] --> B{Works?}\n  B -->|yes| C[Ship it]\n  B -->|no| D[Fix it]'
const SEQ = 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi back'
const GANTT = 'gantt\n  title Timeline\n  section S\n  task1 :a1, 2026-01-01, 30d'
const PIE = 'pie title Review outcomes\n  "Merged" : 45\n  "Open" : 25'

const wrap = (src) => `<pre class="mermaid">${src.replace(/>/g, '&gt;')}</pre>`

const CONTRAST = `(rgbA, rgbB) => {
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const a = lum(rgbA), b = lum(rgbB)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}`

let browser
let flowHtml
before(async () => {
  browser = await puppeteer.launch({ headless: 'new' })
  flowHtml = await preRender(wrap(FLOW))
}, { timeout: 180000 })
after(async () => { await browser?.close() })

/** Measures real painted pixels (excalidraw dark is an SVG-root invert filter),
    pinning the sketch look — only .sd-diagram-dual reacts to that attribute. */
async function measureTheme(theme, html, selector = '.sd-diagram-dual') {
  const css = await readFile(join(HERE, '..', 'chrome', 'easel.css'), 'utf8')
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 700 })
  await page.setContent(
    `<!doctype html><html data-theme="${theme}" data-diagram-look="sketch"><head><style>${css}</style></head>` +
    `<body class="sf-shell"><main id="sf-content">${html}</main></body></html>`,
    { waitUntil: 'networkidle0' },
  )
  const info = await page.evaluate(`(() => {
    const box = document.querySelector('#sf-content ' + ${JSON.stringify(selector)})
    const shown = [...box.children].find((c) => getComputedStyle(c).display !== 'none')
    if (!shown) return { error: 'no visible theme variant' }
    const svg = shown.querySelector('svg')
    const texts = [...svg.querySelectorAll('text')].filter((t) => t.textContent.trim())
    if (!texts.length) return { error: 'no <text> in the sketch svg' }
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
    return {
      visibleVariant: shown.className,
      labels: texts.map((t) => t.textContent.trim()),
      textBoxes: texts.map(r).filter((b) => b.w > 1 && b.h > 1),
      diagramBox: r(box),
    }
  })()`)
  if (info.error) { await page.close(); assert.fail(info.error) }

  const shot = await page.screenshot({ encoding: 'base64' })
  const measured = await page.evaluate(`(async () => {
    const contrast = ${CONTRAST}
    const info = ${JSON.stringify(info)}
    const dpr = window.devicePixelRatio || 1
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + ${JSON.stringify(shot)} })
    const cv = document.createElement('canvas')
    cv.width = img.width; cv.height = img.height
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const at = (x, y) => {
      const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data
      return [d[0], d[1], d[2]]
    }
    const dist = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])
    // Commonest colour in the label box is what the glyph sits on; the glyph is
    // the furthest colour from it still holding a real share of pixels.
    const perLabel = info.textBoxes.map((b) => {
      const counts = new Map()
      for (let y = b.y; y < b.y + b.h; y += 0.5) {
        for (let x = b.x; x < b.x + b.w; x += 0.5) {
          const p = at(x, y)
          const key = (p[0] >> 3) + ',' + (p[1] >> 3) + ',' + (p[2] >> 3)
          const e = counts.get(key) || { p, n: 0 }
          e.n++
          counts.set(key, e)
        }
      }
      const all = [...counts.values()].sort((m, n) => n.n - m.n)
      const total = all.reduce((s, e) => s + e.n, 0)
      const backing = all[0].p
      // Small text covers only a few percent of its box, so the floor is a pixel
      // count; antialiased edges sit between backing and glyph, never past it.
      const solid = all.filter((e) => e.n >= 6 && e.n / total >= 0.005)
      const glyph = solid.reduce((bestE, e) => dist(e.p, backing) > dist(bestE.p, backing) ? e : bestE, all[0]).p
      return { glyph, backing, ratio: contrast(glyph, backing), spread: dist(glyph, backing) }
    })
    return {
      background: perLabel[0].backing,
      glyphs: perLabel.map((p) => p.glyph),
      backings: perLabel.map((p) => p.backing),
      worst: Math.min(...perLabel.map((p) => p.ratio)),
      maxSpread: Math.max(...perLabel.map((p) => p.spread)),
    }
  })()`)
  await page.close()
  return { ...info, ...measured }
}

describe('excalidraw conversion at publish', () => {
  test('a convertible flowchart bakes both looks with theme variants each, keeping its scene index', SLOW, () => {
    assert.match(flowHtml, /class="sd-diagram sd-diagram-dual" data-diagram-index="0"/)
    assert.match(flowHtml, /class="sd-svg-light"/)
    assert.match(flowHtml, /class="sd-svg-dark"/)
    assert.match(flowHtml, /class="sd-svg-sketch-light"/)
    assert.match(flowHtml, /class="sd-svg-sketch-dark"/)
    assert.match(flowHtml, /svg-source:excalidraw/)
  })

  test('a sequence diagram also converts', SLOW, async () => {
    const out = await preRender(wrap(SEQ))
    assert.match(out, /sd-diagram-dual/)
  })

  test('an unsupported diagram type falls back to plain mermaid, losing nothing', SLOW, async () => {
    const out = await preRender(wrap(GANTT))
    assert.ok(!out.includes('sd-diagram-sketch'), 'gantt took the sketch path')
    assert.ok(!out.includes('sd-diagram-error'), 'gantt lost its diagram entirely')
    assert.match(out, /class="sd-diagram sd-diagram-themed"/)
    assert.match(out, /Timeline/)
  })

  for (const theme of ['light', 'dark']) {
    test(`${theme} theme: fallback diagram labels reach WCAG AA`, SLOW, async () => {
      const out = await preRender(wrap(PIE))
      assert.match(out, /class="sd-svg-light"/)
      assert.match(out, /class="sd-svg-dark"/)
      const m = await measureTheme(theme, out, '.sd-diagram-themed')
      assert.ok(
        m.worst >= AA,
        `${theme} fallback: worst ${m.worst.toFixed(2)}:1 (need ${AA}) — ` +
        `glyphs ${JSON.stringify(m.glyphs)} on backings ${JSON.stringify(m.backings)}`,
      )
    })
  }

  test('each baked variant carries its own svg id, so one style block cannot repaint the other', SLOW, async () => {
    const out = await preRender(wrap(PIE))
    const ids = [...out.matchAll(/<svg[^>]*\sid="([^"]+)"/g)].map((m) => m[1])
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1], 'both variants share an svg id — the later <style> wins')
    for (const id of ids) assert.ok(out.includes(`#${id}`), `style rules were not rescoped to ${id}`)
  })

  test('two diagrams on one page do not share an svg id', SLOW, async () => {
    const out = await preRender(wrap(PIE) + wrap(GANTT))
    const ids = [...out.matchAll(/<svg[^>]*\sid="([^"]+)"/g)].map((m) => m[1])
    assert.equal(new Set(ids).size, ids.length, `duplicate svg ids across diagrams: ${ids}`)
  })

  test('an explicit theme keeps the single-variant contract', SLOW, async () => {
    const out = await preRender(wrap(GANTT), { theme: 'dark' })
    assert.match(out, /<div class="sd-diagram" data-diagram-index="0" data-diagram-hash="[0-9a-f]{12}"><svg/)
    assert.ok(!out.includes('sd-svg-light'))
  })

  test('an explicit theme wins over the sketch path for a convertible diagram', SLOW, async () => {
    const out = await preRender(wrap(FLOW), { theme: 'dark' })
    assert.ok(!out.includes('sd-diagram-dual'), 'explicit theme was ignored for a supported diagram')
    assert.ok(!out.includes('sd-svg-dark'), 'explicit theme still produced both variants')
    assert.match(out, /<div class="sd-diagram" data-diagram-index="0" data-diagram-hash="[0-9a-f]{12}"><svg/)
  })

  test('a converter that fails after launch closes its browser', SLOW, async () => {
    const { createConverter } = await import('../render/excalidraw.js')
    const puppeteer = (await import('puppeteer')).default
    const realLaunch = puppeteer.launch.bind(puppeteer)
    let closed = false
    puppeteer.launch = async (...args) => {
      const browser = await realLaunch(...args)
      const realClose = browser.close.bind(browser)
      browser.close = async () => { closed = true; return realClose() }
      browser.newPage = async () => { throw new Error('newPage failed') }
      return browser
    }
    try {
      await assert.rejects(createConverter({}), /newPage failed/)
      assert.ok(closed, 'chromium was left running after a partial init failure')
    } finally {
      puppeteer.launch = realLaunch
    }
  })

  test('a <br/> label converts to the sketch with a real line break', SLOW, async () => {
    const out = await preRender(wrap('flowchart TD\n  A[one<br/>two] --> B{Works?}\n  B -- "left<br/>right" --> C[done]'))
    assert.match(out, /sd-diagram-dual/, 'br labels fell off the whiteboardable dual path')
    assert.ok(!/&lt;\s*br/i.test(out), 'literal <br/> text leaked into the sketch svg')
    // Each line paints as its own <text>, so both words surviving means the
    // break was honoured rather than the label truncated at the <br/>.
    const m = await measureTheme('light', out)
    for (const word of ['one', 'two', 'left', 'right']) {
      assert.ok(m.labels.includes(word), `"${word}" missing from the sketch: ${JSON.stringify(m.labels)}`)
    }
  })

  test('unparseable source still degrades to the error block, never throws', SLOW, async () => {
    const out = await preRender(wrap('flowchart TD\n  A[ --> ]]]]] broken'))
    assert.match(out, /sd-diagram-error/)
  })

  test('conversion disabled renders the plain mermaid path', SLOW, async () => {
    const out = await preRender(wrap(FLOW), { excalidraw: false })
    assert.ok(!out.includes('sd-diagram-dual'))
    assert.match(out, /class="sd-diagram sd-diagram-themed"/)
    assert.match(out, /<svg/)
  })

  for (const theme of ['light', 'dark']) {
    test(`${theme} theme: diagram text reaches WCAG AA against the surface it sits on`, SLOW, async () => {
      const m = await measureTheme(theme, flowHtml)
      assert.ok(m.labels.length > 0, 'no label text rendered — an empty-looking diagram would pass a did-it-render check')
      assert.ok(m.labels.some((l) => /Start here|Ship it/.test(l)), `labels lost: ${JSON.stringify(m.labels)}`)
      assert.ok(
        m.maxSpread > 30,
        `${theme}: no label pixel differs from the background — the diagram renders empty ` +
        `(bg ${JSON.stringify(m.background)}, variant ${m.visibleVariant})`,
      )
      assert.ok(
        m.worst >= AA,
        `${theme}: worst ${m.worst.toFixed(2)}:1 (need ${AA}). ` +
        `glyphs ${JSON.stringify(m.glyphs)} on bg ${JSON.stringify(m.background)}, variant ${m.visibleVariant}.`,
      )
    })
  }

  test('each theme shows its own sketch variant and only one at a time', SLOW, async () => {
    const light = await measureTheme('light', flowHtml)
    const dark = await measureTheme('dark', flowHtml)
    assert.match(light.visibleVariant, /sd-svg-sketch-light/)
    assert.match(dark.visibleVariant, /sd-svg-sketch-dark/)
    assert.notDeepEqual(dark.glyphs, light.glyphs, 'both themes painted identical glyphs — dark variant is not baked')
  })

  test('the default look shows the mermaid pair; the sketch look swaps it out', SLOW, async () => {
    const css = await readFile(join(HERE, '..', 'chrome', 'easel.css'), 'utf8')
    const page = await browser.newPage()
    const visible = () => page.evaluate(`(() => {
      const spans = [...document.querySelectorAll('.sd-diagram-dual > span')]
      return spans.filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.className)
    })()`)
    await page.setContent(
      `<!doctype html><html data-theme="light"><head><style>${css}</style></head>` +
      `<body class="sf-shell"><main id="sf-content">${flowHtml}</main></body></html>`,
      { waitUntil: 'domcontentloaded' },
    )
    assert.deepEqual(await visible(), ['sd-svg-light'], 'default look must show exactly the mermaid light variant')
    await page.evaluate(`document.documentElement.dataset.diagramLook = 'sketch'`)
    assert.deepEqual(await visible(), ['sd-svg-sketch-light'], 'sketch look must show exactly the sketch light variant')
    await page.close()
  })

  test('the embedded font subset survives the publish sanitizer', SLOW, () => {
    assert.match(flowHtml, /url\(data:font\/woff2;base64,/)
    const clean = annotateAndDiff(flowHtml).html
    assert.match(clean, /url\(data:font\/woff2;base64,/)
  })

  test('the sanitizer still scrubs every other CSS url() from a sketch diagram', SLOW, () => {
    const hostile =
      '<div class="sd-diagram-sketch"><svg xmlns="http://www.w3.org/2000/svg"><style>' +
      '@font-face { src: url(data:font/woff2;base64,AAAA) }' +
      '.a { background: url(/api/steal) } .b { background: url(https://evil.test/x) }' +
      '@import url(//evil.test);</style></svg></div>'
    const clean = annotateAndDiff(hostile).html
    assert.match(clean, /url\(data:font\/woff2;base64,AAAA\)/)
    assert.ok(!clean.includes('/api/steal'), 'same-origin fetch url survived')
    assert.ok(!clean.includes('evil.test'), 'external url survived')
    assert.ok(!/@import/i.test(clean), '@import survived')
  })

  test('a data: URI that only looks like a font is still scrubbed', SLOW, () => {
    const hostile =
      '<div class="sd-diagram"><svg xmlns="http://www.w3.org/2000/svg"><style>' +
      '.a { background: url(data:font/woff2;base64,AAA/../../etc) }' +
      '.b { background: url(data:text/html;base64,PHNjcmlwdD4=) }</style></svg></div>'
    const clean = annotateAndDiff(hostile).html
    assert.ok(!clean.includes('data:text/html'), 'a non-font data URI survived')
  })

  test('font families are scoped per diagram so subsets cannot shadow each other', () => {
    const a = scopeFontFamily('font-family: Excalifont; src: url(x)', 'diagram A')
    const b = scopeFontFamily('font-family: Excalifont; src: url(x)', 'diagram B')
    assert.match(a, /Excalifont-[0-9a-f]{8}/)
    assert.notEqual(a, b)
  })
})
