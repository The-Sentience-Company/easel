/* A converted diagram is routinely wider than the frame, and excalidraw opens at
   100%, so the board must zoom to fit or wide diagrams load with clipped labels. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-wbfit-'))
const SLOW = { timeout: 180000 }

const api = makeApi(BASE)
let daemon
let browser

// One node whose label is wider than the box mermaid draws for it.
const LONG_LABEL = 'graph LR\n  A[no nothing, annotate survives] --> B[b]'

// Wider than a 1200px viewport at 100% once converted: twelve chained nodes.
const WIDE = `graph LR\n${Array.from(
  { length: 12 },
  (_, i) => `  N${i}[node number ${i} with a long label] --> N${i + 1}[node number ${i + 1} with a long label]`
).join('\n')}`

const NARROW = 'graph TD\n  A[a] --> B[b]'

before(async () => {
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  browser = await (await import('puppeteer')).default.launch({ headless: 'new', args: ['--no-sandbox'] })
}, SLOW)

after(async () => {
  await browser?.close()
  daemon?.kill('SIGTERM')
})

// /api/open reuses an open board for the same file, so each test brings its own.
async function openBoard(name, mermaid) {
  const path = join(DATA_DIR, `${name}.html`)
  writeFileSync(path, `<pre class="mermaid">${mermaid}</pre>`)
  const { data } = await api('POST', '/api/open', { file: path, title: name })
  const page = await browser.newPage()
  await page.setViewport({ width: 1200, height: 800 })
  await page.goto(`${BASE}/b/${data.key}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
  await page.evaluate(() => document.querySelector('.sf-wb-open').click())
  const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
  await frame.waitForSelector('.excalidraw', { timeout: 60000 })
  await new Promise((r) => setTimeout(r, 3000))
  return { page, frame, key: data.key }
}

// Excalidraw's own reset-zoom button reports the live zoom; reading it means the
// assertion is on what the reviewer sees, not on an internal we poked.
const zoom = async (frame) =>
  Number((await frame.$eval('.reset-zoom-button', (b) => b.textContent.trim())).replace('%', ''))

test('a wide diagram opens zoomed to fit instead of clipped at 100%', SLOW, async () => {
  const { page, frame } = await openBoard('wide-fit', WIDE)
  const z = await zoom(frame)
  assert.ok(z < 100, `a diagram wider than the frame must zoom out to fit, got ${z}%`)
  assert.ok(z >= 10, `fitToContent floors at 10%, got ${z}%`)
  await page.close()
})

test('a diagram that already fits is not zoomed past 100%', SLOW, async () => {
  const { page, frame } = await openBoard('narrow-fit', NARROW)
  assert.equal(await zoom(frame), 100, 'fitToContent caps at 100%, so a small diagram stays put')
  await page.close()
})

test('Fit to diagram restores the fitted view after the reviewer zooms in', SLOW, async () => {
  const { page, frame } = await openBoard('refit', WIDE)
  const fitted = await zoom(frame)

  await frame.evaluate(() => document.querySelector('.zoom-in-button').click())
  await frame.evaluate(() => document.querySelector('.zoom-in-button').click())
  await new Promise((r) => setTimeout(r, 400))
  assert.ok((await zoom(frame)) > fitted, 'the zoom-in control must have moved the zoom')

  await frame.evaluate(() => document.querySelector('.wb-fit').click())
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(await zoom(frame), fitted, 'Fit to diagram must return to the opening view')
  await page.close()
})

// A stored drawing far wider than the viewport, so the saved-scene path has
// something that only fits if it is fitted.
const WIDE_SCENE = {
  type: 'excalidraw',
  version: 2,
  elements: Array.from({ length: 10 }, (_, i) => ({
    id: `wide-${i}`,
    type: 'rectangle',
    x: i * 600, y: 0, width: 400, height: 200,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1, roughness: 1, opacity: 100, seed: 1, version: 1, versionNonce: 1,
    isDeleted: false, groupIds: [], frameId: null, roundness: null, boundElements: [],
    updated: 1, link: null, locked: false, angle: 0, strokeStyle: 'solid',
  })),
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
}

test('a reopened saved drawing is fitted too, not just a fresh conversion', SLOW, async () => {
  const path = join(DATA_DIR, 'saved-fit.html')
  writeFileSync(path, `<pre class="mermaid">${NARROW}</pre>`)
  const { data } = await api('POST', '/api/open', { file: path, title: 'saved-fit' })
  const key = data.key
  const put = await api('PUT', `/api/b/${key}/whiteboard/0`, { scene: WIDE_SCENE, baseVersion: 0 })
  assert.equal(put.status, 200, 'the saved scene must store before it can be reopened')

  const reopened = await browser.newPage()
  await reopened.setViewport({ width: 1200, height: 800 })
  await reopened.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await reopened.waitForSelector('.sf-wb-open', { timeout: 30000 })
  await reopened.evaluate(() => document.querySelector('.sf-wb-open').click())
  const frame2 = await reopened.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
  await frame2.waitForSelector('.excalidraw', { timeout: 60000 })
  await new Promise((r) => setTimeout(r, 3000))

  const z = await zoom(frame2)
  assert.ok(z < 100, `a stored drawing wider than the frame must open fitted, got ${z}%`)
  await reopened.close()
})

/* The frame converts on init, and excalidraw sizes a label by measuring it — so
   converting before the drawing font resolves reserves too little and clips. */
test('the frame converts with the drawing font, so a long label wraps', SLOW, async () => {
  const { page, key } = await openBoard('font-ready', LONG_LABEL)

  // Autosave only fires on a change, so give it one.
  await page.mouse.click(600, 400)
  await page.keyboard.press('KeyR')
  await page.mouse.move(300, 200)
  await page.mouse.down()
  await page.mouse.move(500, 320, { steps: 8 })
  await page.mouse.up()
  await new Promise((r) => setTimeout(r, 2000))

  const stored = await api('GET', `/api/b/${key}/whiteboard/0`)
  const elements = stored.data.whiteboard?.scene?.elements || []
  const label = elements.find((el) => el.type === 'text' && String(el.text).startsWith('no nothing'))
  assert.ok(label, `the converted label must be in the saved scene: ${JSON.stringify(elements.map((e) => e.text))}`)
  assert.match(
    label.text,
    /\n/,
    `measured with the real font the label wraps; unwrapped means it was measured against a fallback: ${JSON.stringify(label.text)}`
  )
  await page.close()
})
