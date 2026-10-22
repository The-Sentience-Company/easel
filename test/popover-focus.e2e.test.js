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
  const tabs = ['Alpha', 'Beta'].map((t) => `<section class="sd-section" data-tab="${t}"><h2>${t}</h2><p>${t} body</p></section>`).join('')
  const noted = '<section class="sd-section"><h2>Noted</h2><p class="noted">a note goes here</p></section>'
  writeFileSync(PAGE, `<section class="sd-section"><h2>One</h2><p>para one</p>${filler}</section>${noted}${tabs}`)
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

// Wispr Flow reads the OS focus, which follows document.activeElement; a focused
// tab button or page body takes the dictation even though the pop-up still shows.
const focused = () => pg.evaluate(() => document.activeElement?.className)

test('switching tabs while the comment box is open keeps it focused', async () => {
  for (const control of ['.sf-tab[aria-selected="false"]', '[data-tab]:not([hidden]) .sf-tab-pager button']) {
    await pg.click('[data-tab]:not([hidden]) p')
    await pg.click(control)
    assert.equal(await focused(), 'sf-popover-text', `after clicking ${control}`)
    assert.equal(await insertLands(), 'dictated', `after clicking ${control}`)
    await closeAll()
  }
})

test('a tab chosen from the keyboard keeps the focus while the comment box is open', async () => {
  await pg.click('[data-tab]:not([hidden]) p')
  await pg.focus('.sf-tab[aria-selected="false"]')
  await pg.keyboard.press('Enter')
  assert.equal(await focused(), 'sf-tab')
  await closeAll()
})

test('a click on blank page or the top bar keeps the comment box focused', async () => {
  await pg.click('#sf-content p')
  await pg.click('.sf-title')
  assert.equal(await focused(), 'sf-popover-text', 'after clicking the top bar')
  const blank = await pg.evaluate(() => ({ x: 2, y: innerHeight / 2 }))
  assert.equal(await pg.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-sid], .sf-popover') ?? null, blank), null,
    'precondition: the point is blank page')
  await pg.mouse.click(blank.x, blank.y)
  assert.equal(await focused(), 'sf-popover-text', 'after clicking blank page')
  assert.equal(await insertLands(), 'dictated')
  await closeAll()
})

// Auto-open holds while the daemon hears the box is focused: a new tab would take the dictation.
test('the tab tells the daemon while the comment box has the focus, and when it stops', async () => {
  const sent = []
  let lastAt = Date.now()
  const onRequest = (r) => {
    if (!r.url().endsWith('/api/composing')) return
    lastAt = Date.now()
    sent.push(JSON.parse(r.postData()).composing)
  }
  pg.on('request', onRequest)
  // Reports go out one at a time, so earlier tests' tail can still be draining.
  while (Date.now() - lastAt < 300) await new Promise((r) => setTimeout(r, 50))
  sent.length = 0
  try {
    await pg.click('#sf-content p')
    await pg.waitForFunction(() => document.activeElement?.className === 'sf-popover-text')
    await closeAll()
    for (let i = 0; i < 40 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(sent, [true, false])
  } finally {
    pg.off('request', onRequest)
  }
})

test('a right-click on the page keeps the comment box focused', async () => {
  await pg.click('#sf-content p')
  const b = await (await pg.$('.noted')).boundingBox()
  const at = { x: b.x + 5, y: b.y + b.height / 2 }
  assert.equal(await pg.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.sf-popover') ?? null, at), null,
    'precondition: the right-click misses the pop-up')
  await pg.mouse.click(at.x, at.y, { button: 'right' })
  assert.equal(await focused(), 'sf-popover-text')
  assert.equal(await insertLands(), 'dictated')
  await closeAll()
})

test('clicking an element with a queued note opens a focused comment box under the note', async () => {
  await pg.click('.noted')
  await pg.type('.sf-popover-text', 'first note')
  await pg.click('.sf-popover-queue')
  await pg.waitForSelector('.noted .sf-marker')
  await pg.click('.noted')
  assert.deepEqual(await pg.evaluate(() => [...document.querySelectorAll('.sf-draft-comment')].map((n) => n.textContent)), ['first note'])
  assert.equal(await focused(), 'sf-popover-text')
  assert.equal(await insertLands(), 'dictated')
  await pg.click('.sf-draft-remove')
  await pg.waitForFunction(() => !document.querySelector('.noted .sf-marker'))
})
