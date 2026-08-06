/* The daemon must bind before it attaches file watchers. One slow watched
   directory once delayed the bind for minutes and launchd thrashed restarts. */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SLOW_WATCH = join(HERE, 'fixtures', 'slow-watch.cjs')

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-boot-'))
const PAGE = join(DATA_DIR, 'page.html')

const BLOCK_MS = 2500
// Node start plus sqlite open; well under one blocking watch either way.
const BIND_BUDGET_MS = 1500

const api = makeApi(BASE)
let daemon
let bootKey

/** Spawns the daemon directly: this test needs env the shared harness does not pass. */
function spawnDaemon(env) {
  return spawn('node', [join(ROOT, 'daemon', 'server.js')], {
    env: { ...process.env, EASEL_PORT: String(PORT), EASEL_DATA_DIR: DATA_DIR, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Resolves the moment the port accepts a connection. */
function msUntilBound(timeoutMs) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`never bound within ${timeoutMs}ms`)), timeoutMs)
    const attempt = () => {
      const sock = connect(PORT, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); clearTimeout(deadline); resolve(Date.now() - started) })
      sock.once('error', () => { sock.destroy(); setTimeout(attempt, 10) })
    }
    attempt()
  })
}

const kill = async (proc) => {
  if (!proc) return
  proc.kill()
  await new Promise((r) => proc.once('exit', r))
}

before(async () => {
  // Seed one open board, so the restart under test has something to watch.
  writeFileSync(PAGE, '<h1>boot</h1><p>para one</p>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  const opened = await api('POST', '/api/open', { file: PAGE, title: 'boot' })
  assert.equal(opened.status, 200, 'fixture board did not open')
  bootKey = opened.data.key
  await kill(daemon)
  daemon = null
})

after(async () => {
  await kill(daemon)
  rmSync(DATA_DIR, { recursive: true, force: true })
})

describe('a slow watcher cannot delay the bind', () => {
  test('the port accepts connections long before a blocking watch finishes',
    { timeout: 60000 }, async () => {
      daemon = spawnDaemon({
        NODE_OPTIONS: `--require ${SLOW_WATCH}`,
        EASEL_TEST_WATCH_BLOCK_MS: String(BLOCK_MS),
      })
      try {
        const ms = await msUntilBound(30000)
        assert.ok(ms < BIND_BUDGET_MS,
          `bound after ${ms}ms with a ${BLOCK_MS}ms blocking watch — the watcher ran before listen`)
      } finally {
        // Without this a failed assertion leaves the port held, and every later
        // test in the file fails on EADDRINUSE instead of on its own merits.
        await kill(daemon)
        daemon = null
      }
    })

  test('the fixture really does block, or the test above proves nothing',
    { timeout: 60000 }, async () => {
      // Without this, a no-op fixture would let the assertion pass on any ordering.
      const started = Date.now()
      const proc = spawnDaemon({
        NODE_OPTIONS: `--require ${SLOW_WATCH}`,
        EASEL_TEST_WATCH_BLOCK_MS: String(BLOCK_MS),
      })
      let out = ''
      proc.stdout.on('data', (d) => { out += d })
      try {
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error(`no watcher line in: ${out}`)), 30000)
          const poll = setInterval(() => {
            if (/watching \d+ board/.test(out)) { clearInterval(poll); clearTimeout(deadline); resolve() }
          }, 20)
        })
        const elapsed = Date.now() - started
        assert.ok(elapsed >= BLOCK_MS,
          `watchers finished in ${elapsed}ms, under the ${BLOCK_MS}ms block — the fixture is not blocking`)
      } finally {
        await kill(proc)
      }
    })

  test('the bind is announced before the watchers are', { timeout: 60000 }, async () => {
    const proc = spawnDaemon({})
    let out = ''
    proc.stdout.on('data', (d) => { out += d })
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`no watcher line in: ${out}`)), 30000)
        const poll = setInterval(() => {
          if (/watching \d+ board/.test(out)) { clearInterval(poll); clearTimeout(deadline); resolve() }
        }, 20)
      })
    } finally {
      await kill(proc)
    }
    assert.ok(out.indexOf('listening on') >= 0, `no listening line in: ${out}`)
    assert.ok(out.indexOf('listening on') < out.indexOf('watching'),
      `watchers were announced before the bind:\n${out}`)
  })
})

describe('a board that cannot be watched degrades alone', () => {
  test('the daemon serves, and only that board loses live updates',
    { timeout: 60000 }, async () => {
      // A watch target whose directory is gone: fs.watch throws ENOENT here.
      const goneDir = join(DATA_DIR, 'vanished')
      mkdirSync(goneDir, { recursive: true })
      const orphan = join(goneDir, 'orphan.html')
      writeFileSync(orphan, '<h1>orphan</h1><p>x</p>')

      daemon = startDaemon(PORT, DATA_DIR)
      await waitHealthy(BASE)
      const opened = await api('POST', '/api/open', { file: orphan, title: 'orphan' })
      assert.equal(opened.status, 200)
      await kill(daemon)
      rmSync(goneDir, { recursive: true, force: true })

      daemon = spawnDaemon({})
      let err = ''
      let out = ''
      daemon.stderr.on('data', (d) => { err += d })
      daemon.stdout.on('data', (d) => { out += d })
      await waitHealthy(BASE)
      await new Promise((r) => setTimeout(r, 200))

      const healthy = await api('GET', `/api/b/${bootKey}/state`)
      assert.equal(healthy.status, 200,
        'the board with a working watch stopped serving because another one could not be watched')
      assert.match(err, /watch failed/, `no reason logged for the failed watch:\n${err}`)
      // watchBoard swallows its own errors, so the tally only works if it
      // reports them back — without this the summary calls a failure "watched".
      assert.match(out, /watching \d+ board\(s\), 1 degraded/,
        `the startup summary did not count the unwatchable board:\n${out}`)
    })
})
