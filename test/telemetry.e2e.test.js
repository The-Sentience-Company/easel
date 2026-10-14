/* The real daemon pings the collector once on boot, and a restart the same day stays quiet. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBundleFresh, waitHealthy, portFor } from './harness.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = portFor(import.meta.url, 0)
const COLLECTOR_PORT = portFor(import.meta.url, 1)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-telemetry-e2e-'))
// Long enough for a ping fired at boot to land on a loopback collector.
const SETTLE_MS = 750

const pings = []
let collector

function spawnDaemon() {
  return spawn('node', [join(ROOT, 'daemon', 'server.js')], {
    env: {
      ...process.env,
      EASEL_PORT: String(PORT),
      EASEL_DATA_DIR: DATA_DIR,
      EASEL_TELEMETRY: '',
      EASEL_TELEMETRY_URL: `http://127.0.0.1:${COLLECTOR_PORT}/telemetry/easel-heartbeat`,
    },
    stdio: 'ignore',
  })
}

async function bootAndStop() {
  const daemon = spawnDaemon()
  await waitHealthy(BASE)
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  daemon.kill()
  await new Promise((r) => daemon.once('exit', r))
}

before(async () => {
  assertBundleFresh()
  collector = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      pings.push({ method: req.method, url: req.url, body: JSON.parse(body) })
      res.writeHead(204).end()
    })
  })
  await new Promise((r) => collector.listen(COLLECTOR_PORT, '127.0.0.1', r))
})

after(() => collector.close())

test('boot sends one heartbeat; a same-day restart sends none', async () => {
  await bootAndStop()
  assert.equal(pings.length, 1)
  assert.equal(pings[0].method, 'POST')
  assert.equal(pings[0].url, '/telemetry/easel-heartbeat')
  assert.deepEqual(Object.keys(pings[0].body).sort(), ['installId', 'os', 'version'])

  await bootAndStop()
  assert.equal(pings.length, 1)
})
