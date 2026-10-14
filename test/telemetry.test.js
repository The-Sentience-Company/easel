/* The usage heartbeat: honours both opt-outs, sends at most once a day under one stable
   install id, and turns every failure into a return value rather than a throw. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendHeartbeat, DEFAULT_TELEMETRY_URL } from '../daemon/telemetry.js'

const DAY_MS = 24 * 60 * 60 * 1000
const T0 = 1_760_000_000_000

/** A fetch that records each call and answers with `status`, or rejects with `error`. */
function fakeFetch({ status = 204, error } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (error) throw error
    return { ok: status >= 200 && status < 300, status }
  }
  return { impl, calls }
}

const freshDir = () => mkdtempSync(join(tmpdir(), 'sf-telemetry-'))
const send = (dataDir, fetch, { env = {}, at = T0 } = {}) =>
  sendHeartbeat({ dataDir, version: '0.1.0', env, fetchImpl: fetch.impl, now: () => at })

describe('sendHeartbeat', () => {
  test('first start sends id, version and os to the default collector', async () => {
    const dir = freshDir()
    const fetch = fakeFetch()

    assert.equal(await send(dir, fetch), 'sent')

    const id = readFileSync(join(dir, 'install-id'), 'utf8').trim()
    assert.deepEqual(fetch.calls, [{ url: DEFAULT_TELEMETRY_URL, body: { installId: id, version: '0.1.0', os: process.platform } }])
    assert.match(id, /^[0-9a-f-]{36}$/)
    assert.equal(statSync(join(dir, 'install-id')).mode & 0o777, 0o600)
  })

  test('EASEL_TELEMETRY_URL overrides the collector', async () => {
    const fetch = fakeFetch()
    await send(freshDir(), fetch, { env: { EASEL_TELEMETRY_URL: 'http://127.0.0.1:1/hb' } })
    assert.equal(fetch.calls[0].url, 'http://127.0.0.1:1/hb')
  })

  test('EASEL_TELEMETRY=off sends nothing and mints no id', async () => {
    const dir = freshDir()
    const fetch = fakeFetch()

    assert.equal(await send(dir, fetch, { env: { EASEL_TELEMETRY: 'off' } }), 'off')
    assert.equal(fetch.calls.length, 0)
    assert.equal(existsSync(join(dir, 'install-id')), false)
  })

  test('the telemetry.off marker sends nothing', async () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'telemetry.off'), '')
    const fetch = fakeFetch()

    assert.equal(await send(dir, fetch), 'off')
    assert.equal(fetch.calls.length, 0)
  })

  test('a restart within a day sends nothing; the next day sends under the same id', async () => {
    const dir = freshDir()
    const fetch = fakeFetch()

    assert.equal(await send(dir, fetch, { at: T0 }), 'sent')
    assert.equal(await send(dir, fetch, { at: T0 + DAY_MS - 1 }), 'throttled')
    assert.equal(await send(dir, fetch, { at: T0 + DAY_MS }), 'sent')

    assert.equal(fetch.calls.length, 2)
    assert.equal(fetch.calls[0].body.installId, fetch.calls[1].body.installId)
  })

  test('a network failure resolves to failed and the next start tries again', async () => {
    const dir = freshDir()

    assert.equal(await send(dir, fakeFetch({ error: new TypeError('fetch failed') })), 'failed')
    assert.equal(existsSync(join(dir, 'telemetry-last')), false)
    assert.equal(await send(dir, fakeFetch(), { at: T0 + 1 }), 'sent')
  })

  test('a non-2xx answer is a failure, not a send', async () => {
    const dir = freshDir()
    assert.equal(await send(dir, fakeFetch({ status: 404 })), 'failed')
    assert.equal(existsSync(join(dir, 'telemetry-last')), false)
  })

  test('an unwritable data dir resolves to failed instead of throwing', async () => {
    const file = join(freshDir(), 'not-a-dir')
    writeFileSync(file, '')
    assert.equal(await send(file, fakeFetch()), 'failed')
  })
})
