/* A board opened through a tunnel (Tailscale Serve, an SSH forward) sends its
   links to the daemon back through the tunnel's address instead of 127.0.0.1. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const TUNNEL = `http://easel-tunnel.test:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-tunnel-links-'))

const api = makeApi(BASE)
let daemon
let browser
let key

before(async () => {
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  // The tunnel hostname resolves to the daemon, and counts as secure like the real tunnel's HTTPS.
  browser = await (await import('puppeteer')).default.launch({
    headless: 'new',
    args: [`--host-resolver-rules=MAP easel-tunnel.test 127.0.0.1`, `--unsafely-treat-insecure-origin-as-secure=${TUNNEL}`],
  })
  const file = join(DATA_DIR, 'links.html')
  writeFileSync(file, `<h1>Links</h1>
<p><a id="malformed" href="http://[::1">unparsable</a></p>
<p><a id="board"href="http://127.0.0.1:${PORT}/b/other?round=2#s3">board</a></p>
<p><a id="localhost" href="http://localhost:${PORT}/">dashboard</a></p>
<p><a id="elsewhere" href="http://127.0.0.1:5173/app">dev server</a></p>
<p><a id="external" href="https://example.com/x">external</a></p>`)
  key = (await api('POST', '/api/open', { file, title: 'Links' })).data.key
})

after(async () => {
  await browser?.close()
  daemon?.kill()
})

/** The URL a click on the link would navigate to, without leaving the page. */
async function clickedHref(origin, id) {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/b/${key}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector(`#${id}`)
    return await page.evaluate((id) => {
      const link = document.getElementById(id)
      let href
      link.addEventListener('click', (e) => { href = link.href; e.preventDefault() }, { once: true })
      link.click()
      return href
    }, id)
  } finally {
    await page.close()
  }
}

/** The href as middle-click, long-press, copy link and drag read it: no click event fires. */
async function hrefAtRest(origin, id) {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/b/${key}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector(`#${id}`)
    return await page.$eval(`#${id}`, (link) => link.href)
  } finally {
    await page.close()
  }
}

/** The URL a middle-click on the link opens in a new tab. */
async function middleClickedUrl(origin, id) {
  const page = await browser.newPage()
  try {
    await page.goto(`${origin}/b/${key}`, { waitUntil: 'networkidle0' })
    await page.waitForSelector(`#${id}`)
    // A middle-clicked tab has no opener, so it is caught as the next target created.
    const opened = new Promise((resolve) => browser.once('targetcreated', resolve))
    await page.click(`#${id}`, { button: 'middle' })
    const target = await opened
    const url = target.url()
    await (await target.page())?.close()
    return url
  } finally {
    await page.close()
  }
}

test('links to the daemon follow the tunnel address', async () => {
  assert.equal(await clickedHref(TUNNEL, 'board'), `${TUNNEL}/b/other?round=2#s3`)
  assert.equal(await clickedHref(TUNNEL, 'localhost'), `${TUNNEL}/`)
})

test('the href itself carries the tunnel address, so every way of opening it does', async () => {
  assert.equal(await hrefAtRest(TUNNEL, 'board'), `${TUNNEL}/b/other?round=2#s3`)
  assert.equal(await hrefAtRest(TUNNEL, 'localhost'), `${TUNNEL}/`)
  assert.equal(await hrefAtRest(TUNNEL, 'elsewhere'), 'http://127.0.0.1:5173/app')
  assert.equal(await hrefAtRest(TUNNEL, 'external'), 'https://example.com/x')
})

test('a middle-click opens the tunnel address in the new tab', async () => {
  assert.equal(await middleClickedUrl(TUNNEL, 'board'), `${TUNNEL}/b/other?round=2#s3`)
})

test('a link arriving in a new round carries the tunnel address without a reload', async () => {
  const file = join(DATA_DIR, 'rounds.html')
  writeFileSync(file, '<h1>Rounds</h1><p>first round</p>')
  const roundsKey = (await api('POST', '/api/open', { file, title: 'Rounds' })).data.key
  const page = await browser.newPage()
  try {
    await page.goto(`${TUNNEL}/b/${roundsKey}`, { waitUntil: 'networkidle0' })
    writeFileSync(file, `<h1>Rounds</h1><p><a id="fresh" href="http://127.0.0.1:${PORT}/b/fresh">fresh</a></p>`)
    await api('POST', `/api/b/${roundsKey}/publish`, { note: 'round 2' })
    await page.waitForSelector('#fresh')
    assert.equal(await page.$eval('#fresh', (link) => link.href), `${TUNNEL}/b/fresh`)
  } finally {
    await page.close()
  }
})

test('links to other ports and other sites are left alone', async () => {
  assert.equal(await clickedHref(TUNNEL, 'elsewhere'), 'http://127.0.0.1:5173/app')
  assert.equal(await clickedHref(TUNNEL, 'external'), 'https://example.com/x')
})

test('on the Mac itself nothing is rewritten', async () => {
  assert.equal(await clickedHref(BASE, 'board'), `${BASE}/b/other?round=2#s3`)
})
