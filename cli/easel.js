#!/usr/bin/env node
// easel CLI — thin HTTP client over the daemon API (docs/api.md).
// Contract: exit 0 on success period, --json everywhere, no resident processes.

import { parseArgs } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const BASE = process.env.EASEL_URL || 'http://127.0.0.1:4400'

const USAGE = `usage:
  easel open <file> [--title T] [--json]
  easel open --template <review|eval|answer-key|page|queue> --data <file.json> [--title T] [--json]
  easel publish <key> [--note "..."] [--json]
  easel await <key> [--agent ID] [--cursor N] [--ack M] [--timeout-s T] [--json]
  easel feedback <key> [--since N] [--json]
  easel reply <key> <message> [--agent ID] [--json]
  easel status [<key>] [--json]
  easel end <key> [--reopen] [--json]
  easel gc [--older-than 7d] [--json]
  easel purge [--older-than 30d] [--json]
  easel update`

// Throws {connection: true} on transport failure, {http: true} on a non-2xx.
async function request(method, path, body, { timeoutMs } = {}) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    })
  } catch (err) {
    throw Object.assign(new Error(`daemon unreachable at ${BASE}: ${err.cause?.code || err.message}`), {
      connection: true,
      code: err.cause?.code || null,
    })
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { http: true })
  return data
}

async function call(method, path, body, opts) {
  try {
    return await request(method, path, body, opts)
  } catch (err) {
    fail(err.message)
  }
}

function fail(message) {
  console.error(`easel: ${message}`)
  process.exit(1)
}

function output(data, asJson, human) {
  if (asJson) console.log(JSON.stringify(data, null, 2))
  else console.log(human ? human(data) : JSON.stringify(data, null, 2))
}

function parseDays(spec) {
  const m = String(spec).match(/^(\d+)d?$/)
  if (!m) fail(`bad --older-than value: ${spec} (expected e.g. 7d)`)
  return Number(m[1])
}

const [cmd, ...rest] = process.argv.slice(2)

