import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { readBody, HttpError, DRAIN_LIMIT_BYTES, DRAIN_LIMIT_MS } from '../daemon/body.js'

const MB = 1024 * 1024

/* A fake request stream that records how far the reader consumed it. */
function fakeReq(chunks) {
  const state = { consumed: 0 }
  async function* gen() {
    for (const c of chunks) {
      state.consumed += c.length
      yield c
    }
  }
  return { req: gen(), state }
}

const rejects413 = (p) =>
  assert.rejects(p, (e) => e instanceof HttpError && e.status === 413)

describe('readBody', () => {
  test('parses a body within the limit', async () => {
    const { req } = fakeReq([Buffer.from('{"a":'), Buffer.from('1}')])
    assert.deepEqual(await readBody(req), { a: 1 })
  })

  test('empty body is an empty object', async () => {
    const { req } = fakeReq([])
    assert.deepEqual(await readBody(req), {})
  })

  test('invalid JSON is a 400 HttpError', async () => {
    const { req } = fakeReq([Buffer.from('{nope')])
    await assert.rejects(readBody(req), (e) => e instanceof HttpError && e.status === 400)
  })

  test('an oversized body is drained to the end before the 413', async () => {
    const chunks = Array.from({ length: 6 }, () => Buffer.alloc(MB, 'x'))
    const { req, state } = fakeReq(chunks)
    await rejects413(readBody(req, 2 * MB))
    assert.equal(state.consumed, 6 * MB, 'drain must consume the whole upload')
  })

  test('drain stops at its byte cap instead of consuming forever', async () => {
    const total = DRAIN_LIMIT_BYTES + 8 * MB
    const chunks = Array.from({ length: total / MB }, () => Buffer.alloc(MB, 'x'))
    const { req, state } = fakeReq(chunks)
    await rejects413(readBody(req, MB))
    assert.ok(state.consumed >= DRAIN_LIMIT_BYTES, 'must drain up to the cap')
    assert.ok(state.consumed < total, 'byte cap must abandon a never-ending upload')
  })

  test('drain gives up on a stalled upload at the time cap', async () => {
    let pendingReject
    const first = [Buffer.alloc(2 * MB, 'x')]
    const req = {
      async next() {
        if (first.length) return { value: first.shift(), done: false }
        return new Promise((_, rej) => { pendingReject = rej })
      },
      async return() { return { value: undefined, done: true } },
      destroy(err) { pendingReject?.(err) },
      [Symbol.asyncIterator]() { return this },
    }
    const out = await Promise.race([
      readBody(req, MB).then(() => 'resolved', (e) => e),
      new Promise((r) => setTimeout(r, DRAIN_LIMIT_MS + 2000, 'still hanging')),
    ])
    assert.ok(out instanceof HttpError && out.status === 413, String(out))
  })

  test('a custom max overrides the default limit', async () => {
    const { req } = fakeReq([Buffer.from(JSON.stringify({ big: 'y'.repeat(2 * MB) }))])
    const body = await readBody(req, 4 * MB)
    assert.equal(body.big.length, 2 * MB)
  })
})
