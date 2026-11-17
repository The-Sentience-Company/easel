/* A screenshot on the agent's disk must reach the reader: copied into the board
   at publish, served from the board, and a bad path must fail the publish
   loudly rather than ship a broken image. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-images-'))
const SRC = join(DATA_DIR, 'src')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const api = makeApi(BASE)
let daemon

before(async () => {
  mkdirSync(join(SRC, 'shots'), { recursive: true })
  writeFileSync(join(SRC, 'shots', 'before.png'), PNG)
  writeFileSync(join(SRC, 'notes.png'), 'not really an image')
  writeFileSync(join(SRC, 'shots', 'Screenshot 2026-11-17 at 10.02.png'), PNG)
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
})

after(() => daemon?.kill('SIGTERM'))

async function openMd(name, body) {
  const file = join(SRC, `${name}.md`)
  writeFileSync(file, body)
  return api('POST', '/api/open', { file, title: name })
}

test('a labelled image from disk is copied into the board and served from it', async () => {
  const opened = await openMd('figure', '# Bug\n\n![Before the fix](./shots/before.png)\n')
  assert.equal(opened.status, 200)
  const { html } = (await api('GET', `/api/b/${opened.data.key}/state`)).data.currentRound
  const src = html.match(/<img[^>]*class="sd-md-img sd-figure-img"[^>]*src="([^"]+)"/)?.[1]
  assert.match(src, new RegExp(`^/b/${opened.data.key}/files/[0-9a-f]{64}\\.png$`))
  assert.match(html, /sd-figure-label[^>]*>Before the fix</)
  const res = await fetch(BASE + src)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG)
})

test('a screenshot name with spaces works inside angle brackets', async () => {
  const opened = await openMd('spaced', '![After](<./shots/Screenshot 2026-11-17 at 10.02.png>)\n')
  assert.equal(opened.status, 200)
  const { html } = (await api('GET', `/api/b/${opened.data.key}/state`)).data.currentRound
  assert.match(html, new RegExp(`src="/b/${opened.data.key}/files/[0-9a-f]{64}\\.png"`))
})

test('a missing image file fails the publish and names the path', async () => {
  const opened = await openMd('missing', '![After](./shots/after.png)\n')
  assert.equal(opened.status, 422)
  assert.match(opened.data.error, /image not found: \.\/shots\/after\.png/)
})

test('a file that is not an image is refused, not copied', async () => {
  const opened = await openMd('fake', '![Notes](./notes.png)\n')
  assert.equal(opened.status, 422)
  assert.match(opened.data.error, /not an image: \.\/notes\.png/)
})

test('a web image is left as it was', async () => {
  const opened = await openMd('web', '![Logo|96](https://example.com/logo.png)\n')
  const { html } = (await api('GET', `/api/b/${opened.data.key}/state`)).data.currentRound
  assert.match(html, /src="https:\/\/example\.com\/logo\.png"/)
})

test('the file route serves nothing outside a board\'s own content-named files', async () => {
  const opened = await openMd('route', 'text\n')
  for (const path of [`/b/${opened.data.key}/files/..%2F..%2Feasel.db`, `/b/${opened.data.key}/files/x.png`, `/b/nokey/files/${'a'.repeat(64)}.png`]) {
    assert.equal((await fetch(BASE + path)).status, 404, path)
  }
})
