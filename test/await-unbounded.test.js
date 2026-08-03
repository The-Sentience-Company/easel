/* Unbounded await: the CLI re-attaches across 600s server windows and exits
   only on real feedback, cancel, supersede, or board end. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-await-'))
const PAGE = join(DATA_DIR, 'page.html')

const api = makeApi(BASE)

let daemon
let key
let contentSid

before(async () => {
  writeFileSync(PAGE, '<h1>Await</h1><p>content</p>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  const { data } = await api('POST', '/api/open', { file: PAGE, title: 'await-e2e' })
  key = data.key
  const { data: state } = await api('GET', `/api/b/${key}/state?round=1`)
  contentSid = state.currentRound.html.match(/<p data-sid="([^"]+)">content/)[1]
})

after(() => daemon?.kill())

/** Spawn the real CLI await as a foreground child; resolves on exit.
    Pinned to the current max feedback id so earlier tests' items don't leak in. */
async function cliAwait(args) {
  const { data } = await api('GET', `/api/b/${key}/feedback?since=0`)
  const cursor = data.items.length ? data.items[data.items.length - 1].id : 0
  const child = spawn('node', [join(ROOT, 'cli', 'easel.js'), 'await', key, '--json', '--cursor', String(cursor), ...args], {
    env: { ...process.env, EASEL_URL: BASE },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const done = new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
  return { child, done }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function queueAndSend(text) {
  const fb = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'c-await', round: 1, anchor: { sid: contentSid }, comment: text,
  })
  assert.equal(fb.status, 200, `feedback draft rejected: ${JSON.stringify(fb.data)}`)
  const sent = await api('POST', `/api/b/${key}/send`, { clientId: 'c-await' })
  assert.ok(sent.data.submitted.length >= 1, 'send delivered nothing — the wait below would hang')
}

test('window expiry does not wake the agent: the CLI re-attaches and only feedback ends it', async () => {
  const run = await cliAwait(['--agent', 'unbounded-1', '--timeout-s', '1'])
  await sleep(2600) // ~2.5 one-second windows: the old CLI would have exited timedOut long ago
  const { code } = await Promise.race([run.done, sleep(10).then(() => ({ code: 'running' }))])
  assert.equal(code, 'running', 'CLI exited on a window expiry — the clock woke the agent')
  await queueAndSend('real feedback')
  const res = await run.done
  assert.equal(res.code, 0)
  const data = JSON.parse(res.stdout)
  assert.equal(data.items.length, 1)
  assert.equal(data.items[0].comment, 'real feedback')
})

test('explicit cancel ends the wait', async () => {
  // A wide window so the cancel lands while the waiter is attached (the
  // between-windows gap is milliseconds at the production 600s window).
  const run = await cliAwait(['--agent', 'unbounded-2', '--timeout-s', '30'])
  await sleep(1500)
  await api('POST', `/api/b/${key}/cancel-waiting`, {})
  const res = await run.done
  assert.equal(res.code, 0)
  assert.equal(JSON.parse(res.stdout).cancelled, true)
})

test('a new attach from the same agent supersedes the old waiter', async () => {
  const first = await cliAwait(['--agent', 'same-agent', '--timeout-s', '30'])
  await sleep(700)
  const second = await cliAwait(['--agent', 'same-agent', '--timeout-s', '1'])
  const firstRes = await Promise.race([first.done, sleep(3000).then(() => null)])
  assert.ok(firstRes, 'old waiter was not superseded by the new attach')
  assert.notEqual(firstRes.code, 0)
  assert.match(firstRes.stderr + firstRes.stdout, /supersed/i)
  // The new waiter is live and still delivers.
  assert.equal((await api('GET', `/api/b/${key}/state`)).data.agentWaiting, true)
  await queueAndSend('for the second waiter')
  const secondRes = await second.done
  assert.equal(secondRes.code, 0)
  const items = JSON.parse(secondRes.stdout).items
  assert.equal(items[items.length - 1].comment, 'for the second waiter')
})

test('different agents wait side by side — no cross-supersede', async () => {
  const a = await cliAwait(['--agent', 'agent-a', '--timeout-s', '5'])
  const b = await cliAwait(['--agent', 'agent-b', '--timeout-s', '5'])
  await sleep(1200)
  const early = await Promise.race([a.done.then(() => 'a'), b.done.then(() => 'b'), sleep(10).then(() => null)])
  assert.equal(early, null, 'a waiter exited: cross-agent supersede')
  await api('POST', `/api/b/${key}/cancel-waiting`, {})
  await a.done
  await b.done
})

test('a daemon restart is survived: the CLI re-attaches and still delivers', async () => {
  const run = await cliAwait(['--agent', 'restart-agent', '--timeout-s', '2'])
  await sleep(1000)
  daemon.kill()
  await sleep(500)
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  await queueAndSend('after the restart')
  const res = await run.done
  assert.equal(res.code, 0)
  const items = JSON.parse(res.stdout).items
  assert.equal(items[items.length - 1].comment, 'after the restart')
})

test('the fast path also supersedes a stale same-agent waiter', async () => {
  // Stale waiter parked above every id; the same agent's fresh await takes
  // the items-pending fast path and must still supersede it.
  const stale = await cliAwait(['--agent', 'fastpath-agent', '--timeout-s', '30', '--cursor', '999999'])
  await sleep(700)
  const fresh = spawn('node', [join(ROOT, 'cli', 'easel.js'), 'await', key, '--json', '--cursor', '0', '--agent', 'fastpath-agent'], {
    env: { ...process.env, EASEL_URL: BASE },
  })
  const freshDone = new Promise((r) => fresh.on('exit', (code) => r(code)))
  assert.equal(await freshDone, 0, 'fresh await did not take the fast path')
  const staleRes = await Promise.race([stale.done, sleep(3000).then(() => null)])
  assert.ok(staleRes, 'stale waiter survived a fast-path attach from the same agent')
  assert.match(staleRes.stderr + staleRes.stdout, /supersed/i)
})

test('ending the board mid-wait resolves the attached waiter as cancelled', async () => {
  const run = await cliAwait(['--agent', 'end-agent', '--timeout-s', '30'])
  await sleep(1000)
  await api('POST', `/api/b/${key}/end`, {})
  const res = await run.done
  assert.equal(res.code, 0)
  assert.equal(JSON.parse(res.stdout).cancelled, true)
})

test('await against an already-ended board exits fast, not after a full window', async () => {
  // Wide window: only the immediate 409 can end the CLI this quickly.
  const run = await cliAwait(['--agent', 'late-agent', '--timeout-s', '600'])
  const res = await Promise.race([run.done, sleep(5000).then(() => null)])
  assert.ok(res, 'CLI still waiting on an ended board')
  assert.notEqual(res.code, 0)
  assert.match(res.stderr, /ended/)
})
