import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
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
  const logLines = () => (existsSync(openLog) ? readFileSync(openLog, 'utf8').trim().split('\n').filter(Boolean) : [])
  const opened = () => logLines().filter((l) => l.startsWith('http'))
  // Phase markers interleave with the opener's own lines, so a failure shows which
  // phase produced the surprise open rather than only that the count was wrong.
  const mark = (m) => appendFileSync(openLog, `MARK ${m}\n`)
  const trace = () => '\n' + logLines().join('\n')
  // The opener is a detached spawn writing to a file, so its effect lands after
  // the request returns — assert on it only once it has had a chance to appear.
  const openedAtLeast = async (n) => {
    for (let i = 0; i < 40 && opened().length < n; i++) await new Promise((r) => setTimeout(r, 50))
    return opened()
  }

  process.env.EASEL_OPEN_CMD = stub
  // Long enough that the publish below lands inside it, short enough that the
  // re-attach loop's 2s windows fall outside it and a lost grace would show.
  process.env.EASEL_AUTO_OPEN_COOLDOWN_MS = '1000'
  // Must dwarf this test's scheduling jitter under a loaded parallel suite, or a
  // slow re-attach reads as a new wait and the open counts drift.
  process.env.EASEL_WAITING_GRACE_MS = '5000'
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

    await new Promise((r) => setTimeout(r, 5300)) // let the grace lapse: next attach is a new wait
    // Held, not awaited: awaiting it would burn the whole window before the publish
    // below, which is what has to land inside the cooldown.
    const attach = papi('POST', `/api/b/${k}/await`, { agent: 'ao-agent', timeoutS: 1 })
    assert.deepEqual(await openedAtLeast(1), [`${base}/b/${k}`], 'wait-start must open the board')

    // Each publish edits the source: an unchanged one is a no-op round by design.
    writeFileSync(page, '<p>auto</p><p>second</p>')
    await papi('POST', `/api/b/${k}/publish`, {})
    assert.equal(opened().length, 1, 'publish inside the cooldown must not reopen')
    await attach

    await new Promise((r) => setTimeout(r, 1200))
    writeFileSync(page, '<p>auto</p><p>second</p><p>third</p>')
    await papi('POST', `/api/b/${k}/publish`, {})
    assert.equal((await openedAtLeast(2)).length, 2, 'publish after the cooldown must open again')

    // Cancel so leftover grace can't decide whether the next attach is a new wait,
    // and let the cooldown from the publish above lapse so that attach can open.
    await papi('POST', `/api/b/${k}/cancel-waiting`, {})
    await new Promise((r) => setTimeout(r, 1200))

    // Window expires, re-attach, repeat — one wait, so one tab.
    // Re-attach is issued before the status check, as the CLI does.
    mark('loop-start')
    const before = opened().length
    let pending = papi('POST', `/api/b/${k}/await`, { agent: 're-agent', timeoutS: 2 })
    for (let i = 0; i < 3; i++) {
      const r = await pending
      assert.equal(r.data.timedOut, true, `window ${i} should expire, not resolve`)
      pending = papi('POST', `/api/b/${k}/await`, { agent: 're-agent', timeoutS: 2 })
      mark(`reattached-${i}`)
      assert.equal((await papi('GET', `/api/b/${k}/status`)).data.agentWaiting, true, `waiting across ${i}`)
    }
    mark('loop-end')
    assert.equal(opened().length, before + 1, `re-attaching must not reopen the board${trace()}`)
    await pending

    // Nothing re-attaches: the wait is genuinely over and the next one counts as new.
    await new Promise((r) => setTimeout(r, 5300))
    const lapsed = (await papi('GET', `/api/b/${k}/status`)).data
    assert.equal(lapsed.agentWaiting, false, 'wait ends after grace')
    // A wait that expired and was never re-attached is a dead listener, not a
    // finished one — the board has to say so rather than just going quiet.
    assert.equal(lapsed.listenerLost?.agent, 're-agent', 'the lost listener is named')
    await papi('POST', `/api/b/${k}/await`, { agent: 're-agent', timeoutS: 1 })
    assert.equal((await openedAtLeast(before + 2)).length, before + 2, 'a genuinely new wait opens again')

    // Feedback landing inside the gap: that re-attach collects and exits instead of
    // parking, so the wait is over now and must not linger for the whole grace.
    await papi('POST', `/api/b/${k}/chat`, { clientId: 'c-gap', text: 'landed in the gap' })
    const caught = await papi('POST', `/api/b/${k}/await`, { agent: 're-agent', timeoutS: 1 })
    assert.ok(caught.data.items.length > 0, 'the re-attach collects the queued feedback')
    const collected = (await papi('GET', `/api/b/${k}/status`)).data
    assert.equal(collected.agentWaiting, false, 'no phantom wait')
    assert.equal(collected.listenerLost, null, 'collecting is a clean exit, not a lost listener')
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

