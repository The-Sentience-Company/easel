/* A screenshot pasted into a comment must reach the agent as a file it can open,
   not vanish at the textarea or bloat the await payload with base64. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-paste-'))
const PAGE = join(DATA_DIR, 'page.html')
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = `data:image/png;base64,${PNG_B64}`

const api = makeApi(BASE)
let daemon
let key
let sid

before(async () => {
  writeFileSync(PAGE, '<h1>paste</h1><p>para one</p>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  key = (await api('POST', '/api/open', { file: PAGE, title: 'paste' })).data.key
  sid = (await api('GET', `/api/b/${key}/state`)).data.currentRound.html.match(/<p data-sid="([^"]+)">para one/)[1]
})

after(() => daemon?.kill())

test('a pasted image reaches await as a file path holding the same bytes', async () => {
  const created = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'c1', anchor: { sid }, comment: 'this looks off', images: [PNG],
  })
  assert.equal(created.status, 200)
  await api('POST', `/api/b/${key}/send`, { clientId: 'c1' })
  const { data } = await api('POST', `/api/b/${key}/await`, { agent: 'paste-agent', timeoutS: 2 })
  const [item] = data.items
  assert.equal(item.comment, 'this looks off')
  assert.equal(item.images.length, 1)
  assert.match(item.images[0], /\.png$/)
  assert.deepEqual(readFileSync(item.images[0]), Buffer.from(PNG_B64, 'base64'))
  assert.ok(!JSON.stringify(data).includes(PNG_B64), 'the agent payload must carry paths, not base64')
})

test('an image alone is a complete comment', async () => {
  const res = await api('POST', `/api/b/${key}/feedback`, { clientId: 'c2', anchor: { sid }, comment: '', images: [PNG] })
  assert.equal(res.status, 200)
  assert.equal(res.data.images.length, 1)
})

test('a non-image data url is refused and writes nothing', async () => {
  const res = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'c3', anchor: { sid }, comment: 'x', images: ['data:text/html;base64,PGgxPmhpPC9oMT4='],
  })
  assert.equal(res.status, 400)
})

test('pasting into the comment box attaches the image and Queue sends it', async () => {
  const browser = await (await import('puppeteer')).default.launch({ headless: 'new' })
  try {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    if (!(await pg.evaluate("document.querySelector('.sf-annotate-toggle').classList.contains('sf-on')"))) {
      await pg.click('.sf-annotate-toggle')
    }
    await pg.click('#sf-content p')
    await pg.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }))
      document.querySelector('.sf-popover-text').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, PNG_B64)
    await pg.waitForSelector('.sf-popover-images img', { timeout: 3000 })
    await pg.type('.sf-popover-text', 'see screenshot')
    await pg.click('.sf-popover-queue')
    await pg.waitForSelector('.sf-queue-item .sf-item-images', { timeout: 3000 })

    const clientId = await pg.evaluate("localStorage.getItem('sf-client-id')")
    const drafts = (await api('GET', `/api/b/${key}/state?clientId=${clientId}`)).data.feedback
      .filter((i) => i.state === 'draft' && i.comment === 'see screenshot')
    assert.equal(drafts.length, 1, 'the queued draft is missing')
    assert.equal(drafts[0].images.length, 1)
    assert.ok(existsSync(drafts[0].images[0]))
  } finally {
    await browser.close()
  }
})
