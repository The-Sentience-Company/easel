/* An ended board must refuse every write: `await` 409s there, so anything
   accepted would be stored where nothing can ever collect it. Reads stay legal. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'
import { ROUTES } from '../daemon/routes.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-ended-'))
const PAGE = join(DATA_DIR, 'page.html')

const api = makeApi(BASE)
let daemon
let key
let sid

before(async () => {
  writeFileSync(PAGE, '<h1>ended writes</h1><p>para one</p><div data-widget="approve" data-widget-id="w1"><div class="sd-widget-options"><button type="button" data-option="yes">yes</button></div></div>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  const opened = await api('POST', '/api/open', { file: PAGE, title: 'ended writes' })
  key = opened.data.key
  const state = await api('GET', `/api/b/${key}/state`)
  sid = state.data.currentRound.html.match(/data-sid="([^"]+)"/)[1]
})

after(() => daemon?.kill())

const annotate = (comment) =>
  api('POST', `/api/b/${key}/feedback`, { clientId: 'c1', round: 1, anchor: { sid }, comment })

test('while open, every write path is accepted', async () => {
  assert.equal((await annotate('before end')).status, 200)
  assert.equal((await api('POST', `/api/b/${key}/widget`, { clientId: 'c1', round: 1, widgetId: 'w1', value: 'yes' })).status, 200)
  assert.equal((await api('POST', `/api/b/${key}/chat`, { clientId: 'c1', text: 'hello' })).status, 200)
  assert.equal((await api('POST', `/api/b/${key}/send`, { clientId: 'c1' })).status, 200)
})

test('ending the board refuses annotation, widget, chat and send with 409', async () => {
  assert.equal((await api('POST', `/api/b/${key}/end`, {})).status, 200)

  for (const [path, body] of [
    [`/api/b/${key}/feedback`, { clientId: 'c1', round: 1, anchor: { sid }, comment: 'after end' }],
    [`/api/b/${key}/widget`, { clientId: 'c1', round: 1, widgetId: 'w1', value: 'yes' }],
    [`/api/b/${key}/chat`, { clientId: 'c1', text: 'after end' }],
    [`/api/b/${key}/send`, { clientId: 'c1' }],
  ]) {
    const res = await api('POST', path, body)
    assert.equal(res.status, 409, `${path} should 409 on an ended board`)
    assert.equal(res.data.error, 'board ended')
  }
})

/* Does its own writes rather than relying on the previous test's: an assertion
   that stops early there would otherwise leave this one nothing to catch. */
test('a write attempted after end is not stored', async () => {
  const before = (await api('GET', `/api/b/${key}/feedback?since=0`)).data.items
  assert.ok(before.length > 0, 'items submitted before the end must survive')

  await annotate('stored after end')
  await api('POST', `/api/b/${key}/chat`, { clientId: 'c1', text: 'stored after end' })
  await api('POST', `/api/b/${key}/send`, { clientId: 'c1' })

  const after = (await api('GET', `/api/b/${key}/feedback?since=0`)).data.items
  assert.equal(after.length, before.length, 'nothing may be added after the end')
  assert.ok(
    after.every((i) => i.comment !== 'stored after end' && i.text !== 'stored after end'),
    'a refused write must not appear in replay',
  )
})

test('reads stay legal on an ended board', async () => {
  const state = await api('GET', `/api/b/${key}/state`)
  assert.equal(state.status, 200)
  assert.equal(state.data.board.status, 'ended')
  assert.ok(state.data.currentRound.html.includes('ended writes'))

  const page = await fetch(`${BASE}/b/${key}`)
  assert.equal(page.status, 200)
})

test('await refuses an ended board, matching the write paths', async () => {
  const res = await api('POST', `/api/b/${key}/await`, { agent: 'a1', timeoutS: 1 })
  assert.equal(res.status, 409)
  assert.equal(res.data.error, 'board ended')
})

/* Naming the routes would let a new one ship ungated and invisible, which is the
   defect class itself, so these enumerate the table instead. */

const SCENE = { type: 'excalidraw', version: 2, elements: [], appState: { viewBackgroundColor: '#ffffff' }, files: {} }

