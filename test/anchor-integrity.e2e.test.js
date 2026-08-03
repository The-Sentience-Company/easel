// Anchor integrity across rounds: a removed node's sid never migrates onto new
// content, and feedback on a sid absent from its round is rejected, not orphaned.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-anchor-'))
const PAGE = join(DATA_DIR, 'page.html')

const PAYMENT = 'We should raise the retry budget to five attempts for the payment webhook.'
const AUTOVAC = 'Postgres autovacuum should run nightly on the events table.'

let daemon
let key
let paymentSid

const api = makeApi(BASE)

async function roundHtml(round) {
  const { data } = await api('GET', `/api/b/${key}/state?round=${round}`)
  return data.currentRound.html
}

async function feedbackCount() {
  const { data } = await api('GET', `/api/b/${key}/state?clientId=reviewer`)
  return data.feedback.length
}

before(async () => {
  writeFileSync(PAGE, `<p>intro stays put</p><p>${PAYMENT}</p>`)
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  const { data } = await api('POST', '/api/open', { file: PAGE, title: 'anchor-integrity' })
  key = data.key
})

after(() => daemon?.kill())

test('an annotation lands on the payment paragraph in round 1', async () => {
  const html = await roundHtml(1)
  paymentSid = html.match(/<p data-sid="(s-[0-9a-f]+)">We should raise/)[1]
  const { status, data } = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'reviewer', round: 1, anchor: { sid: paymentSid },
    comment: 'Five is too many, three is the ceiling we agreed.',
  })
  assert.equal(status, 200)
  assert.match(data.excerpt, /retry budget/)
})

test('remove + unrelated same-tag add: diff reports the removal, sid does not migrate', async () => {
  writeFileSync(PAGE, `<p>intro stays put</p><p>${AUTOVAC}</p>`)
  const { status, data } = await api('POST', `/api/b/${key}/publish`, { note: 'round 2' })
  assert.equal(status, 200)
  assert.deepEqual(data.diff.removed, [paymentSid])
  assert.match(data.diff.removedDetail[0].excerpt, /retry budget/)
  assert.deepEqual(data.diff.modified, [])
  assert.equal(data.diff.added.length, 1)
  assert.notEqual(data.diff.added[0], paymentSid)
  const html = await roundHtml(2)
  assert.ok(!html.includes(paymentSid), 'removed sid still present in round 2 html')
})

test('the round-1 annotation stays anchored to round 1, not the new paragraph', async () => {
  const { data } = await api('GET', `/api/b/${key}/state?clientId=reviewer`)
  const note = data.feedback.find((i) => i.comment.startsWith('Five is too many'))
  assert.equal(note.round, 1)
  assert.match(note.excerpt, /retry budget/)
  assert.ok(!/autovacuum/.test(note.excerpt))
})

test('carried-forward flow stays legal: annotating the removed node against round 1 succeeds', async () => {
  const { status, data } = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'reviewer', round: 1, anchor: { sid: paymentSid }, comment: 'still relevant historically',
  })
  assert.equal(status, 200)
  assert.match(data.excerpt, /retry budget/)
})

test('the removed sid filed against the CURRENT round is rejected and stores nothing', async () => {
  const count = await feedbackCount()
  const { status, data } = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'reviewer', round: 2, anchor: { sid: paymentSid }, comment: 'should not attach',
  })
  assert.equal(status, 400)
  assert.match(data.error, new RegExp(paymentSid))
  assert.equal(await feedbackCount(), count)
})

test('a bogus sid is rejected with the sid named, and stores nothing', async () => {
  const count = await feedbackCount()
  const { status, data } = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'reviewer', round: 2, anchor: { sid: 's-DOES-NOT-EXIST' }, comment: 'a4 bogus-sid probe',
  })
  assert.equal(status, 400)
  assert.match(data.error, /s-DOES-NOT-EXIST/)
  assert.equal(await feedbackCount(), count)
})

test('a selection annotation (quote anchor) also stays on its round after remove+add', async () => {
  const { status, data } = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'reviewer', round: 1,
    anchor: { sid: paymentSid, quote: 'five attempts', prefix: 'retry budget to ', suffix: ' for the payment' },
    comment: 'selection-anchored note',
  })
  assert.equal(status, 200)
  assert.match(data.excerpt, /retry budget/)
  assert.equal(data.round, 1)
  const html = await roundHtml(2)
  assert.ok(!html.includes(paymentSid), 'selection anchor sid resolvable in round 2 — migration')
})

test('a WIP-only sid on the latest round is accepted (pre-publish annotation flow)', async () => {
  writeFileSync(PAGE, `<p>intro stays put</p><p>${AUTOVAC}</p><p>wip-only closing thoughts</p>`)
  await new Promise((r) => setTimeout(r, 900))
  const { data: state } = await api('GET', `/api/b/${key}/state`)
  assert.ok(state.wip, 'wip formed from the file edit')
  const wipSid = state.wip.html.match(/<p data-sid="(s-[0-9a-f]+)">wip-only/)[1]
  const { status, data } = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'reviewer', round: 2, anchor: { sid: wipSid }, comment: 'note on unpublished text',
  })
  assert.equal(status, 200)
  assert.match(data.excerpt, /wip-only closing/)
})
