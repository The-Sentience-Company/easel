/* Mermaid node fills are baked into the SVG at publish, but labels are real
   HTML in a foreignObject, so page prose colours can repaint them. */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'
import { preRender } from '../render/mermaid.js'
import { ganttThemeVariables, isGantt } from '../render/mermaid-theme.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/* Every token the gantt palette is allowed to draw from. */
const TOKEN_NAMES = [
  '--color-base-100', '--color-base-200', '--color-base-300', '--color-base-content',
  '--color-body-content', '--color-muted-content', '--color-primary', '--color-primary-content',
  '--color-success', '--color-warning', '--color-error', '--color-info',
  '--color-status-content', '--border', '--border-subtle',
]
const AA = 4.5

/** Resolve any CSS colour — including oklch() — to RGB by painting it.
    Parsing the computed string is what produces bogus passing numbers. */
const RESOLVE = `(value) => {
  const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  c.fillStyle = '#000'; c.fillStyle = value
  c.fillRect(0, 0, 1, 1)
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}`

const CONTRAST = `(rgbA, rgbB) => {
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const a = lum(rgbA), b = lum(rgbB)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}`

let browser
before(async () => { browser = await puppeteer.launch({ headless: 'new' }) }, { timeout: 60000 })
after(async () => { await browser?.close() })

/** Measure label-vs-fill contrast in one theme, the way a reviewer sees it. */
async function measure(theme) {
  const css = await readFile(join(HERE, '..', 'chrome', 'easel.css'), 'utf8')
  let diagram = await readFile(join(HERE, 'samples', 'mermaid-rendered.svg.html'), 'utf8')
  // The daemon stamps data-sid on every content node, labels included — that is
  // part of why page rules reach inside the diagram.
  diagram = diagram.replace(/<p(\s|>)/g, '<p data-sid="s-test"$1')

  const page = await browser.newPage()
  await page.setContent(
    `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head>` +
    `<body class="sf-shell"><main id="sf-content">${diagram}</main></body></html>`,
    { waitUntil: 'domcontentloaded' },
  )

  const result = await page.evaluate(`(() => {
    const resolve = ${RESOLVE}
    const contrast = ${CONTRAST}
    const label = document.querySelector('#sf-content svg foreignObject p')
      || document.querySelector('#sf-content svg foreignObject span')
    if (!label) return { error: 'no foreignObject label in the fixture' }
    const text = getComputedStyle(label).color
    const rect = document.querySelector('#sf-content svg .node rect, #sf-content svg rect')
    if (!rect) return { error: 'no node rect in the fixture' }
    const fill = getComputedStyle(rect).fill
    return {
      textRaw: text, fillRaw: fill,
      text: resolve(text), fill: resolve(fill),
      ratio: contrast(resolve(text), resolve(fill)),
      labelText: label.textContent.trim(),
    }
  })()`)

  await page.close()
  assert.equal(result.error, undefined, result.error)
  assert.ok(result.labelText.length > 0, 'fixture label has no text to measure')
  return result
}

