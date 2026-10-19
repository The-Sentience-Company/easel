/* On a slow daemon the Queue pop-up must not wait on the POST, must not queue a
   note twice, and a Send pressed meanwhile must carry the note. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-once-'))
const PAGE = join(DATA_DIR, 'page.html')
const SLOW = { timeout: 120000 }
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const api = makeApi(BASE)
let daemon
let browser

before(async () => {
  writeFileSync(PAGE, '<h1>queue once</h1><p id="one">para one</p><p id="two">para two</p><p id="three">para three</p>')
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
  return { key, page }
}

// Holds each feedback POST in the browser until released, standing in for a slow daemon.
async function stallFeedback(page) {
  const held = []
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/feedback')) held.push(req)
    else req.continue()
  })
  return held
}

async function drafts(page, key) {
  const clientId = await page.evaluate(() => localStorage.getItem('sf-client-id'))
  const { data } = await api('GET', `/api/b/${key}/state?clientId=${clientId}`)
  return data.feedback.filter((i) => i.state === 'draft')
}

test('Queue hides the pop-up at once on a slow daemon and queues the note once', SLOW, async () => {
  const { key, page } = await openBoard('slow queue')
  const held = await stallFeedback(page)
  await page.click('#one')
  await page.waitForSelector('.sf-popover-text')
  await page.keyboard.type('only once please')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 300))

  assert.equal(held.length, 1, 'only the first press may reach the daemon')
  assert.equal(await page.$('.sf-popover:not([style*="none"])'), null, 'the pop-up must not wait on the daemon')
  held.forEach((req) => req.continue())
  await page.waitForFunction(() => !document.querySelector('.sf-popover'))
  const queued = await drafts(page, key)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].comment, 'only once please')
  await page.close()
})

test('a failed Queue brings the note back so it can be queued again', SLOW, async () => {
  const { key, page } = await openBoard('failed queue')
  const held = await stallFeedback(page)
  await page.click('#two')
  await page.waitForSelector('.sf-popover-text')
  await page.keyboard.type('retry me')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.sf-popover').style.display === 'none')
  held.shift().abort()
  await page.waitForFunction(() => [...document.querySelectorAll('.sf-toast')].some((t) => t.textContent.startsWith('Queue failed')))
  assert.equal(await page.evaluate(() => document.querySelector('.sf-popover').style.display), '')
  assert.equal(await page.evaluate(() => document.querySelector('.sf-popover-text').value), 'retry me')

  await page.focus('.sf-popover-text')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.sf-popover').style.display === 'none')
  held.shift().continue()
  await page.waitForFunction(() => !document.querySelector('.sf-popover'))
  assert.equal((await drafts(page, key)).filter((i) => i.comment === 'retry me').length, 1)
  await page.close()
})

test('Send pressed while a Queue is still out carries that note', SLOW, async () => {
  const { key, page } = await openBoard('send during queue')
  const held = await stallFeedback(page)
  await page.click('#three')
  await page.waitForSelector('.sf-popover-text')
  await page.keyboard.type('ride along')
  await page.keyboard.press('Enter')
  await page.evaluate(() => document.querySelector('.sf-send-now').click())
  await new Promise((r) => setTimeout(r, 300))
  held.forEach((req) => req.continue())
  await page.waitForFunction(() => [...document.querySelectorAll('.sf-toast')].some((t) => t.textContent.startsWith('Sent')))
  const clientId = await page.evaluate(() => localStorage.getItem('sf-client-id'))
  const { data } = await api('GET', `/api/b/${key}/state?clientId=${clientId}`)
  assert.equal(data.feedback.find((i) => i.comment === 'ride along')?.state, 'submitted')
  await page.close()
})

test('the daemon answers a repeated identical note with the draft it already holds', async () => {
  const key = (await api('POST', '/api/open', { file: PAGE, title: 'daemon repeat' })).data.key
  const sid = (await api('GET', `/api/b/${key}/state`)).data.currentRound.html.match(/<p[^>]*data-sid="([^"]+)"[^>]*>para one/)[1]
  const note = { clientId: 'c-rep', round: 1, anchor: { sid, quote: 'para' }, comment: 'same words', images: [PNG] }
  const first = await api('POST', `/api/b/${key}/feedback`, note)
  const repeats = await Promise.all([1, 2].map(() => api('POST', `/api/b/${key}/feedback`, note)))
  assert.equal(first.status, 200)
  for (const r of repeats) assert.equal(r.data.id, first.data.id, 'a repeat must return the existing draft')

  // Anything that differs is a different note, and a sent note no longer blocks its twin.
  const other = await api('POST', `/api/b/${key}/feedback`, { ...note, comment: 'other words' })
  const noImage = await api('POST', `/api/b/${key}/feedback`, { ...note, images: [] })
  const otherClient = await api('POST', `/api/b/${key}/feedback`, { ...note, clientId: 'c-other' })
  assert.equal(new Set([first, other, noImage, otherClient].map((r) => r.data.id)).size, 4)
  await api('POST', `/api/b/${key}/send`, { clientId: 'c-rep' })
  const afterSend = await api('POST', `/api/b/${key}/feedback`, note)
  assert.equal(afterSend.data.state, 'draft')
  const shown = (await api('GET', `/api/b/${key}/state?clientId=c-rep`)).data.feedback
  assert.equal(shown.filter((i) => i.comment === 'same words' && i.images?.length).length, 2, 'one sent, one new draft')
})
