/* Islands: a data-island section's inner html leaves the page verbatim for a
   sandboxed frame; the host round keeps one empty, annotatable placeholder. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'
import { extractIslands } from '../daemon/differ.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-island-'))
const PAGE = join(DATA_DIR, 'islands.html')

const ISLAND_INNER =
  '<style>.zebra{color:teal;background:url(https://evil.example/x.png)}</style>' +
  '<div class="zebra">before <b>after</b> comparison</div>'

const api = makeApi(BASE)

let daemon
let key

before(async () => {
  writeFileSync(
    PAGE,
    '<h1>Doc</h1><p>host prose</p>' +
      `<div data-island data-island-title="Diff view" data-island-height="200">${ISLAND_INNER}</div>` +
      '<p>more host prose</p>'
  )
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  const { data } = await api('POST', '/api/open', { file: PAGE, title: 'islands' })
  key = data.key
})

after(() => daemon?.kill())

test('extractIslands pulls inner html verbatim and leaves an empty placeholder', () => {
  const { html, islands } = extractIslands(`<p>a</p><div data-island><style>x{}</style><em>y</em></div>`)
  assert.equal(islands.length, 1)
  assert.equal(islands[0].html, '<style>x{}</style><em>y</em>')
  assert.match(html, /class="sd-island"/)
  assert.match(html, /data-island-index="0"/)
  assert.doesNotMatch(html, /<style>/)
  assert.doesNotMatch(html, /<em>/)
})

test('a nested island belongs to its outermost island, not the list', () => {
  const { islands } = extractIslands('<div data-island><div data-island><i>inner</i></div></div>')
  assert.equal(islands.length, 1)
  assert.match(islands[0].html, /data-island/)
})

test('html without islands passes through untouched', () => {
  const src = '<p>plain</p>'
  const { html, islands } = extractIslands(src)
  assert.equal(html, src)
  assert.equal(islands.length, 0)
})

test('the published round holds a sid-bearing placeholder and none of the island markup', async () => {
  const state = (await api('GET', `/api/b/${key}/state?clientId=c1`)).data
  const html = state.currentRound.html
  assert.match(html, /class="sd-island"[^>]*data-island-index="0"/)
  assert.match(html, /data-island-index="0"[^>]*data-sid="|data-sid="[^"]*"[^>]*data-island-index="0"/)
  assert.doesNotMatch(html, /zebra/)
  assert.doesNotMatch(html, /<style>/)
  assert.doesNotMatch(html, /evil\.example/)
})

test('island-frame serves the verbatim content under a no-network, no-script-except-nonce CSP', async () => {
  const res = await fetch(`${BASE}/island-frame?key=${key}&index=0&round=1`)
  assert.equal(res.status, 200)
  const csp = res.headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /style-src 'unsafe-inline'/)
  assert.match(csp, /script-src 'nonce-/)
  const body = await res.text()
  assert.ok(body.includes(ISLAND_INNER), 'island html must arrive verbatim')
  assert.match(body, /easelIsland/)
})

test('an unknown island index is a 404, not an empty page', async () => {
  const res = await fetch(`${BASE}/island-frame?key=${key}&index=7&round=1`)
  assert.equal(res.status, 404)
})

test('an island-only edit produces a WIP instead of being read as no change', async () => {
  writeFileSync(
    PAGE,
    '<h1>Doc</h1><p>host prose</p>' +
      `<div data-island data-island-title="Diff view" data-island-height="200"><b>EDITED ISLAND</b></div>` +
      '<p>more host prose</p>'
  )
  // The watcher debounce is filesystem-timing; poke the render path directly.
  const before = (await api('GET', `/api/b/${key}/state?clientId=c1`)).data
  assert.equal(before.wip, null)
  await new Promise((r) => setTimeout(r, 700))
  const after = (await api('GET', `/api/b/${key}/state?clientId=c1`)).data
  assert.ok(after.wip, 'island-only change must surface as WIP')
  const res = await fetch(`${BASE}/island-frame?key=${key}&index=0&round=wip`)
  assert.ok((await res.text()).includes('EDITED ISLAND'))
})

test('an ended board still serves its island — reads survive the end', async () => {
  await api('POST', `/api/b/${key}/end`, {})
  const res = await fetch(`${BASE}/island-frame?key=${key}&index=0&round=1`)
  assert.equal(res.status, 200)
  await api('POST', `/api/b/${key}/end`, { reopen: true })
})