test('a template render failure names the schema doc — the author usually never loaded the skill', async () => {
  const bad = join(DATA_DIR, 'bad-queue.json')
  writeFileSync(bad, JSON.stringify({ title: 'no campaign' }))
  const { status, data } = await api('POST', '/api/open', { template: 'queue', data: bad })
  assert.equal(status, 422)
  assert.match(data.error, /queue\.campaign/)
  assert.match(data.error, /docs\/templates\/queue\.md/)
})

test('publish with no source change is a no-op, not a phantom round', async () => {
  const before = (await api('GET', `/api/b/${key}/status`)).data.rounds
  const { status, data } = await api('POST', `/api/b/${key}/publish`, { note: 'round 3?' })
  assert.equal(status, 200)
  assert.equal(data.unchanged, true, 'the publisher is told nothing shipped')
  assert.equal(data.round, before, 'the round it points at is the one already published')
  assert.equal((await api('GET', `/api/b/${key}/status`)).data.rounds, before, 'no round was added')
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
    'id', 'round', 'kind', 'anchor', 'excerpt', 'comment', 'widgetId', 'value', 'text',
  ])
  assert.ok(data.items.length, 'the fixture must have produced feedback')
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

/* The trim is per item, so it scales with the batch — but only the agent may lose
   these: the queue panel draws drafts from `state`. */
test('an agent read drops the fields it cannot use; the browser read keeps them', async () => {
  const dropped = ['key', 'state', 'createdAt', 'submittedAt']
  for (const route of [`/api/b/${key}/feedback?since=0`, `/api/b/${key}/state`]) {
    const items = route.includes('feedback')
      ? (await api('GET', route)).data.items
      : (await api('GET', route)).data.feedback
    const seen = new Set(items.flatMap((i) => Object.keys(i)))
    for (const field of dropped) {
      assert.equal(seen.has(field), !route.includes('feedback'), `${field} on ${route}`)
    }
  }

  const waited = await api('POST', `/api/b/${key}/await`, { agent: 'trim-agent', timeoutS: 5 })
  assert.ok(waited.data.items.length, 'a fresh agent id must replay the backlog')
  for (const field of dropped) {
    assert.ok(!(field in waited.data.items[0]), `await still sends ${field}`)
  }
  assert.ok(waited.data.upto > 0, 'upto still reads the id the trim keeps')
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
  assert.equal(batch.data.items[1].kind, 'chat')
  // await only ever delivers submitted items, so the browser read is where the
  // draft's flip is still visible.
  const shown = (await api('GET', `/api/b/${key}/state?clientId=c-wd`)).data.feedback
  assert.equal(shown.find((i) => i.widgetId === 'w-wd').state, 'submitted')
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

// The index polls this every two seconds; unpaged it shipped every board on the
// machine each time. The CLI still asks for all of them, so paging is opt-in.
test('status pages on request and reports the whole list either way', async () => {
  for (const n of [1, 2]) {
    const page = join(DATA_DIR, `paged-${n}.html`)
    writeFileSync(page, `<h1>paged ${n}</h1>`)
    await api('POST', '/api/open', { file: page, title: `paged ${n}` })
  }
  const all = (await api('GET', '/api/status')).data
  assert.ok(all.total >= 3, `expected at least three boards, got ${all.total}`)
  assert.equal(all.boards.length, all.total, 'no limit means no slicing')
  assert.equal(all.limit, null)

  const first = (await api('GET', '/api/status?limit=2&offset=0')).data
  assert.equal(first.boards.length, 2)
  assert.equal(first.total, all.total, 'the count is of the whole list, not the page')
  const second = (await api('GET', '/api/status?limit=2&offset=2')).data
  assert.equal(second.offset, 2)
  const paged = [...first.boards, ...second.boards].map((b) => b.key)
  assert.deepEqual(paged, all.boards.slice(0, paged.length).map((b) => b.key), 'pages walk one ranked list')
  assert.equal(new Set(paged).size, paged.length, 'a board must not appear on two pages')

  // A junk limit reads as "no pagination" rather than an empty page.
  const junk = (await api('GET', '/api/status?limit=-4')).data
  assert.equal(junk.boards.length, junk.total)
})

test('health and status carry the build, and agree on it', async () => {
  const h = (await api('GET', '/health')).data
  assert.equal(h.app, 'easel')
  assert.ok(h.version, 'version present')
  assert.equal(typeof h.stale, 'boolean', 'staleness is answerable without reading git')
  // Commit drift cannot see an uncommitted edit, and chrome/ is served per request.
  assert.equal(typeof h.dirty, 'number', 'uncommitted-file count present')
  assert.ok(h.branch === null || typeof h.branch === 'string', 'branch is a name or null')
  const build = {
    version: h.version, commit: h.commit, onDisk: h.onDisk, stale: h.stale,
    branch: h.branch, dirty: h.dirty,
  }
  const s = (await api('GET', '/api/status')).data
  assert.deepEqual(s.daemon, build)
  // `easel status <key>` reads this route, so the warning has to reach it too.
  const one = (await api('GET', `/api/b/${key}/status`)).data
  assert.deepEqual(one.daemon, build, 'keyed status carries the build as well')
  // In a clean checkout the running build is the one on disk.
  if (h.commit) assert.equal(h.stale, h.commit !== h.onDisk)
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
