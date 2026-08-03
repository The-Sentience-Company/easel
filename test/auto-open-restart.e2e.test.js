/* Auto-open earns a tab only when the reader has something new to look at. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SLOW = { timeout: 120000 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A daemon whose opener writes to a file instead of launching a browser. */
function bootstrap(index, { graceMs = 1000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-autoopen-'))
  const port = portFor(import.meta.url, index)
  const base = `http://127.0.0.1:${port}`
  const openLog = join(dir, 'opened.txt')
  const stub = join(dir, 'open-stub.sh')
  writeFileSync(stub, `#!/bin/sh\necho "$1" >> "${openLog}"\n`, { mode: 0o755 })
  const opened = () =>
    existsSync(openLog) ? readFileSync(openLog, 'utf8').trim().split('\n').filter(Boolean) : []
  process.env.EASEL_OPEN_CMD = stub
  process.env.EASEL_AUTO_OPEN_COOLDOWN_MS = '500'
  process.env.EASEL_WAITING_GRACE_MS = String(graceMs)
  const api = makeApi(base)
  return {
    dir,
    port,
    base,
    api,
    opened,
    // The opener is a detached spawn, so its line lands after the request returns.
    async openedAtLeast(n) {
      for (let i = 0; i < 60 && opened().length < n; i++) await sleep(50)
      return opened()
    },
    async waitingIs(key, want) {
      for (let i = 0; i < 80; i++) {
        try {
          const { data } = await api('GET', `/api/b/${key}/status`)
          if (data.agentWaiting === want) return true
        } catch {}
        await sleep(100)
      }
      return false
    },
  }
}

test('a restart does not reopen the boards their agents were already waiting on', SLOW, async () => {
  const h = bootstrap(0)
  let daemon = startDaemon(h.port, h.dir)
  let cli
  let key
  try {
    await waitHealthy(h.base)
    const page = join(h.dir, 'p.html')
    writeFileSync(page, '<p>restart</p>')
    key = (await h.api('POST', '/api/open', { file: page, title: 'restart' })).data.key
    await h.api('POST', '/api/config', { autoOpen: true })

    // The real client: its re-attach loop is what a restart puts to the test.
    cli = spawn('node', [join(ROOT, 'cli', 'easel.js'), 'await', key, '--agent', 'restart-agent', '--timeout-s', '2'], {
      env: { ...process.env, EASEL_URL: h.base },
      stdio: 'ignore',
    })
    assert.deepEqual(await h.openedAtLeast(1), [`${h.base}/b/${key}`], 'the wait starting must open the board')
    assert.equal(await h.waitingIs(key, true), true, 'the agent is waiting before the restart')

    daemon.kill('SIGTERM')
    await sleep(600)
    daemon = startDaemon(h.port, h.dir)
    await waitHealthy(h.base)

    // The CLI re-attaches on its own; wait for the daemon to see it again.
    assert.equal(await h.waitingIs(key, true), true, 'the agent re-attaches after the restart')
    await sleep(1200) // past the cooldown, so a wrong open would have room to happen
    assert.deepEqual(h.opened(), [`${h.base}/b/${key}`], 'a re-attach after a restart must not open a tab')

    // Auto-open is not simply broken after a restart: once that wait is over, the
    // next one opens. Cancelled and past the cooldown so neither can mask it.
    cli.kill()
    await h.api('POST', `/api/b/${key}/cancel-waiting`, {})
    assert.equal(await h.waitingIs(key, false), true, 'the first wait is over')
    await sleep(700)
    await h.api('POST', `/api/b/${key}/await`, { agent: 'fresh-agent', timeoutS: 1 })
    assert.equal((await h.openedAtLeast(2)).length, 2, 'a genuinely new wait still opens the board')
  } finally {
    cli?.kill()
    daemon?.kill()
  }
})

// The reader answered what is on screen and the agent went back to waiting on it.
// A tab there shows them only the round they already responded to.
test('an agent that collected a reply and waits again does not reopen the board', SLOW, async () => {
  const h = bootstrap(1)
  const daemon = startDaemon(h.port, h.dir)
  try {
    await waitHealthy(h.base)
    const page = join(h.dir, 'p.html')
    writeFileSync(page, '<p>answered</p>')
    const key = (await h.api('POST', '/api/open', { file: page, title: 'answered' })).data.key
    await h.api('POST', '/api/config', { autoOpen: true })

    await h.api('POST', `/api/b/${key}/await`, { agent: 'loop-agent', timeoutS: 1 })
    assert.equal((await h.openedAtLeast(1)).length, 1, 'the first wait on a fresh round opens the board')

    // The reader has their say, and the agent collects it.
    await h.api('POST', `/api/b/${key}/chat`, { clientId: 'reader', text: 'do the thing' })
    const collected = await h.api('POST', `/api/b/${key}/await`, { agent: 'loop-agent', timeoutS: 1 })
    assert.ok(collected.data.items.length > 0, 'the agent collects the reply')

    // Back to waiting on the same round: nothing new to show, so no tab.
    await sleep(1200) // past both the cooldown and the grace
    await h.api('POST', `/api/b/${key}/await`, {
      agent: 'loop-agent', ack: collected.data.upto, timeoutS: 1,
    })
    await sleep(300)
    assert.equal(h.opened().length, 1, 'waiting again on an answered round must not reopen it')

    // A new round is new to read, so publishing does open it again.
    writeFileSync(page, '<p>answered</p><p>and revised</p>')
    await h.api('POST', `/api/b/${key}/publish`, { note: 'round 2' })
    assert.equal((await h.openedAtLeast(2)).length, 2, 'a fresh round still opens the board')
  } finally {
    daemon?.kill()
  }
})
