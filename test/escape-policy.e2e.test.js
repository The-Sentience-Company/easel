/* Escape dismisses what is on top and nothing else — losing annotate mode to it
   leaves a reader unable to leave feedback at all. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-esc-'))
const PAGE = join(DATA_DIR, 'page.html')
const SLOW = { timeout: 120000 }

const api = makeApi(BASE)
let daemon
let browser
let key

before(async () => {
  writeFileSync(PAGE, '<h1>escape</h1><p>para one</p><p>para two</p>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  browser = await (await import('puppeteer')).default.launch({ headless: 'new', args: ['--no-sandbox'] })
  const opened = await api('POST', '/api/open', { file: PAGE, title: 'escape' })
  key = opened.data.key
}, SLOW)

after(async () => {
  await browser?.close()
  daemon?.kill('SIGTERM')
})

async function openPage() {
  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0', timeout: 60000 })
  return page
}

const annotating = (page) => page.evaluate(() => document.body.classList.contains('sf-annotating'))
const panelOpen = (page, sel) => page.evaluate((s) => document.querySelector(s).classList.contains('sf-open'), sel)

test('annotate mode is on at load and Escape does not turn it off', SLOW, async () => {
  const page = await openPage()
  assert.equal(await annotating(page), true, 'annotate mode is on when the page loads')

  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  assert.equal(await annotating(page), true, 'Escape must leave annotate mode alone')
  await page.close()
})

/* The reported sequence: open the conversation, hit Escape to dismiss it, and
   annotate mode went with it. */
test('Escape closes the chat panel and leaves annotate mode on', SLOW, async () => {
  const page = await openPage()
  await page.evaluate(() => document.querySelector('.sf-chat-toggle').click())
  assert.equal(await panelOpen(page, '.sf-chat'), true)

  await page.keyboard.press('Escape')
  assert.equal(await panelOpen(page, '.sf-chat'), false, 'Escape must close the open panel')
  assert.equal(await annotating(page), true, 'and must not take annotate mode with it')
  await page.close()
})

test('Escape closes the feedback panel and leaves annotate mode on', SLOW, async () => {
  const page = await openPage()
  await page.evaluate(() => document.querySelector('.sf-queue-toggle').click())
  assert.equal(await panelOpen(page, '.sf-queue'), true)

  await page.keyboard.press('Escape')
  assert.equal(await panelOpen(page, '.sf-queue'), false)
  assert.equal(await annotating(page), true)
  await page.close()
})

// Only the button turns it off, so the button still has to work.
test('the annotate button still toggles the mode both ways', SLOW, async () => {
  const page = await openPage()
  await page.evaluate(() => document.querySelector('.sf-annotate-toggle').click())
  assert.equal(await annotating(page), false)
  await page.evaluate(() => document.querySelector('.sf-annotate-toggle').click())
  assert.equal(await annotating(page), true)
  await page.close()
})

/* The whiteboard sits over everything, so Escape closes it — but excalidraw owns
   Escape too, and closing must still flush or Escape becomes a data-loss path. */

const overlayOpen = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.sf-wb-overlay')
    return Boolean(el) && getComputedStyle(el).display !== 'none'
  })

const overlayClosed = (page) =>
  page.waitForFunction(() => getComputedStyle(document.querySelector('.sf-wb-overlay')).display === 'none', {
    timeout: 15000,
  })

async function openBoard(name) {
  const path = join(DATA_DIR, `${name}.html`)
  writeFileSync(path, '<pre class="mermaid">graph LR\n  A[alpha] --> B[beta]</pre>')
  const { data } = await api('POST', '/api/open', { file: path, title: name })
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 800 })
  await page.goto(`${BASE}/b/${data.key}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
  await page.evaluate(() => document.querySelector('.sf-wb-open').click())
  const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
  await frame.waitForSelector('.excalidraw', { timeout: 60000 })
  await new Promise((r) => setTimeout(r, 2500))
  return { page, frame, key: data.key }
}

// Puts the keyboard inside the frame, which is where Escape actually lands.
const focusCanvas = async (page) => {
  await page.mouse.click(600, 400)
  await new Promise((r) => setTimeout(r, 300))
}

test('Escape closes the board', SLOW, async () => {
  const { page } = await openBoard('esc-close')
  await focusCanvas(page)
  await page.keyboard.press('Escape')
  await overlayClosed(page)
  await page.close()
})

// The chrome's own handler, not the frame forwarding: focus never entered the
// frame. A popover deliberately opened before the board is still on top, so it goes first.
test('Escape closes the board with focus still on the page', SLOW, async () => {
  const { page } = await openBoard('esc-parent-focus')
  await page.evaluate(() => document.querySelector('.sd-diagram').click())
  await page.waitForSelector('.sf-popover', { timeout: 15000 })
  await page.evaluate(() => document.body.focus())

  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 800))
  assert.equal(await overlayOpen(page), true, 'the popover above the board is dismissed first')
  assert.equal(
    await page.evaluate(() => Boolean(document.querySelector('.sf-popover'))),
    false, 'the first Escape must take the popover',
  )

  await page.keyboard.press('Escape')
  await overlayClosed(page)
  await page.close()
})

/* Excalidraw does not deselect on Escape, so gating on a selection would leave
   the board unclosable; only its own open UI may swallow the key. */
test('an Escape excalidraw is using does not close the board', SLOW, async () => {
  const { page, frame } = await openBoard('esc-editing')
  await focusCanvas(page)

  await frame.evaluate(() => document.querySelector('.dropdown-menu-button').click())
  await frame.waitForSelector('.dropdown-menu', { timeout: 10000 })

  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 900))
  assert.equal(await overlayOpen(page), true, 'the Escape that closes excalidraw’s menu belongs to excalidraw')
  assert.equal(
    await frame.evaluate(() => Boolean(document.querySelector('.dropdown-menu'))),
    false,
    'and it must actually have closed the menu'
  )

  await page.keyboard.press('Escape')
  await overlayClosed(page)
  await page.close()
})

// The right-click menu is a separate appState field from the hamburger menu, and
// missing it closed the whole board on the Escape meant to dismiss it.
test('Escape dismisses the right-click menu without closing the board', SLOW, async () => {
  const { page, frame } = await openBoard('esc-context-menu')
  await focusCanvas(page)

  await page.mouse.click(600, 400, { button: 'right' })
  await frame.waitForSelector('.context-menu', { timeout: 10000 })

  await page.keyboard.press('Escape')
  await new Promise((r) => setTimeout(r, 900))
  assert.equal(
    await frame.evaluate(() => Boolean(document.querySelector('.context-menu'))),
    false,
    'the menu must close'
  )
  assert.equal(await overlayOpen(page), true, 'but the board must not go with it')

  await page.keyboard.press('Escape')
  await overlayClosed(page)
  await page.close()
})

test('closing with Escape still flushes the drawing', SLOW, async () => {
  const { page, key } = await openBoard('esc-flush')
  await focusCanvas(page)

  // Unsaved work, so a close that bypassed the flush would lose it.
  await page.keyboard.press('KeyR')
  await page.mouse.move(400, 300)
  await page.mouse.down()
  await page.mouse.move(700, 500, { steps: 10 })
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 500))

  await page.keyboard.press('Escape')
  await overlayClosed(page)

  const stored = await api('GET', `/api/b/${key}/whiteboard/0`)
  const drawn = (stored.data.whiteboard?.scene?.elements || []).filter((el) => el.type === 'rectangle' && !el.isDeleted)
  assert.ok(drawn.length > 0, 'the rectangle drawn before Escape must have been saved')
  await page.close()
})
