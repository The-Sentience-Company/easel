/* Dictation apps paste into whatever holds focus, so a click on the comment
   pop-up's own body must leave its textarea focused. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-popfocus-'))
const PAGE = join(DATA_DIR, 'page.html')

const api = makeApi(BASE)
let daemon
let key
let browser
let pg

before(async () => {
  const filler = '<p>filler</p>'.repeat(40)
  writeFileSync(PAGE, `<section class="sd-section"><h2>One</h2><p>para one</p>${filler}</section>`)
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  key = (await api('POST', '/api/open', { file: PAGE, title: 'popover focus' })).data.key
  browser = await (await import('puppeteer')).default.launch({ headless: 'new' })
  pg = await browser.newPage()
  await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  if (!(await pg.evaluate("document.querySelector('.sf-annotate-toggle').classList.contains('sf-on')"))) {
    await pg.click('.sf-annotate-toggle')
  }
})

after(async () => {
  await browser?.close()
  daemon?.kill()
})

// Input.insertText is how an IME or a dictation app's text reaches the page.
async function insertLands() {
  const cdp = await pg.target().createCDPSession()
  await cdp.send('Input.insertText', { text: 'dictated' })
  await cdp.detach()
  return pg.evaluate(() => document.querySelector('.sf-popover-text')?.value)
}

async function closeAll() {
  await pg.keyboard.press('Escape')
  await pg.waitForFunction(() => !document.querySelector('.sf-popover'))
}

test('a double-click low on the page keeps the comment box focused', async () => {
  // Near the bottom edge the pop-up is lifted under the pointer, so the second
  // click of the double-click lands on the pop-up, not the section.
  const { x, y } = await pg.evaluate(() => ({ x: 200, y: innerHeight - 30 }))
  await pg.mouse.click(x, y, { clickCount: 1 })
  await pg.mouse.click(x, y, { clickCount: 2 })
  assert.equal(await pg.evaluate(() => document.elementFromPoint(200, innerHeight - 30)?.closest('.sf-popover') != null), true,
    'precondition: the pop-up sits under the pointer')
  assert.equal(await pg.evaluate(() => document.activeElement?.className), 'sf-popover-text')
  assert.equal(await insertLands(), 'dictated')
  await closeAll()
})

test('clicking the pop-up label or excerpt keeps the comment box focused', async () => {
  for (const part of ['.sf-popover-label', '.sf-popover-excerpt']) {
    await pg.click('#sf-content p')
    await pg.click(part)
    assert.equal(await pg.evaluate(() => document.activeElement?.className), 'sf-popover-text', `after clicking ${part}`)
    assert.equal(await insertLands(), 'dictated', `after clicking ${part}`)
    await closeAll()
  }
})

test('dragging across the excerpt still selects its text', async () => {
  await pg.click('#sf-content p')
  const b = await (await pg.$('.sf-popover-excerpt')).boundingBox()
  await pg.mouse.move(b.x + 4, b.y + b.height / 2)
  await pg.mouse.down()
  await pg.mouse.move(b.x + b.width - 4, b.y + b.height / 2, { steps: 5 })
  await pg.mouse.up()
  assert.ok((await pg.evaluate(() => window.getSelection().toString())).length > 0, 'the excerpt drag selected nothing')
  await closeAll()
})

test('the pop-up buttons still act after the focus guard', async () => {
  await pg.click('#sf-content p')
  await pg.click('.sf-popover-cancel')
  assert.equal(await pg.evaluate(() => document.querySelector('.sf-popover')), null)
})
