import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const pExecFile = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-e2e-'))
const PAGE = join(DATA_DIR, 'page.html')

let daemon

const api = makeApi(BASE)

function cli(...args) {
  return pExecFile('node', [join(ROOT, 'cli', 'easel.js'), ...args], {
    env: { ...process.env, EASEL_URL: BASE },
  })
}

before(async () => {
  writeFileSync(PAGE, '<h1>E2E</h1><p>para one</p>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
})

after(() => daemon?.kill())

let key

test('an oversized daemon.log is truncated at startup, a small one is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-log-'))
  const log = join(dir, 'daemon.log')
  writeFileSync(log, 'x'.repeat(6 * 1024 * 1024))
  const port = portFor(import.meta.url, 1)
  const d = startDaemon(port, dir)
  try {
    await waitHealthy(`http://127.0.0.1:${port}`)
    const { statSync } = await import('node:fs')
    // Truncation runs on the listen callback; poll briefly rather than race it.
    for (let i = 0; i < 50 && statSync(log).size > 1024; i++) await new Promise((r) => setTimeout(r, 100))
    assert.ok(statSync(log).size <= 1024, `oversized log survived startup: ${statSync(log).size} bytes`)

    writeFileSync(log, 'recent restart context')
    d.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
    const d2 = startDaemon(port, dir)
    try {
      await waitHealthy(`http://127.0.0.1:${port}`)
      assert.equal(statSync(log).size, 'recent restart context'.length, 'an under-cap log must be left alone')
    } finally {
      d2.kill()
    }
  } finally {
    d.kill()
  }
})

