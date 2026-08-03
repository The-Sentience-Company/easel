/* Guards a browser property, not our own logic: these attributes survive the
   scrubber by design and stay inert only while Chrome declines to honour them. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const SINK_PORT = portFor(import.meta.url, 1)
const BASE = `http://127.0.0.1:${PORT}`
const SINK = `http://127.0.0.1:${SINK_PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-cssattr-'))
const DATA_FILE = join(DATA_DIR, 'fixture.json')

/* Outside CSS_ATTRS, and image-set() carries neither url( nor a backslash, so
   the content net does not catch them either. Both survivor conditions hold. */
const UNNETTED = [
  'mask-image', 'shape-outside', 'offset-path', 'background-image', 'border-image-source',
  'list-style-image', 'content', 'mask-border-source', 'background', 'border-image',
  '-webkit-mask-image', '-webkit-box-reflect',
]

const api = makeApi(BASE)
let daemon
let sink
let browser
let key
const hits = []

function fixtureHtml() {
  const rects = UNNETTED.map(
    (attr, i) =>
      `<rect x="${i * 12}" y="0" width="10" height="10" ${attr}='image-set("${SINK}/unnetted-${attr}" 1x)'></rect>`,
  ).join('')
  return [
    '<h1>css attribute fetch guard</h1>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40">',
    rects,
    // Inside CSS_ATTRS: proves the scrubber still runs, so a survivor above
    // survives by never being netted rather than by the scrubber being broken.
    `<rect x="70" y="0" width="10" height="10" fill='image-set("${SINK}/netted-fill" 1x)'></rect>`,
    // Outside CSS_ATTRS but carrying url(): the content net's own case.
    `<rect x="82" y="0" width="10" height="10" background-image='url("${SINK}/netted-content")'></rect>`,
    '</svg>',
    // Positive control: without it, zero requests cannot be told apart from a
    // broken observation path.
    `<img src="${SINK}/positive-control" width="1" height="1">`,
  ].join('')
}

before(async () => {
  sink = createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, { 'Content-Type': 'image/gif' })
    res.end()
  })
  await new Promise((r) => sink.listen(SINK_PORT, '127.0.0.1', r))

  writeFileSync(DATA_FILE, JSON.stringify({ title: 'css attr fetch guard', html: fixtureHtml() }))
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  key = (await api('POST', '/api/open', { template: 'page', data: DATA_FILE, title: 'css attr' })).data.key

  browser = await (await import('puppeteer')).default.launch({ headless: 'new' })
})

after(async () => {
  await browser?.close()
  daemon?.kill()
  await new Promise((r) => sink.close(r))
})

const storedHtml = async () => (await api('GET', `/api/b/${key}/state`)).data.currentRound.html

test('the un-netted attributes really do survive the sanitizer', async () => {
  const html = await storedHtml()
  for (const attr of UNNETTED) {
    assert.match(
      html,
      new RegExp(`${attr}="image-set\\(&quot;${SINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/unnetted-${attr}`),
      `${attr} must reach the DOM intact, or this test is not exercising the hole it claims to`,
    )
  }
})

test('the scrubber still runs where the attribute IS enumerated', async () => {
  const html = await storedHtml()
  assert.doesNotMatch(html, /fill="image-set/, 'fill is in CSS_ATTRS and must be scrubbed')
  assert.doesNotMatch(html, new RegExp(`fill="[^"]*${SINK_PORT}`), 'no sink URL may survive in fill')
})

test('the content net still catches a url() in an attribute outside the set', async () => {
  const html = await storedHtml()
  assert.doesNotMatch(
    html,
    new RegExp(`background-image="[^"]*url\\([^"]*${SINK_PORT}`),
    'a url() value must be scrubbed even when the attribute is not enumerated',
  )
})

test('the page can reach the sink at all (positive control)', async () => {
  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)))
  await page.close()
  assert.ok(
    hits.some((u) => u.includes('positive-control')),
    'the observation path is broken: a plainly-fetching element did not reach the sink, so a zero below would mean nothing',
  )
})

test('no un-netted attribute issues a fetch in this browser', async () => {
  const leaked = hits.filter((u) => u.includes('unnetted-') || u.includes('netted-'))
  assert.deepEqual(
    leaked,
    [],
    `Chrome now honours one of these as CSS and it fetched: ${leaked.join(', ')}. ` +
      'This is a P2 reopening DEFECT-29 family, not a test to relax.',
  )
})