describe('mermaid label contrast against the baked node fill', () => {
  for (const theme of ['light', 'dark']) {
    test(`${theme} theme reaches WCAG AA`, { timeout: 60000 }, async () => {
      const m = await measure(theme)
      assert.ok(
        m.ratio >= AA,
        `${theme}: ${m.ratio.toFixed(2)}:1 (need ${AA}). ` +
        `label ${m.textRaw} -> rgb(${m.text}) on fill ${m.fillRaw} -> rgb(${m.fill}). ` +
        'The page prose colour is reaching the foreignObject label again.',
      )
    })
  }

  /* The rendered fixture only ever produces <p> labels. Mermaid can emit links
     and lists in a label too, so those selectors are exercised synthetically. */
  test('every prose element the reset covers is actually neutralised', { timeout: 60000 }, async () => {
    const css = await readFile(join(HERE, '..', 'chrome', 'easel.css'), 'utf8')
    const page = await browser.newPage()
    await page.setContent(
      `<!doctype html><html data-theme="dark"><head><style>${css}</style></head>` +
      '<body class="sf-shell"><main id="sf-content">' +
      '<div class="sd-diagram"><svg xmlns="http://www.w3.org/2000/svg"><foreignObject>' +
      '<span class="nodeLabel" style="color: rgb(51, 51, 51)">' +
      '<p data-sid="a">para</p><ul><li data-sid="b">item</li></ul><a href="#" data-sid="c">link</a>' +
      '</span></foreignObject></svg></div></main></body></html>',
      { waitUntil: 'domcontentloaded' },
    )
    const colours = await page.evaluate(`(() => {
      const out = {}
      for (const sel of ['p', 'li', 'a']) {
        out[sel] = getComputedStyle(document.querySelector('#sf-content svg foreignObject ' + sel)).color
      }
      return out
    })()`)
    await page.close()
    for (const [sel, colour] of Object.entries(colours)) {
      assert.equal(colour, 'rgb(51, 51, 51)', `<${sel}> inside the diagram kept a page colour: ${colour}`)
    }
  })

  /* `page` accepts arbitrary body-inner HTML, so a hand-authored inline SVG is
     legal and must keep the design system's colours. */
  test('the reset does not reach an inline SVG that is not a diagram', { timeout: 60000 }, async () => {
    const css = await readFile(join(HERE, '..', 'chrome', 'easel.css'), 'utf8')
    const page = await browser.newPage()
    await page.setContent(
      `<!doctype html><html data-theme="dark"><head><style>${css}</style></head>` +
      '<body class="sf-shell"><main id="sf-content">' +
      '<p id="prose">prose</p><a id="proseLink" href="#">prose link</a>' +
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>' +
      '<span style="color: rgb(51, 51, 51)"><p id="own">own</p><a id="ownLink" href="#">own link</a></span>' +
      '</foreignObject></svg></main></body></html>',
      { waitUntil: 'domcontentloaded' },
    )
    const c = await page.evaluate(`(() => {
      const g = (id) => getComputedStyle(document.getElementById(id)).color
      return { prose: g('prose'), proseLink: g('proseLink'), own: g('own'), ownLink: g('ownLink') }
    })()`)
    await page.close()
    assert.equal(c.own, c.prose, 'a hand-authored SVG lost the page text colour')
    assert.equal(c.ownLink, c.proseLink, 'a hand-authored SVG lost the page link colour')
  })

  test('page prose colour does not reach the label in either theme', { timeout: 60000 }, async () => {
    const [light, dark] = [await measure('light'), await measure('dark')]
    assert.deepEqual(
      dark.text, light.text,
      'the label colour changed with the page theme, but the node fill it sits on did not',
    )
  })
})

const GANTT = `<pre class="mermaid">gantt
    title Delivery
    dateFormat YYYY-MM-DD
    section Backend
    Schema migration      :done,    a1, 2026-01-01, 5d
    Ingest rewrite        :active,  a2, 2026-01-06, 6d
    Retrieval tuning      :         a3, after a2, 5d
    section Frontend
    Surface chrome        :crit,    b1, 2026-01-03, 7d
</pre>`