test('purge deletes a stale board everywhere and leaves fresh ones alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-purge-'))
  const port = portFor(import.meta.url, 2)
  const base = `http://127.0.0.1:${port}`
  const papi = makeApi(base)
  const pageFor = (n) => { const f = join(dir, `${n}.html`); writeFileSync(f, `<p>${n}</p>`); return f }

  let d = startDaemon(port, dir)
  let stale, fresh
  try {
    await waitHealthy(base)
    stale = (await papi('POST', '/api/open', { file: pageFor('stale'), title: 'stale' })).data.key
    fresh = (await papi('POST', '/api/open', { file: pageFor('fresh'), title: 'fresh' })).data.key
    await papi('POST', `/api/b/${stale}/chat`, { clientId: 'c', text: 'old chat' })
  } finally {
    d.kill('SIGTERM')
  }
  await new Promise((r) => setTimeout(r, 300))

  // Backdated with the daemon down — its WAL checkpoint on exit undoes live edits.
  const Database = (await import('better-sqlite3')).default
  const db = new Database(join(dir, 'easel.db'))
  db.prepare(`UPDATE surfaces SET updated_at = ? WHERE key = ?`).run('2026-01-01T00:00:00.000Z', stale)
  db.close()

  // An orphaned scene dir (its rm failed on some earlier purge) must heal too.
  const { mkdirSync, existsSync } = await import('node:fs')
  const orphan = join(dir, 'whiteboards', 'deadbeef')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, 'scene.json'), '{}')

  d = startDaemon(port, dir)
  try {
    await waitHealthy(base)
    const res = await papi('POST', '/api/purge', { olderThanDays: 30 })
    assert.deepEqual(res.data.keys, [stale], 'exactly the stale board must purge')
    assert.equal(existsSync(orphan), false, 'the orphaned scene dir must be swept')

    assert.equal((await papi('GET', `/api/b/${stale}/state`)).status, 404, 'a purged board must be gone')
    assert.equal((await papi('GET', `/api/b/${fresh}/state`)).status, 200, 'a fresh board must survive')

    const check = new Database(join(dir, 'easel.db'))
    for (const table of ['surfaces', 'rounds', 'chat', 'feedback', 'cursors', 'whiteboards']) {
      const col = table === 'surfaces' ? 'key' : 'surface_key'
      const left = check.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`).get(stale).n
      assert.equal(left, 0, `${table} kept ${left} rows of the purged board`)
    }
    check.close()
  } finally {
    d.kill()
  }
})

test('auto-open: off by default, opt-in opens unwatched boards on wait/publish, cooldown dedupes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sf-autoopen-'))
  const port = portFor(import.meta.url, 3)
  const base = `http://127.0.0.1:${port}`
  const papi = makeApi(base)
  const openLog = join(dir, 'opened.txt')
  const stub = join(dir, 'open-stub.sh')
  writeFileSync(stub, `#!/bin/sh\necho "$1" >> "${openLog}"\n`, { mode: 0o755 })
  const opened = () => (existsSync(openLog) ? readFileSync(openLog, 'utf8').trim().split('\n') : [])

  process.env.EASEL_OPEN_CMD = stub
  process.env.EASEL_AUTO_OPEN_COOLDOWN_MS = '300'
  process.env.EASEL_WAITING_GRACE_MS = '150'
  const d = startDaemon(port, dir)
  delete process.env.EASEL_OPEN_CMD
  delete process.env.EASEL_AUTO_OPEN_COOLDOWN_MS
  delete process.env.EASEL_WAITING_GRACE_MS
  try {
    await waitHealthy(base)
    const page = join(dir, 'p.html')
    writeFileSync(page, '<p>auto</p>')
    const k = (await papi('POST', '/api/open', { file: page, title: 'auto' })).data.key

    await papi('POST', `/api/b/${k}/await`, { agent: 'ao-agent', timeoutS: 1 })
    assert.deepEqual(opened(), [], 'default must be off')

    assert.equal((await papi('POST', '/api/config', { autoOpen: true })).status, 200)
    assert.equal((await papi('GET', '/api/config')).data.autoOpen, true)

    await new Promise((r) => setTimeout(r, 200)) // let the grace lapse: next attach is a new wait
    await papi('POST', `/api/b/${k}/await`, { agent: 'ao-agent', timeoutS: 1 })
    assert.deepEqual(opened(), [`${base}/b/${k}`], 'wait-start must open the board')

    await papi('POST', `/api/b/${k}/publish`, {})
    assert.equal(opened().length, 1, 'publish inside the cooldown must not reopen')

    await new Promise((r) => setTimeout(r, 350))
    await papi('POST', `/api/b/${k}/publish`, {})
    for (let i = 0; i < 20 && opened().length < 2; i++) await new Promise((r) => setTimeout(r, 50))
    assert.equal(opened().length, 2, 'publish after the cooldown must open again')

    // What `easel await` really does: window expires, re-attach, repeat. One wait,
    // so one tab — the expiry gap must not read as the agent leaving and returning.
    const before = opened().length
    for (let i = 0; i < 3; i++) {
      const r = await papi('POST', `/api/b/${k}/await`, { agent: 're-agent', timeoutS: 1 })
      assert.equal(r.data.timedOut, true, `window ${i} should expire, not resolve`)
      assert.equal((await papi('GET', `/api/b/${k}/status`)).data.agentWaiting, true, `waiting across ${i}`)
    }
    assert.equal(opened().length, before + 1, 're-attaching must not reopen the board')

    // Nothing re-attaches: the wait is genuinely over and the next one counts as new.
    await new Promise((r) => setTimeout(r, 250))
    assert.equal((await papi('GET', `/api/b/${k}/status`)).data.agentWaiting, false, 'wait ends after grace')
    await papi('POST', `/api/b/${k}/await`, { agent: 're-agent', timeoutS: 1 })
    assert.equal(opened().length, before + 2, 'a genuinely new wait opens again')

    // Feedback landing inside the gap: that re-attach collects and exits instead of
    // parking, so the wait is over now and must not linger for the whole grace.
    await papi('POST', `/api/b/${k}/chat`, { clientId: 'c-gap', text: 'landed in the gap' })
    const caught = await papi('POST', `/api/b/${k}/await`, { agent: 're-agent', timeoutS: 1 })
    assert.ok(caught.data.items.length > 0, 'the re-attach collects the queued feedback')
    assert.equal((await papi('GET', `/api/b/${k}/status`)).data.agentWaiting, false, 'no phantom wait')
  } finally {
    d.kill()
  }
})


