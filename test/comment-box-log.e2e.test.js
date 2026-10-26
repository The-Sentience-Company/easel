/* A dictation that never lands in the comment box leaves nothing in the page to
   read afterwards, so the open box logs what reached it to the daemon. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-boxlog-'))
const PAGE = join(DATA_DIR, 'page.html')
const LOG = join(DATA_DIR, 'comment-box.log')

const api = makeApi(BASE)
let daemon
let key
let browser
let pg

before(async () => {
  writeFileSync(PAGE, '<section class="sd-section"><h2>One</h2><p>para one</p></section>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  key = (await api('POST', '/api/open', { file: PAGE, title: 'comment box log' })).data.key
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

async function logged(until) {
  for (let i = 0; i < 50; i++) {
    const rows = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    if (until(rows)) return rows
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`log never matched: ${existsSync(LOG) ? readFileSync(LOG, 'utf8') : 'no log file'}`)
}

test('an open comment box logs focus, dictated input and pastes, with lengths and never the text', async () => {
  await pg.click('#sf-content p')
  const cdp = await pg.target().createCDPSession()
  await cdp.send('Input.insertText', { text: 'dictated words' })
  await cdp.detach()
  await pg.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/plain', 'or many cards')
    document.querySelector('.sf-popover-text').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await pg.keyboard.press('Escape')

  const rows = await logged((r) => r.some((e) => e.type === 'close'))
  const types = rows.map((e) => e.type)
  for (const type of ['open', 'focusin', 'beforeinput', 'input', 'paste', 'paste-after', 'close']) {
    assert.ok(types.includes(type), `no ${type} event in ${JSON.stringify(types)}`)
  }
  assert.ok(rows.every((e) => e.board === key))
  const input = rows.find((e) => e.type === 'input')
  assert.equal(input.inputType, 'insertText')
  assert.equal(input.length, 'dictated words'.length)
  assert.equal(input.boxFocused, true)
  assert.equal(input.target, 'textarea.sf-popover-text')
  const paste = rows.find((e) => e.type === 'paste')
  assert.equal(paste.textLength, 'or many cards'.length)
  assert.deepEqual(paste.types, ['text/plain'])
  assert.equal(rows.find((e) => e.type === 'paste-after').prevented, false)
  const raw = readFileSync(LOG, 'utf8')
  assert.ok(!raw.includes('dictated') && !raw.includes('many cards'), 'the log must not hold what was typed')
})

test('nothing is logged while no comment box is open', async () => {
  const before = existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''
  await pg.click('.sf-title')
  await pg.keyboard.down('Meta')
  await pg.keyboard.press('v')
  await pg.keyboard.up('Meta')
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(existsSync(LOG) ? readFileSync(LOG, 'utf8') : '', before)
})