const commands = {
  async open() {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        template: { type: 'string' },
        data: { type: 'string' },
        title: { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
    })
    const body = { title: values.title }
    if (values.template) {
      if (!values.data) fail('--template needs --data')
      body.template = values.template
      body.data = resolve(values.data)
    } else {
      if (!positionals[0]) fail(USAGE)
      body.file = resolve(positionals[0])
    }
    const data = await call('POST', '/api/open', body)
    output(data, values.json, (d) => `${d.created ? 'opened' : 'already open'}: ${d.url}`)
  },

  async publish() {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { note: { type: 'string' }, agent: { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
    })
    const key = positionals[0] || fail(USAGE)
    // Identify the publisher so the daemon drops their own parked listener in-turn.
    const agent = values.agent || process.env.CLAUDE_SESSION_ID || null
    const data = await call('POST', `/api/b/${key}/publish`, { note: values.note, agent })
    output(data, values.json, (d) => `published round ${d.round}` +
      (d.listenerDropped ? `\nyour parked listener was dropped — relaunch \`easel await\`` : '') +
      (d.audit?.findings?.length ? `\naudit (advisory): ${JSON.stringify(d.audit.findings)}` : ''))
  },

  async await() {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        agent: { type: 'string' },
        cursor: { type: 'string' },
        ack: { type: 'string' },
        'timeout-s': { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
    })
    const key = positionals[0] || fail(USAGE)
    const agent = values.agent || process.env.CLAUDE_SESSION_ID
    if (!agent) fail('no agent id: pass --agent or set CLAUDE_SESSION_ID')
    // --timeout-s sizes the server long-poll window only; it never bounds the
    // total wait. The loop below re-attaches until something real happens.
    const timeoutS = values['timeout-s'] ? Number(values['timeout-s']) : 600
    if (!Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS > 3600) {
      fail(`bad --timeout-s value: ${values['timeout-s']} (window seconds, 1..3600)`)
    }
    const body = { agent, timeoutS }
    if (values.ack != null) body.ack = Number(values.ack)
    if (values.cursor != null) body.cursor = Number(values.cursor)
    let backoff = 1000
    while (true) {
      let data
      try {
        data = await request('POST', `/api/b/${key}/await`, body, { timeoutMs: (timeoutS + 30) * 1000 })
      } catch (err) {
        // An HTTP error is terminal: no such board, or 409 board ended.
        if (err.http) fail(err.message)
        // Transport drop (daemon restarting, network blip): bounded backoff, silent re-attach.
        // A refused connection never reached a daemon, so that attach still has to
        // count as the first one; anything else was in flight and already landed.
        if (err.code !== 'ECONNREFUSED') body.resumed = true
        await new Promise((r) => setTimeout(r, backoff))
        backoff = Math.min(backoff * 2, 30000)
        continue
      }
      // Every attach after one that landed continues this wait rather than starting
      // one — what keeps a daemon restart from auto-opening every live board.
      body.resumed = true
      backoff = 1000
      if (data.timedOut) continue // window expired — re-attach with the same cursor
      output(data, values.json)
      // Both are normal lifecycle events, not failures — exit 0.
      if (data.superseded) console.error('superseded by a newer await from this agent')
      if (data.dropped) console.error('dropped by a publish from this agent — relaunch after the round')
      return
    }
  },

  async feedback() {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { since: { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
    })
    const key = positionals[0] || fail(USAGE)
    const qs = values.since != null ? `?since=${Number(values.since)}` : ''
    const data = await call('GET', `/api/b/${key}/feedback${qs}`)
    output(data, values.json)
  },

  async reply() {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { json: { type: 'boolean' }, agent: { type: 'string' } },
      allowPositionals: true,
    })
    const [key, text] = positionals
    if (!key || !text) fail(USAGE)
    const agent = values.agent || process.env.CLAUDE_SESSION_ID || null
    const data = await call('POST', `/api/b/${key}/reply`, { text, agent })
    output(data, values.json, () => 'replied')
  },

  async status() {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
    })
    const data = positionals[0]
      ? await call('GET', `/api/b/${positionals[0]}/status`)
      : await call('GET', '/api/status')
    // A stale daemon serves old code silently, so say so before the payload.
    if (!values.json && data.daemon?.stale) {
      console.error(`easel: daemon is running ${data.daemon.commit}, checkout is at ${data.daemon.onDisk} — run \`easel update\``)
    }
    output(data, values.json)
  },

  async end() {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { reopen: { type: 'boolean' }, json: { type: 'boolean' } },
      allowPositionals: true,
    })
    const key = positionals[0] || fail(USAGE)
    const data = await call('POST', `/api/b/${key}/end`, { reopen: Boolean(values.reopen) })
    output(data, values.json, (d) => d.status)
  },

  async gc() {
    const { values } = parseArgs({
      args: rest,
      options: { 'older-than': { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
    })
    const data = await call('POST', '/api/gc', { olderThanDays: parseDays(values['older-than'] || '7d') })
    output(data, values.json, (d) => `archived ${d.archived}`)
  },

  async purge() {
    const { values } = parseArgs({
      args: rest,
      options: { 'older-than': { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
    })
    const data = await call('POST', '/api/purge', { olderThanDays: parseDays(values['older-than'] || '30d') })
    output(data, values.json, (d) => `purged ${d.purged}`)
  },

  // The one local (non-HTTP) command: pull + rebuild + restart the installed checkout.
  async update() {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../install/update.sh')
    const { status, error } = spawnSync('bash', [script], { stdio: 'inherit' })
    if (error) fail(error.message)
    process.exit(status ?? 1)
  },
}

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(USAGE)
  process.exit(cmd ? 0 : 1)
}
const handler = commands[cmd]
if (!handler) fail(`unknown command: ${cmd}\n${USAGE}`)
await handler()