describe('gantt task labels clear AA on their own bars', () => {
  /* Measured through preRender, so the override must survive the real path. */
  test('every task label in both themes', { timeout: 180000 }, async () => {
    const html = await preRender(GANTT)
    assert.match(html, /sd-diagram-themed/, 'preRender did not emit a light/dark pair to measure')

    const page = await browser.newPage()
    await page.setContent(
      `<!doctype html><body style="margin:0">${html}` +
      `<style>.sd-svg-light,.sd-svg-dark{display:block}</style></body>`,
      { waitUntil: 'domcontentloaded' })
    const rows = await page.evaluate(`(() => {
      const resolve = ${RESOLVE}
      const contrast = ${CONTRAST}
      const out = []
      for (const scope of ['.sd-svg-light', '.sd-svg-dark']) {
        for (const t of document.querySelectorAll(scope + ' text.taskText')) {
          const tb = t.getBoundingClientRect()
          const x = tb.left + tb.width / 2, y = tb.top + tb.height / 2
          let fill = null
          for (const r of document.querySelectorAll(scope + ' rect.task')) {
            const rb = r.getBoundingClientRect()
            if (x >= rb.left && x <= rb.right && y >= rb.top && y <= rb.bottom) {
              fill = getComputedStyle(r).fill; break
            }
          }
          if (!fill) continue
          out.push({ scope, label: t.textContent.trim(), fill, text: getComputedStyle(t).fill,
                     ratio: contrast(resolve(getComputedStyle(t).fill), resolve(fill)) })
        }
      }
      return out
    })()`)
    await page.close()

    // A fixture that measured nothing would pass every assertion below.
    assert.ok(rows.length >= 8, `expected both themes' bars, measured ${rows.length}`)
    for (const scope of ['.sd-svg-light', '.sd-svg-dark']) {
      assert.ok(rows.some((r) => r.scope === scope), `no labels measured in ${scope}`)
    }
    for (const r of rows) {
      assert.ok(r.ratio >= AA,
        `${r.scope} "${r.label}": ${r.ratio.toFixed(2)}:1 (need ${AA}) — ${r.text} on ${r.fill}`)
    }
  })

  test('the palette is drawn from the shipped tokens, not invented', { timeout: 60000 }, async () => {
    // A retoken must not leave the gantt behind on last month's red.
    const css = await readFile(join(HERE, '..', 'chrome', 'easel.css'), 'utf8')
    const page = await browser.newPage()
    for (const [theme, mermaidTheme] of [['light', 'default'], ['dark', 'dark']]) {
      await page.setContent(
        `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head>` +
        `<body class="sf-shell"></body></html>`, { waitUntil: 'domcontentloaded' })
      const shipped = await page.evaluate(`(() => {
        const cx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
        const hex = (v) => { cx.fillStyle = '#000'; cx.fillStyle = v; cx.fillRect(0,0,1,1)
          const d = cx.getImageData(0,0,1,1).data
          return '#' + [d[0],d[1],d[2]].map((n) => n.toString(16).padStart(2,'0')).join('') }
        const cs = getComputedStyle(document.documentElement)
        const out = new Set()
        for (const n of ${JSON.stringify(TOKEN_NAMES)}) {
          const v = cs.getPropertyValue(n).trim()
          if (v) out.add(hex(v))
        }
        return [...out]
      })()`)
      const set = new Set(shipped)
      for (const [name, value] of Object.entries(ganttThemeVariables(mermaidTheme))) {
        assert.ok(set.has(value.toLowerCase()),
          `${theme}: gantt ${name} is ${value}, which is not any shipped token — the palette has drifted`)
      }
    }
    await page.close()
  })
})

describe('the gantt override reaches gantt and nothing else', () => {
  for (const [label, src, want] of [
    ['a plain gantt', 'gantt\n  title x', true],
    ['a gantt behind front matter', '---\nconfig:\n  theme: base\n---\ngantt\n  title x', true],
    ['a gantt behind an init directive', '%%{init: {"theme":"base"}}%%\ngantt\n  title x', true],
    ['a gantt behind a comment', '%% a note\ngantt\n  title x', true],
    ['a comment before an init directive', '%% a note\n%%{init: {"theme":"base"}}%%\ngantt\n  title x', true],
    ['an init directive before a comment', '%%{init: {"theme":"base"}}%%\n%% a note\ngantt\n  title x', true],
    ['front matter then a comment', '---\nconfig:\n  x: 1\n---\n%% a note\ngantt\n  title x', true],
    ['a flowchart', 'flowchart TD\n  a-->b', false],
    ['a flowchart merely mentioning gantt', 'flowchart TD\n  a[gantt]-->b', false],
    ['a pie chart', 'pie title x\n  "a" : 1', false],
  ]) {
    test(`${label} → ${want}`, () => assert.equal(isGantt(src), want))
  }
})
