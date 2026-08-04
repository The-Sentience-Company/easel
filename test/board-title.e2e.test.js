/* A board with no name reads as its key on the index, which names nothing. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'sf-title-'))
const api = makeApi(BASE)
let daemon

const source = (name, body) => {
  const path = join(DIR, `${name}.json`)
  writeFileSync(path, JSON.stringify(body))
  return path
}
const titleOf = async (key) => (await api('GET', `/api/b/${key}/status`)).data.title

before(async () => {
  daemon = startDaemon(PORT, DIR)
  await waitHealthy(BASE)
})
after(() => daemon?.kill())

test('a template board takes its name from the data when none is given', async () => {
  const data = source('named', { title: 'Extractor arms — flash vs flash-lite', html: '<p>body</p>' })
  const { data: opened } = await api('POST', '/api/open', { template: 'page', data })
  assert.equal(await titleOf(opened.key), 'Extractor arms — flash vs flash-lite')
})

test('an explicit title wins over the one in the data', async () => {
  const data = source('both', { title: 'from the data', html: '<p>body</p>' })
  const { data: opened } = await api('POST', '/api/open', { template: 'page', data, title: 'from the flag' })
  assert.equal(await titleOf(opened.key), 'from the flag')
})

test('data with no title leaves the board unnamed rather than failing', async () => {
  const { status, data: opened } = await api('POST', '/api/open', {
    template: 'page', data: source('none', { html: '<p>b</p>' }),
  })
  assert.equal(status, 200, 'a titleless board still opens')
  assert.equal(await titleOf(opened.key), null)
})

// The 50-odd boards opened before the daemon read data titles are still open.
test('a board left unnamed picks up its data title on the next publish', async () => {
  const data = source('later', { html: '<p>first</p>' })
  const { data: opened } = await api('POST', '/api/open', { template: 'page', data })
  assert.equal(await titleOf(opened.key), null)

  writeFileSync(data, JSON.stringify({ title: 'named on round 2', html: '<p>second</p>' }))
  await api('POST', `/api/b/${opened.key}/publish`, {})
  assert.equal(await titleOf(opened.key), 'named on round 2')
})

test('a publish never renames a board that already has one', async () => {
  const data = source('stable', { title: 'original', html: '<p>first</p>' })
  const { data: opened } = await api('POST', '/api/open', { template: 'page', data })
  writeFileSync(data, JSON.stringify({ title: 'renamed in the data', html: '<p>second</p>' }))
  await api('POST', `/api/b/${opened.key}/publish`, {})
  assert.equal(await titleOf(opened.key), 'original', 'the name a reader learned must not move under them')
})
