/* Cmd+Shift+S sends every queued note from anywhere on the board, including
   while typing, and never lets the browser's own Save dialog through. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-sendkey-'))
const PAGE = join(DATA_DIR, 'page.html')
const SLOW = { timeout: 120000 }

const api = makeApi(BASE)
let daemon
let browser

before(async () => {
  writeFileSync(PAGE, '<h1>send shortcut</h1><p id="one">para one</p><p id="two">para two</p><p id="three">para three</p>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  browser = await (await import('puppeteer')).default.launch({ headless: 'new', args: ['--no-sandbox'] })
}, SLOW)

after(async () => {
  await browser?.close()
  daemon?.kill('SIGTERM')
})

async function openBoard(title) {
  const key = (await api('POST', '/api/open', { file: PAGE, title })).data.key
  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0', timeout: 60000 })
  // Bubble phase on window runs after the board's own document listener.
  await page.evaluate(() => {
    window.__saveKeyPrevented = []
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 's' && e.shiftKey) window.__saveKeyPrevented.push(e.defaultPrevented)
    })
  })
  return { key, page }
}

async function queueNote(page, sel, text) {
  await page.click(sel)
  await page.waitForSelector('.sf-popover-text')
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => !document.querySelector('.sf-popover'))
}

async function pressSendShortcut(page) {
  await page.keyboard.down('Meta')
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyS')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Meta')
}

const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.sf-toast')].map((t) => t.textContent))
// Drafts belong to the tab that queued them, so the count is read as that tab.
async function draftsOnServer(page, key) {
  const clientId = await page.evaluate(() => localStorage.getItem('sf-client-id'))
  const { data } = await api('GET', `/api/b/${key}/state?clientId=${clientId}`)
  return data.feedback.filter((i) => i.state === 'draft').length
}

test('the shortcut sends every queued note from inside the comment pop-up', SLOW, async () => {
  const { key, page } = await openBoard('send from popover')
  await queueNote(page, '#one', 'first note')
  await queueNote(page, '#two', 'second note')
  await page.waitForFunction(() => document.querySelector('.sf-send-now').textContent === 'Send 2')
  assert.equal(await draftsOnServer(page, key), 2)

  await page.click('#three')
  await page.waitForSelector('.sf-popover-text')
  await pressSendShortcut(page)

  await page.waitForFunction(() => [...document.querySelectorAll('.sf-toast')].some((t) => t.textContent === 'Sent 2 items'), { timeout: 5000 })
  assert.equal(await draftsOnServer(page, key), 0, 'both queued notes must be sent')
  assert.deepEqual(await page.evaluate(() => window.__saveKeyPrevented), [true], 'the browser Save shortcut must be suppressed')
  await page.close()
})

test('a note still being typed in the pop-up is queued and sent with the rest', SLOW, async () => {
  const { key, page } = await openBoard('send typed note')
  await queueNote(page, '#one', 'first note')
  await queueNote(page, '#two', 'second note')
  await page.waitForFunction(() => document.querySelector('.sf-send-now').textContent === 'Send 2')

  await page.click('#three')
  await page.waitForSelector('.sf-popover-text')
  await page.keyboard.type('third note, not yet queued')
  await pressSendShortcut(page)

  await page.waitForFunction(() => [...document.querySelectorAll('.sf-toast')].some((t) => t.textContent === 'Sent 3 items'), { timeout: 5000 })
  assert.equal(await draftsOnServer(page, key), 0)
  assert.equal(await page.evaluate(() => document.querySelector('.sf-popover')), null, 'the queued pop-up closes')
  await page.close()
})

test('the shortcut sends from the chat field without sending the chat text', SLOW, async () => {
  const { key, page } = await openBoard('send from chat')
  await queueNote(page, '#one', 'a note')
  await page.waitForFunction(() => document.querySelector('.sf-send-now').textContent === 'Send 1')

  await page.evaluate(() => document.querySelector('.sf-chat-toggle').click())
  await page.focus('.sf-chat-input')
  await page.keyboard.type('half typed')
  await pressSendShortcut(page)

  await page.waitForFunction(() => [...document.querySelectorAll('.sf-toast')].some((t) => t.textContent === 'Sent 1 item'), { timeout: 5000 })
  assert.equal(await draftsOnServer(page, key), 0)
  assert.equal(await page.evaluate(() => document.querySelector('.sf-chat-input').value), 'half typed')
  assert.deepEqual(await page.evaluate(() => window.__saveKeyPrevented), [true])
  await page.close()
})

test('with nothing queued the shortcut says so and sends nothing', SLOW, async () => {
  const { key, page } = await openBoard('send empty')
  await pressSendShortcut(page)

  await page.waitForFunction(() => [...document.querySelectorAll('.sf-toast')].some((t) => t.textContent === 'Nothing to send'), { timeout: 5000 })
  assert.equal(await draftsOnServer(page, key), 0)
  assert.equal((await toasts(page)).some((t) => t.startsWith('Sent')), false)
  assert.deepEqual(await page.evaluate(() => window.__saveKeyPrevented), [true])
  await page.close()
})
