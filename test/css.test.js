import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import puppeteer from 'puppeteer'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const css = await readFile(join(HERE, '..', 'chrome', 'easel.css'), 'utf8')

/* Chrome elements carry explicit display in easel.css; without a [hidden]
   override the attribute silently does nothing. */
const HIDEABLE = ['sf-wip-marker', 'sf-rounds', 'sf-audit', 'sf-cancel-wait', 'sf-chat-working']

describe('easel.css', () => {
  test('the hidden attribute wins over chrome display rules', async () => {
    const browser = await puppeteer.launch({ headless: 'new' })
    const page = await browser.newPage()
    await page.setContent(
      `<!doctype html><html data-theme="light"><head><style>${css}</style></head>` +
      `<body class="sf-shell"><div id="sf-chrome">` +
      HIDEABLE.map((c) => `<div class="${c}" id="x-${c}" hidden>x</div>`).join('') +
      `</div></body></html>`,
    )
    const visible = await page.evaluate((classes) =>
      classes.filter((c) => getComputedStyle(document.getElementById(`x-${c}`)).display !== 'none'),
    HIDEABLE)
    await browser.close()
    assert.deepEqual(visible, [], `these stayed visible despite [hidden]: ${visible.join(', ')}`)
  })

  test('annotation outlines draw inward inside the scrollable table wrapper', async () => {
    const browser = await puppeteer.launch({ headless: 'new' })
    const page = await browser.newPage()
    await page.setContent(
      `<!doctype html><html data-theme="light"><head><style>${css}</style></head>` +
      `<body class="sf-shell"><main id="sf-content"><div class="sd-tablewrap"><table>` +
      `<tbody><tr class="sf-annotated" id="r"><td class="sf-hover" id="c">cell` +
      `<div data-widget="w" id="w"><div class="sd-widget-options"></div></div></td></tr></tbody>` +
      `</table></div><p class="sf-annotated" id="p">outside</p>` +
      `<div data-widget="w2" id="w2"></div></main></body></html>`,
    )
    const got = await page.evaluate(`(() => ({
      row: getComputedStyle(document.getElementById('r')).outlineOffset,
      cell: getComputedStyle(document.getElementById('c')).outlineOffset,
      outside: getComputedStyle(document.getElementById('p')).outlineOffset,
      widgetRule: getComputedStyle(document.getElementById('w')).borderTopWidth,
      widgetRuleOutside: getComputedStyle(document.getElementById('w2')).borderTopWidth,
    }))()`)
    await browser.close()
    assert.equal(got.row, '-2px', 'annotated table row must draw its outline inward')
    assert.equal(got.cell, '-2px', 'hovered cell must draw its outline inward')
    assert.notEqual(got.outside, '-2px', 'outside a tablewrap the outline stays outward')
    assert.equal(got.widgetRule, '0px', 'a widget inside a table must not draw a second rule')
    assert.notEqual(got.widgetRuleOutside, '0px', 'a widget outside a table keeps its rule')
  })

  test('a pick row fuses with the row above — no separator between them', async () => {
    const browser = await puppeteer.launch({ headless: 'new' })
    const page = await browser.newPage()
    await page.setContent(
      `<!doctype html><html data-theme="light"><head><style>${css}</style></head>` +
      `<body class="sf-shell"><main id="sf-content"><div class="sd-tablewrap"><table><tbody>` +
      `<tr id="content"><td id="cc">content</td></tr>` +
      `<tr class="sd-pick-row" id="pick"><td id="pc">best</td></tr>` +
      `<tr id="plain"><td id="nc">next</td></tr>` +
      `</tbody></table></div></main></body></html>`,
    )
    const got = await page.evaluate(`(() => ({
      seam: getComputedStyle(document.getElementById('cc')).borderBottomWidth,
      pickPad: getComputedStyle(document.getElementById('pc')).paddingTop,
      plain: getComputedStyle(document.getElementById('nc')).borderBottomWidth,
    }))()`)
    await browser.close()
    assert.equal(got.seam, '0px', 'the row before a pick row must not draw a separator')
    assert.equal(got.pickPad, '0px', 'pick-row cells drop their top padding')
    assert.notEqual(got.plain, '0px', 'ordinary rows keep their separator')
  })

  test('templates-facing design classes never use the sf- prefix', () => {
    const sd = [...css.matchAll(/\.(sd-[a-z-]+)/g)].map((m) => m[1])
    assert.ok(sd.length > 20, 'expected the sd- design system to be present')
  })
})