test('open creates round 1; second open of same file is idempotent', async () => {
  const first = await api('POST', '/api/open', { file: PAGE, title: 'e2e' })
  assert.equal(first.status, 200)
  assert.equal(first.data.created, true)
  key = first.data.key
  const second = await api('POST', '/api/open', { file: PAGE })
  assert.equal(second.data.key, key)
  assert.equal(second.data.created, false)
})

test('publish after edit yields round 2 with a diff', async () => {
  writeFileSync(PAGE, '<h1>E2E</h1><p>para one edited</p><p>para two</p>')
  const { status, data } = await api('POST', `/api/b/${key}/publish`, { note: 'round 2' })
  assert.equal(status, 200)
  assert.equal(data.round, 2)
  assert.equal(data.diff.modified.length, 1)
  assert.equal(data.diff.added.length, 1)
})

test('await without ack re-delivers the same batch verbatim; ack stops re-delivery', async () => {
  await api('POST', `/api/b/${key}/widget`, { clientId: 'c1', widgetId: 'w1', value: 'yes' })
  await api('POST', `/api/b/${key}/send`, { clientId: 'c1' })
  const a = await api('POST', `/api/b/${key}/await`, { agent: 'e2e-agent', timeoutS: 5 })
  const b = await api('POST', `/api/b/${key}/await`, { agent: 'e2e-agent', timeoutS: 5 })
  assert.deepEqual(a.data.items, b.data.items)
  assert.equal(a.data.items.length, 1)
  const c = await api('POST', `/api/b/${key}/await`, { agent: 'e2e-agent', ack: a.data.upto, timeoutS: 1 })
  assert.deepEqual(c.data.items, [])
  assert.equal(c.data.timedOut, true)
})


test('await payload carries node id + excerpt only — no DOM snapshot, no selector chain', async () => {
  const { data } = await api('GET', `/api/b/${key}/feedback?since=0`)
  const allowed = new Set([
    'id', 'key', 'round', 'kind', 'state', 'anchor', 'excerpt', 'comment',
    'widgetId', 'value', 'text', 'createdAt', 'submittedAt',
  ])
  for (const item of data.items) {
    for (const field of Object.keys(item)) assert.ok(allowed.has(field), `unexpected field ${field}`)
    if (item.anchor) {
      for (const field of Object.keys(item.anchor)) {
        assert.ok(['sid', 'quote', 'prefix', 'suffix'].includes(field), `unexpected anchor field ${field}`)
      }
    }
    assert.ok(!JSON.stringify(item).includes('<html'), 'payload contains a DOM snapshot')
  }
})

test('drafts survive a daemon restart; cursor state survives too', async () => {
  const round2 = (await api('GET', `/api/b/${key}/state?round=2`)).data
  const sid = round2.currentRound.html.match(/<p data-sid="([^"]+)">para two/)[1]
  await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'c-restart', round: 2,
    anchor: { sid }, comment: 'durable draft',
  })
  daemon.kill()
  await new Promise((r) => setTimeout(r, 300))
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  const { data } = await api('GET', `/api/b/${key}/state?clientId=c-restart`)
  const drafts = data.feedback.filter((i) => i.state === 'draft')
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].comment, 'durable draft')
  const again = await api('POST', `/api/b/${key}/await`, { agent: 'e2e-agent', timeoutS: 1 })
  assert.equal(again.data.timedOut, true, 'acked cursor forgotten across restart')
})
test('chat with withDrafts submits queued drafts and chat as one batch', async () => {
  const before = await api('GET', `/api/b/${key}/feedback?since=0`)
  const cursor = before.data.items.at(-1)?.id ?? 0
  await api('POST', `/api/b/${key}/widget`, { clientId: 'c-wd', widgetId: 'w-wd', value: 'yes' })
  const chat = await api('POST', `/api/b/${key}/chat`, { clientId: 'c-wd', text: 'and my feedback', withDrafts: true })
  assert.equal(chat.status, 200)
  assert.equal(chat.data.submitted.length, 1, 'the queued widget draft must ride along')
  const batch = await api('POST', `/api/b/${key}/await`, { agent: 'e2e-with-drafts', cursor, timeoutS: 5 })
  assert.equal(batch.data.items.length, 2, 'one batch: draft + chat')
  assert.equal(batch.data.items[0].kind, 'widget')
  assert.equal(batch.data.items[0].state, 'submitted')
  assert.equal(batch.data.items[1].kind, 'chat')
  const empty = await api('POST', `/api/b/${key}/chat`, { clientId: 'c-wd', text: 'nothing queued', withDrafts: true })
  assert.deepEqual(empty.data.submitted, [], 'withDrafts with no drafts is a plain chat')
})


