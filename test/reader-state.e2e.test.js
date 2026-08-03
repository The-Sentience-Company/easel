/* A sync must not take the reader's place on the page with it: collapsing a
   <details> and then queuing a comment sprang it back open and jumped the view. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-reader-'))
const SLOW = { timeout: 120000 }

const api = makeApi(BASE)
let daemon
let browser

const LANDMARK = 'filler paragraph number 40'
const ANCHOR = 'filler paragraph number 20'

const filler = (n) =>
  Array.from(
    { length: n },
    (_, i) => `<p>filler paragraph number ${i} with enough words to take a line or two of height.</p>`
  ).join('\n')

/* The two bodies differ in height on purpose: equal ones cancel out when the
   reset swaps which is open, and the jump assertions would prove nothing. */
const PAGE_HTML = `<h1>reader state</h1>
<details><summary>authored closed</summary><p>${'body text inside the tall first collapsible. '.repeat(60)}</p></details>
<details open><summary>authored open</summary><p>a short second body</p></details>
${filler(60)}`

before(async () => {
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  browser = await (await import('puppeteer')).default.launch({ headless: 'new', args: ['--no-sandbox'] })
}, SLOW)

after(async () => {
  await browser?.close()
  daemon?.kill('SIGTERM')
})

// A distinct file per case: /api/open reuses the board for a file already open.
async function openPage(name) {
  const file = join(DATA_DIR, `${name}.html`)
  writeFileSync(file, PAGE_HTML)
  const { data } = await api('POST', '/api/open', { file, title: name })
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 700 })
  await page.goto(`${BASE}/b/${data.key}`, { waitUntil: 'networkidle0', timeout: 60000 })
  return page
}

const detailsState = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#sf-content details')].map((d) => d.open))

// Viewport-relative top of a fixed landmark — what the reader actually sees.
// scrollY alone lies: the browser's scroll anchoring moves it to hold the view still.
const landmarkTop = (page) =>
  page.evaluate((needle) => {
    const n = [...document.querySelectorAll('#sf-content p')].find((p) => p.textContent.includes(needle))
    return n ? Math.round(n.getBoundingClientRect().top) : null
  }, LANDMARK)

/* The reader's own state: the authored-closed one opened, the authored-open one
   collapsed. Both directions, because the reset shows up as either. */
async function setReaderState(page) {
  await page.evaluate((needle) => {
    const ds = [...document.querySelectorAll('#sf-content details')]
    ds[0].open = true
    ds[1].open = false
    const n = [...document.querySelectorAll('#sf-content p')].find((p) => p.textContent.includes(needle))
    n.scrollIntoView({ block: 'center' })
  }, LANDMARK)
  await new Promise((r) => setTimeout(r, 300))
}

async function queueComment(page) {
  await page.evaluate((needle) => {
    const p = [...document.querySelectorAll('#sf-content p[data-sid]')].find((n) => n.textContent.includes(needle))
    p.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 200, clientY: 300 }))
  }, ANCHOR)
  await page.waitForSelector('.sf-popover-text', { timeout: 15000 })
  await page.type('.sf-popover-text', 'a queued comment')
  await page.evaluate(() => document.querySelector('.sf-popover-queue').click())
  await page.waitForFunction(() => document.querySelectorAll('.sf-item-remove').length === 1, { timeout: 15000 })
}

test('queuing a comment leaves every <details> as the reader left it', SLOW, async () => {
  const page = await openPage('details-queue')
  await setReaderState(page)
  assert.deepEqual(await detailsState(page), [true, false], 'precondition: the reader has flipped both')

  await queueComment(page)
  assert.deepEqual(await detailsState(page), [true, false], 'the sync re-render must not reset them')
  await page.close()
})

test('removing a draft leaves every <details> as the reader left it', SLOW, async () => {
  const page = await openPage('details-remove')
  await queueComment(page)
  await setReaderState(page)
  assert.deepEqual(await detailsState(page), [true, false], 'precondition: the reader has flipped both')

  await page.evaluate(() => document.querySelector('.sf-item-remove').click())
  await page.waitForFunction(() => document.querySelectorAll('.sf-item-remove').length === 0, { timeout: 15000 })
  assert.deepEqual(await detailsState(page), [true, false], 'the sync re-render must not reset them')
  await page.close()
})

/* The jump Aleks reported. A collapsible above the viewport springing back to its
   authored height is what moves the page; 8px covers the annotation marker. */
const JUMP_TOLERANCE = 8

