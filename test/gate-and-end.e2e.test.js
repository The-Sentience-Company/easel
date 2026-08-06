/* Layout gate and the browser-side end control, driven through the real
   client.js against a live daemon. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-gate-'))
const PAGE = join(DATA_DIR, 'page.html')

const api = makeApi(BASE)
let daemon
let browser

before(async () => {
  writeFileSync(PAGE, '<h1>gate</h1><p>para one</p>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  browser = await (await import('puppeteer')).default.launch({ headless: 'new' })
})

after(async () => {
  await browser?.close()
  daemon?.kill()
})

const openBoard = async () => (await api('POST', '/api/open', { file: PAGE, title: 'gate' })).data.key

const gateState = () => ({
  gated: document.body.classList.contains('sf-gated'),
  gateVisible: getComputedStyle(document.querySelector('.sf-gate')).display !== 'none',
  contentVisible: getComputedStyle(document.querySelector('#sf-content')).visibility === 'visible',
  held: document.querySelector('.sf-gate-card').classList.contains('sf-gate-held'),
  // The banner belongs to the chrome, which does not exist if client.js never ran.
  banner: (() => {
    const b = document.querySelector('.sf-gate-banner')
    return b && getComputedStyle(b).display !== 'none' ? b.textContent : null
  })(),
  title: document.querySelector('.sf-gate-title').textContent,
})

/** Holds every /state response until released, so the gate can be observed. */
async function holdState(page, ms) {
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (/\/api\/b\/[^/]+\/state/.test(req.url())) {
      setTimeout(() => req.continue().catch(() => {}), ms)
      return
    }
    req.continue().catch(() => {})
  })
}

test('the shell ships the gate, so the blank page is covered before any JS runs', async () => {
  const key = await openBoard()
  const shell = await (await fetch(`${BASE}/b/${key}`)).text()
  assert.match(shell, /class="sf-shell sf-gated"/)
  assert.match(shell, /class="sf-gate"/)
  assert.match(shell, /Checking layout/)
  assert.match(shell, /sf-gate-show/)
  // The reveal path must not depend on the module script loading at all.
  assert.ok(shell.indexOf('__sfRevealGate') < shell.indexOf('/assets/client.js'))
  assert.match(shell, /<noscript>/)
})

test('a normal load reveals the gate and shows no banner', async () => {
  const key = await openBoard()
  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  const g = await page.evaluate(gateState)
  assert.equal(g.gated, false)
  assert.equal(g.gateVisible, false)
  assert.equal(g.contentVisible, true)
  assert.equal(g.banner, null, 'a clean reveal must not claim a layout issue')
  await page.close()
})

test('the gate holds while the content has not arrived', async () => {
  const key = await openBoard()
  const page = await browser.newPage()
  await holdState(page, 2500)
  page.goto(`${BASE}/b/${key}`).catch(() => {})
  await page.waitForSelector('.sf-gate', { visible: true })
  const g = await page.evaluate(gateState)
  assert.equal(g.gated, true)
  assert.equal(g.contentVisible, false, 'the empty content must not be on screen')
  assert.match(g.title, /Checking layout/)
  await page.close()
})

test('"Show anyway" reveals immediately and says so', async () => {
  const key = await openBoard()
  const page = await browser.newPage()
  await holdState(page, 3000)
  page.goto(`${BASE}/b/${key}`).catch(() => {})
  await page.waitForSelector('.sf-gate-show', { visible: true })
  await page.click('.sf-gate-show')
  await page.waitForFunction(() => !document.body.classList.contains('sf-gated'))
  const g = await page.evaluate(gateState)
  assert.equal(g.contentVisible, true)
  assert.match(g.banner, /You chose to show it/)
  await page.close()
})

/* The timeout must free content that exists. Content arriving late is the case
   where revealing at the deadline would have shown an empty page instead. */
test('the safety timeout reveals a gate that would otherwise strand the reader', async () => {
  const key = await openBoard()
  const page = await browser.newPage()
  await holdState(page, 6000)
  page.goto(`${BASE}/b/${key}`).catch(() => {})

  await page.waitForFunction(() => document.querySelector('.sf-gate-card')?.classList.contains('sf-gate-stalled'), { timeout: 8000 })
  assert.equal((await page.evaluate(gateState)).gated, true, 'nothing had arrived to reveal at the deadline')

  await page.waitForFunction(() => !document.body.classList.contains('sf-gated'), { timeout: 8000 })
  const g = await page.evaluate(gateState)
  assert.equal(g.contentVisible, true, 'late content must still reveal itself')
  await page.close()
})

