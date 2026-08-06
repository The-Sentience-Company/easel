/* Origin-wide /events stream: one connection carries every subscribed
   board's events, keeping the browser's per-origin cap unreachable. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-events-'))

let daemon

before(async () => {
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
})

after(() => daemon?.kill())

const api = makeApi(BASE)

async function openBoard(name) {
  const file = join(DATA_DIR, `${name}.html`)
  writeFileSync(file, `<h1>${name}</h1>`)
  const { status, data } = await api('POST', '/api/open', { file, title: name })
  assert.equal(status, 200)
  return data.key
}

/** Attach to an SSE URL and collect parsed frames as {event, data} objects. */
async function attachStream(path) {
  const ctrl = new AbortController()
  const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const frames = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        buf += decoder.decode(value, { stream: true })
        let at
        while ((at = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, at)
          buf = buf.slice(at + 2)
          const event = raw.match(/^event: (.*)$/m)?.[1]
          const data = raw.match(/^data: (.*)$/m)?.[1]
          frames.push({ event, data: data ? JSON.parse(data) : null })
        }
      }
    } catch {}
  })()
  const waitFor = async (pred, ms = 3000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const hit = frames.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.fail(`no frame matching within ${ms}ms; saw: ${JSON.stringify(frames)}`)
  }
  return { frames, waitFor, close: () => ctrl.abort() }
}

let k1, k2, k3

test('hello carries round and wip state for every subscribed board', async () => {
  k1 = await openBoard('one')
  k2 = await openBoard('two')
  k3 = await openBoard('three')
  const s = await attachStream(`/events?keys=${k1},${k1},${k2}`)
  const hello = await s.waitFor((f) => f.event === 'hello')
  assert.deepEqual(Object.keys(hello.data.boards).sort(), [k1, k2].sort())
  assert.equal(hello.data.boards[k1].round, 1)
  assert.equal(hello.data.boards[k1].wipAt, null)
  assert.equal(hello.data.boards[k1].agentWaiting, false)
  s.close()
})

test('events arrive key-tagged, and only for subscribed keys', async () => {
  const s = await attachStream(`/events?keys=${k1}`)
  await s.waitFor((f) => f.event === 'hello')
  // Unsubscribed key first, subscribed key second: if filtering leaked, the
  // k3 frame would land before the k1 frame we wait for.
  await api('POST', `/api/b/${k3}/chat`, { clientId: 'c', text: 'to k3' })
  await api('POST', `/api/b/${k1}/chat`, { clientId: 'c', text: 'to k1' })
  const chat = await s.waitFor((f) => f.event === 'chat')
  assert.equal(chat.data.key, k1)
  assert.equal(s.frames.filter((f) => f.data?.key === k3).length, 0)
  s.close()
})

test('an unknown key in the subscription is ignored, not an error', async () => {
  const s = await attachStream(`/events?keys=${k1},ffffffff`)
  const hello = await s.waitFor((f) => f.event === 'hello')
  assert.deepEqual(Object.keys(hello.data.boards), [k1])
  s.close()
})

/** Close propagation is async: settle until the key's count reaches n. */
async function settleTabs(key, n) {
  for (let i = 0; i < 40; i++) {
    if ((await api('GET', `/api/b/${key}/status`)).data.connectedTabs === n) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('connectedTabs counts shared-stream tabs per key and self-heals on disconnect', async () => {
  const s = await attachStream(`/events?keys=${k1},${k1},${k2}`)
  await s.waitFor((f) => f.event === 'hello')
  await settleTabs(k1, 2) // earlier tests' closed streams may still be unwinding
  assert.equal((await api('GET', `/api/b/${k1}/status`)).data.connectedTabs, 2)
  assert.equal((await api('GET', `/api/b/${k2}/status`)).data.connectedTabs, 1)
  assert.equal((await api('GET', `/api/b/${k3}/status`)).data.connectedTabs, 0)
  s.close()
  // The daemon notices the closed socket and drops the counts.
  await settleTabs(k1, 0)
  assert.equal((await api('GET', `/api/b/${k1}/status`)).data.connectedTabs, 0)
})

test('repeated keys in the subscription cannot inflate connectedTabs unboundedly', async () => {
  const s = await attachStream(`/events?keys=${Array(100).fill(k1).join(',')}`)
  await s.waitFor((f) => f.event === 'hello')
  assert.equal((await api('GET', `/api/b/${k1}/status`)).data.connectedTabs, 32)
  s.close()
  await settleTabs(k1, 0)
})

test('a shared-stream subscription marks the board live in /api/status (index rows render from it)', async () => {
  const s = await attachStream(`/events?keys=${k1}`)
  await s.waitFor((f) => f.event === 'hello')
  const row = (await api('GET', '/api/status')).data.boards.find((r) => r.key === k1)
  assert.equal(row.connectedTabs, 1)
  assert.equal(row.agentWaiting, false)
  const page = await (await fetch(`${BASE}/`)).text()
  assert.match(page, /id="rows"/)
  assert.match(page, /id="autoopen"/)
  s.close()
  await settleTabs(k1, 0)
  const idle = (await api('GET', '/api/status')).data.boards.find((r) => r.key === k1)
  assert.equal(idle.connectedTabs, 0)
})

test('every event carries the per-key seq, and hello reports it for gap detection', async () => {
  const s1 = await attachStream(`/events?keys=${k1}`)
  const hello1 = await s1.waitFor((f) => f.event === 'hello')
  const seq0 = hello1.data.boards[k1].seq
  await api('POST', `/api/b/${k1}/chat`, { clientId: 'c', text: 'bump' })
  const chat = await s1.waitFor((f) => f.event === 'chat')
  assert.equal(chat.data.seq, seq0 + 1)
  // A reconnecting client compares this hello seq to the last event seq it saw.
  const s2 = await attachStream(`/events?keys=${k1}`)
  const hello2 = await s2.waitFor((f) => f.event === 'hello')
  assert.equal(hello2.data.boards[k1].seq, seq0 + 1)
  // /state carries the same counter so a tab can adopt it from a full sync.
  assert.equal((await api('GET', `/api/b/${k1}/state`)).data.seq, seq0 + 1)
  s1.close()
  s2.close()
  await settleTabs(k1, 0)
})

test('per-key stream still works and still counts toward connectedTabs', async () => {
  const s = await attachStream(`/b/${k1}/events`)
  const hello = await s.waitFor((f) => f.event === 'hello')
  assert.equal(hello.data.round, 1)
  assert.equal(typeof hello.data.seq, 'number')
  assert.equal(hello.data.agentWaiting, false)
  assert.equal((await api('GET', `/api/b/${k1}/status`)).data.connectedTabs, 1)
  s.close()
  await settleTabs(k1, 0)
})

test('agent-waiting keys announce it right after the shared hello', async () => {
  const pending = fetch(`${BASE}/api/b/${k2}/await`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'sse-agent', timeoutS: 10 }),
  })
  await new Promise((r) => setTimeout(r, 300))
  const s = await attachStream(`/events?keys=${k1},${k2}`)
  const hello = await s.waitFor((f) => f.event === 'hello')
  assert.equal(hello.data.boards[k2].agentWaiting, true)
  assert.equal(hello.data.boards[k1].agentWaiting, false)
  s.close()
  await api('POST', `/api/b/${k2}/cancel-waiting`)
  await pending
})