test('queuing a comment does not move the page under the reader', SLOW, async () => {
  const page = await openPage('jump-queue')
  await setReaderState(page)
  const before = await landmarkTop(page)
  assert.ok(before !== null && before > 0, 'precondition: the landmark is in view')

  await queueComment(page)
  const after = await landmarkTop(page)
  assert.ok(
    Math.abs(after - before) <= JUMP_TOLERANCE,
    `the landmark moved ${after - before}px (${before} -> ${after})`
  )
  await page.close()
})

test('removing a draft does not move the page under the reader', SLOW, async () => {
  const page = await openPage('jump-remove')
  await queueComment(page)
  await setReaderState(page)
  const before = await landmarkTop(page)
  assert.ok(before !== null && before > 0, 'precondition: the landmark is in view')

  await page.evaluate(() => document.querySelector('.sf-item-remove').click())
  await page.waitForFunction(() => document.querySelectorAll('.sf-item-remove').length === 0, { timeout: 15000 })
  const after = await landmarkTop(page)
  assert.ok(
    Math.abs(after - before) <= JUMP_TOLERANCE,
    `the landmark moved ${after - before}px (${before} -> ${after})`
  )
  await page.close()
})

/* Switching rounds replaces the body with a different document — restoring by sid
   must not leak one round's reader state onto a block that is not the same block. */
test('a round switch keeps the authored state of blocks the reader never touched', SLOW, async () => {
  const file = join(DATA_DIR, 'round-switch.html')
  writeFileSync(file, PAGE_HTML)
  const { data } = await api('POST', '/api/open', { file, title: 'round-switch' })
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 700 })
  await page.goto(`${BASE}/b/${data.key}`, { waitUntil: 'networkidle0', timeout: 60000 })

  await setReaderState(page)
  assert.deepEqual(await detailsState(page), [true, false], 'precondition: round one carries reader state')

  writeFileSync(file, `<h1>round two</h1>
<details><summary>a brand new collapsible</summary><p>only in round two</p></details>
${filler(20)}`)
  await api('POST', `/api/b/${data.key}/publish`, { note: 'round 2' })
  await page.waitForFunction(() => document.querySelectorAll('.sf-round-pill').length >= 2, { timeout: 15000 })

  const open = await detailsState(page)
  assert.deepEqual(open, [false], 'round two authored it closed and no reader state applies to it')
  await page.close()
})

/* A sid survives an authored open/closed flip, so a block the reader never
   touched must still take the new round's state rather than the old round's. */
async function publishAuthoredFlip(name, { touch, round2Open }) {
  const body = (open) =>
    `<details${open ? ' open' : ''}><summary>a stable collapsible</summary><p>the same body text in both rounds</p></details>`
  const file = join(DATA_DIR, `${name}.html`)
  writeFileSync(file, `<h1>authored flip</h1>\n${body(true)}\n${filler(20)}`)
  const { data } = await api('POST', '/api/open', { file, title: name })
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 700 })
  await page.goto(`${BASE}/b/${data.key}`, { waitUntil: 'networkidle0', timeout: 60000 })
  assert.deepEqual(await detailsState(page), [true], 'precondition: round one authored it open')
  const sidBefore = await page.evaluate(() => document.querySelector('#sf-content details').dataset.sid)

  if (touch) {
    await page.evaluate(() => document.querySelector('#sf-content summary').click())
    await new Promise((r) => setTimeout(r, 200))
    assert.deepEqual(await detailsState(page), [false], 'precondition: the reader collapsed it')
  }

  writeFileSync(file, `<h1>authored flip</h1>\n${body(round2Open)}\n${filler(20)}\n<p>a paragraph only round two has</p>`)
  await api('POST', `/api/b/${data.key}/publish`, { note: 'round 2' })
  await page.waitForFunction(() => document.querySelectorAll('.sf-round-pill').length >= 2, { timeout: 15000 })
  const sidAfter = await page.evaluate(() => document.querySelector('#sf-content details').dataset.sid)
  assert.equal(sidAfter, sidBefore, 'precondition: the sid survives the authored flip, so the leak is reachable')
  return page
}

test('an untouched section follows the new round rather than the old one', SLOW, async () => {
  const page = await publishAuthoredFlip('authored-flip-untouched', { touch: false, round2Open: false })
  assert.deepEqual(await detailsState(page), [false], 'round two authored it closed and the reader never said otherwise')
  await page.close()
})

test('a section the reader collapsed stays collapsed into the next round', SLOW, async () => {
  const page = await publishAuthoredFlip('authored-flip-touched', { touch: true, round2Open: true })
  assert.deepEqual(await detailsState(page), [false], 'the reader collapsed it; round two authoring it open must not override that')
  await page.close()
})