test('an error-severity finding holds the gate, and the timeout still frees it', async () => {
  const key = await openBoard()
  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', async (req) => {
    if (!/\/api\/b\/[^/]+\/state/.test(req.url())) return req.continue().catch(() => {})
    const upstream = await (await fetch(req.url().replace(/^http:\/\/[^/]+/, BASE))).json()
    upstream.audit = { findings: [{ severity: 'error', type: 'clipped-text', sid: null, detail: 'injected' }], at: '' }
    req.respond({ contentType: 'application/json', body: JSON.stringify(upstream) }).catch(() => {})
  })

  page.goto(`${BASE}/b/${key}`).catch(() => {})
  await page.waitForFunction(() => document.querySelector('.sf-gate-card')?.classList.contains('sf-gate-held'), { timeout: 6000 })
  const held = await page.evaluate(gateState)
  assert.equal(held.gated, true, 'an error finding must not reveal a broken layout')
  assert.match(held.title, /Fixing a layout issue/)

  await page.waitForFunction(() => !document.body.classList.contains('sf-gated'), { timeout: 8000 })
  const freed = await page.evaluate(gateState)
  assert.equal(freed.contentVisible, true, 'the held state must still be bounded by the safety timeout')
  await page.close()
})

test('a gate with nothing to reveal says so instead of showing a blank page', async () => {
  const key = await openBoard()
  const page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (req.url().endsWith('/assets/client.js')) return req.abort().catch(() => {})
    req.continue().catch(() => {})
  })

  page.goto(`${BASE}/b/${key}`).catch(() => {})
  await page.waitForFunction(() => document.querySelector('.sf-gate-card')?.classList.contains('sf-gate-stalled'), { timeout: 8000 })
  const g = await page.evaluate(gateState)
  assert.equal(g.gated, true, 'revealing would only expose an empty main')
  assert.match(g.title, /did not load/)
  assert.equal(await page.evaluate(() => document.querySelector('.sf-gate-show').textContent), 'Reload')
  await page.close()
})

test('ending sends drafts the tab has not synced yet', async () => {
  const key = await openBoard()
  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })

  const sid = await page.evaluate(() => document.querySelector('#sf-content [data-sid]').dataset.sid)
  const clientId = await page.evaluate(() => localStorage.getItem('sf-client-id'))

  // Every /state comes back with an empty queue, so the tab's cached draft
  // count is 0 while the server holds a real draft.
  await page.setRequestInterception(true)
  page.on('request', async (req) => {
    if (!/\/api\/b\/[^/]+\/state/.test(req.url())) return req.continue().catch(() => {})
    const upstream = await (await fetch(req.url())).json()
    upstream.feedback = []
    req.respond({ contentType: 'application/json', body: JSON.stringify(upstream) }).catch(() => {})
  })

  await api('POST', `/api/b/${key}/feedback`, { clientId, round: 1, anchor: { sid }, comment: 'unsynced draft' })
  await page.reload({ waitUntil: 'networkidle0' })
  assert.match(
    await page.evaluate(() => {
      document.querySelector('.sf-end-session').click()
      return document.querySelector('.sf-end-session').textContent
    }),
    /End session\?/,
    'the tab must believe there are no drafts for this test to mean anything',
  )

  await page.click('.sf-end-session')
  await page.waitForFunction(() => document.querySelector('.sf-end-session')?.disabled === true, { timeout: 5000 })

  const replay = await api('GET', `/api/b/${key}/feedback?since=0`)
  assert.ok(
    replay.data.items.some((i) => i.comment === 'unsynced draft'),
    'a draft the tab had not synced must still be sent by the end',
  )
  await page.close()
})

test('End is two-stage, and ending sends the queued drafts first', async () => {
  const key = await openBoard()
  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })

  const sid = await page.evaluate(() => document.querySelector('#sf-content [data-sid]').dataset.sid)
  const clientId = await page.evaluate(() => localStorage.getItem('sf-client-id') || '')
  await api('POST', `/api/b/${key}/feedback`, { clientId, round: 1, anchor: { sid }, comment: 'queued before end' })
  await page.reload({ waitUntil: 'networkidle0' })

  await page.click('.sf-end-session')
  const armed = await page.evaluate(() => document.querySelector('.sf-end-session').textContent)
  assert.match(armed, /Send 1 and end\?/, 'the armed label must state what the click will do')
  assert.equal((await api('GET', `/api/b/${key}/status`)).data.status, 'open', 'one click must not end anything')

  await page.click('.sf-end-session')
  await page.waitForFunction(() => document.querySelector('.sf-end-session')?.disabled === true, { timeout: 5000 })

  assert.equal((await api('GET', `/api/b/${key}/status`)).data.status, 'ended')
  const replay = await api('GET', `/api/b/${key}/feedback?since=0`)
  assert.ok(
    replay.data.items.some((i) => i.comment === 'queued before end'),
    'a draft must be submitted by the end, not stranded by it',
  )
  await page.close()
})

test('End disarms itself rather than staying armed forever', async () => {
  const key = await openBoard()
  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  await page.click('.sf-end-session')
  assert.match(await page.evaluate(() => document.querySelector('.sf-end-session').textContent), /End session\?/)
  await page.waitForFunction(() => document.querySelector('.sf-end-session').textContent === 'End', { timeout: 8000 })
  assert.equal((await api('GET', `/api/b/${key}/status`)).data.status, 'open')
  await page.close()
})