test('feedback --since replays forever without destroying', async () => {
  const one = await api('GET', `/api/b/${key}/feedback?since=0`)
  const two = await api('GET', `/api/b/${key}/feedback?since=0`)
  assert.deepEqual(one.data, two.data)
})

test('CLI: exit 0 on success, exit 1 with readable error on failure', async () => {
  const ok = await cli('status', key, '--json')
  assert.ok(JSON.parse(ok.stdout).key === key)
  await assert.rejects(cli('publish', 'ffffffff'), (err) => {
    assert.equal(err.code, 1)
    assert.match(err.stderr, /no board/)
    return true
  })
})

test('aborting a blocked await clears the waiter (agentWaiting resets)', async () => {
  const ctrl = new AbortController()
  const pending = fetch(`${BASE}/api/b/${key}/await`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'abort-agent', ack: 999, timeoutS: 60 }),
    signal: ctrl.signal,
  }).catch(() => {})
  await new Promise((r) => setTimeout(r, 300))
  let state = (await api('GET', `/api/b/${key}/state`)).data
  assert.equal(state.agentWaiting, true, 'waiter registered while blocked')
  ctrl.abort()
  await pending
  await new Promise((r) => setTimeout(r, 300))
  state = (await api('GET', `/api/b/${key}/state`)).data
  assert.equal(state.agentWaiting, false, 'waiter cleaned up after connection abort')
})

test('annotating a historical round excerpts THAT round, not WIP', async () => {
  writeFileSync(PAGE, '<h1>E2E</h1><p>para one edited</p><p>para two</p><p>wip-only text here</p>')
  await new Promise((r) => setTimeout(r, 900)) // watcher debounce → WIP forms
  const state = (await api('GET', `/api/b/${key}/state`)).data
  assert.ok(state.wip, 'wip formed from the file edit')
  const round1 = (await api('GET', `/api/b/${key}/state?round=1`)).data
  const sid = round1.currentRound.html.match(/<p data-sid="([^"]+)">para one/)[1]
  const { data: item } = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'hist-client', round: 1, anchor: { sid }, comment: 'historical note',
  })
  assert.equal(item.excerpt, 'para one', 'excerpt from round 1, not the edited/WIP text')
})

test('chrome assets demand revalidation and answer 304 to a matching etag', async () => {
  const res = await fetch(`${BASE}/assets/easel.css`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-cache', 'no-cache or open tabs paint stale chrome after a deploy')
  const etag = res.headers.get('etag')
  assert.ok(etag, 'an etag is what makes revalidation cheap')
  const again = await fetch(`${BASE}/assets/easel.css`, { headers: { 'If-None-Match': etag } })
  assert.equal(again.status, 304)
})

test('end closes the board; publish on ended board is rejected', async () => {
  const { data } = await api('POST', `/api/b/${key}/end`, {})
  assert.equal(data.status, 'ended')
  const pub = await api('POST', `/api/b/${key}/publish`, {})
  assert.equal(pub.status, 409)
})
