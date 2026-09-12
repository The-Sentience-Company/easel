/* Round 1 comes from open, not publish; the author must see the reader checks there too. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'sf-reader-open-'))
const api = makeApi(BASE)
let daemon

const source = (name, body) => {
  const path = join(DIR, `${name}.json`)
  writeFileSync(path, JSON.stringify(body))
  return path
}

before(async () => {
  daemon = startDaemon(PORT, DIR)
  await waitHealthy(BASE)
})
after(() => daemon?.kill())

test('open returns the reader checks for round 1', async () => {
  const wall = `<p>${'the server keeps one cursor per agent and the retry path reuses it '.repeat(20)}</p>`
  const { data } = await api('POST', '/api/open', { template: 'page', data: source('wall', { title: 'w', html: wall }) })
  assert.ok(Array.isArray(data.reader), 'reader is an array on a created board')
  assert.ok(data.reader.some((f) => f.type === 'wall'), `expected a wall finding, got ${JSON.stringify(data.reader)}`)
})

test('a board that follows the rules opens with no findings', async () => {
  const { data } = await api('POST', '/api/open', { template: 'page', data: source('clean', { title: 'c', html: '<p>one short line.</p>' }) })
  assert.deepEqual(data.reader, [])
})
