import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../daemon/db.js'
import { createStore } from '../daemon/store.js'

let store
const K = 'deadbeef'

beforeEach(() => {
  store = createStore(openDb(join(mkdtempSync(join(tmpdir(), 'sf-test-')), 't.db')))
  store.createBoard({ key: K, title: 't', file: '/tmp/x.html', template: null, data_file: null })
})

const draft = (comment) =>
  store.addFeedback({ surface_key: K, round_seq: 1, client_id: 'c1', sid: 's-1', comment, excerpt: 'e' })
const widget = (value) =>
  store.addFeedback({
    surface_key: K, round_seq: 1, kind: 'widget', state: 'submitted', client_id: 'c1',
    widget_id: 'w1', widget_value: value, submitted_at: new Date().toISOString(),
  })

test('drafts are not visible to submittedSince', () => {
  draft('a')
  assert.equal(store.submittedSince(K, 0).length, 0)
  assert.equal(store.draftsForClient(K, 'c1').length, 1)
})

test('late-submitted draft renumbers past an already-acked widget id', () => {
  draft('queued early')          // id 1
  const w = widget('yes')        // id 2
  store.ack(K, 'agent-1', w.id)  // cursor 2
  const ids = store.submitDrafts(K, 'c1')
  assert.deepEqual(ids, [3])
  const delivered = store.submittedSince(K, store.cursor(K, 'agent-1'))
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].comment, 'queued early')
})

test('renumbering keeps autoincrement ahead (no id collision after submit)', () => {
  draft('a')
  widget('yes')
  store.submitDrafts(K, 'c1')     // draft renumbered to 3
  const next = widget('no')       // must not collide with 3
  assert.equal(next.id, 4)
})

test('multiple drafts submit in queue order', () => {
  draft('first')
  draft('second')
  const ids = store.submitDrafts(K, 'c1')
  assert.equal(ids.length, 2)
  const items = store.submittedSince(K, 0)
  assert.deepEqual(items.map((i) => i.comment), ['first', 'second'])
})

test('ack clamps to newest id so future items are never swallowed', () => {
  widget('yes') // id 1
  assert.equal(store.ack(K, 'agent-1', 999), 1)
  const later = widget('no')
  assert.equal(store.submittedSince(K, store.cursor(K, 'agent-1'))[0].id, later.id)
})

test('ack never moves a cursor backwards', () => {
  widget('a')
  widget('b')
  store.ack(K, 'agent-1', 2)
  assert.equal(store.ack(K, 'agent-1', 1), 2)
})

test('cursors are independent per agent', () => {
  const w = widget('yes')
  store.ack(K, 'agent-1', w.id)
  assert.equal(store.submittedSince(K, store.cursor(K, 'agent-1')).length, 0)
  assert.equal(store.submittedSince(K, store.cursor(K, 'agent-2')).length, 1)
})

test('replay is non-destructive: repeated reads return identical batches', () => {
  widget('yes')
  draft('note')
  store.submitDrafts(K, 'c1')
  const a = store.submittedSince(K, 0)
  const b = store.submittedSince(K, 0)
  assert.deepEqual(a, b)
  assert.equal(a.length, 2)
})

test('gc archives only stale ended boards', () => {
  store.setStatus(K, 'ended')
  assert.equal(store.gc(7), 0) // just touched — not stale
  store.db.prepare(`UPDATE surfaces SET updated_at = '2020-01-01T00:00:00Z' WHERE key = ?`).run(K)
  assert.equal(store.gc(7), 1)
  assert.equal(store.board(K).status, 'archived')
})

test('chat carries an optional agent callsign', () => {
  store.addChat(K, 'agent', 'with callsign', 'reviewer-agent')
  store.addChat(K, 'agent', 'no callsign')
  store.addChat(K, 'user', 'from the human')
  const [withId, withoutId, user] = store.chatFor(K)
  assert.equal(withId.agent, 'reviewer-agent')
  assert.equal(withoutId.agent, null)
  assert.equal(user.agent, null)
})

// CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so a resident
// install only gets agent_id if the migration runs.
test('opening a db that predates agent_id backfills the column', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sf-migrate-')), 'old.db')
  const old = openDb(path)
  old.exec(`DROP TABLE chat`)
  old.exec(`CREATE TABLE chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    surface_key TEXT NOT NULL REFERENCES surfaces(key),
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)
  old.prepare(`INSERT INTO surfaces (key, title, status, created_at, updated_at)
    VALUES ('old1', 't', 'open', '2020-01-01', '2020-01-01')`).run()
  old.prepare(`INSERT INTO chat (surface_key, role, text, created_at)
    VALUES ('old1', 'agent', 'pre-migration message', '2020-01-01')`).run()
  old.close()

  const migrated = createStore(openDb(path))
  const rows = migrated.chatFor('old1')
  assert.equal(rows.length, 1, 'pre-existing chat survives the migration')
  assert.equal(rows[0].text, 'pre-migration message')
  assert.equal(rows[0].agent, null)
  migrated.addChat('old1', 'agent', 'post-migration', 'agent-1')
  assert.equal(migrated.chatFor('old1')[1].agent, 'agent-1')
})
