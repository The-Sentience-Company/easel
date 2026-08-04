/* Widget clicks queue as drafts — one live draft per (widgetId, client),
   a reclick replaces it in place, and only Send delivers. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-widgets-'))
const PAGE = join(DATA_DIR, 'decisions.html')

const api = makeApi(BASE)

let daemon
let key

before(async () => {
  writeFileSync(
    PAGE,
    '<h1>Decisions</h1>' +
      '<div data-widget="decision" data-widget-id="theme"><button type="button" data-option="dark">dark</button><button type="button" data-option="light">light</button></div>' +
      '<div data-widget="vote" data-widget-id="ship"><button type="button" data-option="yes">yes</button></div>'
  )
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  const { data } = await api('POST', '/api/open', { file: PAGE, title: 'widget-only' })
  key = data.key
})

after(() => daemon?.kill())

const clickWidget = (widgetId, value, clientId = 'c1') =>
  api('POST', `/api/b/${key}/widget`, { clientId, widgetId, value })

test('a widget click creates a draft, not a submitted item', async () => {
  const { status, data } = await clickWidget('theme', 'dark')
  assert.equal(status, 200)
  assert.equal(data.state, 'draft')
  assert.equal(data.value, 'dark')
  assert.equal(data.submittedAt, undefined)
})

test('await receives nothing until Send', async () => {
  const blocked = await api('POST', `/api/b/${key}/await`, { agent: 'wd-agent', timeoutS: 1 })
  assert.equal(blocked.data.timedOut, true)
  assert.deepEqual(blocked.data.items, [])
})

test('reclicking replaces the live draft in place — never a second item', async () => {
  const first = await clickWidget('theme', 'dark')
  const second = await clickWidget('theme', 'light')
  assert.equal(second.data.id, first.data.id, 'a reclick made a new item instead of replacing the draft')
  assert.equal(second.data.value, 'light')
  const state = (await api('GET', `/api/b/${key}/state?clientId=c1`)).data
  const widgetDrafts = state.feedback.filter((i) => i.kind === 'widget' && i.state === 'draft')
  assert.equal(widgetDrafts.length, 1)
  assert.equal(widgetDrafts[0].value, 'light')
})

test('different clients hold independent drafts for the same widget', async () => {
  const other = await clickWidget('theme', 'dark', 'c2')
  const mine = (await api('GET', `/api/b/${key}/state?clientId=c1`)).data.feedback
  const theirs = (await api('GET', `/api/b/${key}/state?clientId=c2`)).data.feedback
  assert.equal(mine.filter((i) => i.kind === 'widget' && i.state === 'draft').length, 1)
  assert.equal(theirs.filter((i) => i.kind === 'widget' && i.state === 'draft').length, 1)
  await api('DELETE', `/api/b/${key}/feedback/${other.data.id}`)
})

test('Send delivers the widget draft to await; the item is frozen after', async () => {
  await clickWidget('ship', 'yes')
  const sent = await api('POST', `/api/b/${key}/send`, { clientId: 'c1' })
  assert.equal(sent.data.submitted.length, 2)
  const got = await api('POST', `/api/b/${key}/await`, { agent: 'wd-agent', timeoutS: 5 })
  const widgets = got.data.items.filter((i) => i.kind === 'widget')
  assert.deepEqual(
    widgets.map((i) => [i.widgetId, i.value]).sort(),
    [['ship', 'yes'], ['theme', 'light']]
  )
  // Send froze it: a new click on the same widget starts a fresh draft.
  const again = await clickWidget('theme', 'dark')
  assert.equal(again.data.state, 'draft')
  assert.notEqual(again.data.id, widgets.find((w) => w.widgetId === 'theme').id)
  await api('DELETE', `/api/b/${key}/feedback/${again.data.id}`)
})

test('submitted widget items are immutable — no undo window survives', async () => {
  const submitted = (await api('GET', `/api/b/${key}/state?clientId=c1`)).data.feedback.find(
    (i) => i.kind === 'widget' && i.state === 'submitted'
  )
  const del = await api('DELETE', `/api/b/${key}/feedback/${submitted.id}`)
  assert.equal(del.status, 409)
})

test('a widget click without clientId is rejected — a draft must belong to a client', async () => {
  const { status } = await api('POST', `/api/b/${key}/widget`, { widgetId: 'theme', value: 'dark' })
  assert.equal(status, 400)
})