// One probe per write route the table says an ended board must refuse.
const probes = (k, anchorSid) => ({
  publish: ['POST', `/api/b/${k}/publish`, {}],
  await: ['POST', `/api/b/${k}/await`, { agent: 'a1', timeoutS: 1 }],
  feedbackCreate: ['POST', `/api/b/${k}/feedback`, { clientId: 'c1', round: 1, anchor: { sid: anchorSid }, comment: 'probe' }],
  send: ['POST', `/api/b/${k}/send`, { clientId: 'c1' }],
  widget: ['POST', `/api/b/${k}/widget`, { clientId: 'c1', round: 1, widgetId: 'w1', value: 'yes' }],
  chat: ['POST', `/api/b/${k}/chat`, { clientId: 'c1', text: 'probe' }],
  whiteboardPut: ['PUT', `/api/b/${k}/whiteboard/0`, { scene: SCENE, baseVersion: 0 }],
  // A different diagram, so the put probe above does not leave this one stale.
  whiteboardFeedback: ['POST', `/api/b/${k}/whiteboard/1/feedback`, { clientId: 'c1', scene: SCENE, baseVersion: 0 }],
})

const gatedWrites = ROUTES.filter((r) => r.write && !r.endedOk).map((r) => r.handler)
const exemptWrites = ROUTES.filter((r) => r.write && r.endedOk).map((r) => r.handler)

async function freshBoard(title) {
  const opened = await api('POST', '/api/open', { file: PAGE, title })
  const k = opened.data.key
  const state = await api('GET', `/api/b/${k}/state`)
  return { key: k, sid: state.data.currentRound.html.match(/data-sid="([^"]+)"/)[1] }
}

test('every gated write route in the table is probed here', () => {
  assert.deepEqual(gatedWrites.slice().sort(), Object.keys(probes('k', 's')).sort())
})

/* The exemptions are decisions, not discoveries: adding one has to edit this
   list, and the reason lives beside the route in the table. */
test('the writes an ended board still accepts are exactly these', () => {
  assert.deepEqual(exemptWrites.slice().sort(), [
    'ack',
    'cancelWaiting',
    'config',
    'end',
    'feedbackDelete',
    'gc',
    'open',
    'purge',
    'reply',
    'whiteboardChannel',
  ])
  for (const route of ROUTES.filter((r) => r.write && r.endedOk)) {
    assert.ok(route.endedOk.length > 10, `${route.handler} needs a reason, not a flag`)
  }
})

test('while the board is open, every gated write route is accepted', async () => {
  const { key: k, sid: s } = await freshBoard('enumerated open')
  const table = probes(k, s)
  for (const handler of gatedWrites) {
    const [method, path, body] = table[handler]
    const res = await api(method, path, body)
    assert.ok(res.status < 400, `${handler} should be accepted while open, got ${res.status} ${JSON.stringify(res.data)}`)
  }
})

test('once ended, every gated write route in the table refuses', async () => {
  const { key: k, sid: s } = await freshBoard('enumerated ended')
  assert.equal((await api('POST', `/api/b/${k}/end`, {})).status, 200)
  const table = probes(k, s)
  for (const handler of gatedWrites) {
    const [method, path, body] = table[handler]
    const res = await api(method, path, body)
    assert.equal(res.status, 409, `${handler} must refuse an ended board`)
    // publish words it differently; the property is the refusal, not the wording.
    assert.match(res.data.error, /ended/, `${handler} must say why it refused`)
  }
})

test('a refused whiteboard write leaves the stored scene untouched', async () => {
  const { key: k } = await freshBoard('whiteboard after end')
  const drawn = { ...SCENE, elements: [{ id: 'e1', type: 'rectangle', version: 1 }] }
  assert.equal((await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: drawn, baseVersion: 0 })).status, 200)
  assert.equal((await api('POST', `/api/b/${k}/end`, {})).status, 200)

  const clobber = { ...SCENE, elements: [] }
  assert.equal((await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: clobber, baseVersion: 1 })).status, 409)
  assert.equal((await api('POST', `/api/b/${k}/whiteboard/0/feedback`, { clientId: 'c1', scene: clobber, baseVersion: 1 })).status, 409)

  const after = await api('GET', `/api/b/${k}/whiteboard/0`)
  assert.equal(after.data.whiteboard.scene.elements.length, 1, 'the drawing must survive a refused write')
  const items = (await api('GET', `/api/b/${k}/feedback?since=0`)).data.items
  assert.ok(items.every((i) => i.kind !== 'whiteboard'), 'a refused send must queue nothing')
})

test('reopen restores every write path', async () => {
  assert.equal((await api('POST', `/api/b/${key}/end`, { reopen: true })).status, 200)
  assert.equal((await annotate('after reopen')).status, 200)
  assert.equal((await api('POST', `/api/b/${key}/widget`, { clientId: 'c1', round: 1, widgetId: 'w1', value: 'yes' })).status, 200)
  assert.equal((await api('POST', `/api/b/${key}/chat`, { clientId: 'c1', text: 'after reopen' })).status, 200)
  assert.equal((await api('POST', `/api/b/${key}/send`, { clientId: 'c1' })).status, 200)
})
