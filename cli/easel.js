#!/usr/bin/env node
// easel CLI — thin HTTP client over the daemon API (docs/api.md).
// Contract: exit 0 on success period, --json everywhere, no resident processes.

import { parseArgs } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { formatFindings } from '../daemon/reader-checks.js'

const BASE = process.env.EASEL_URL || 'http://127.0.0.1:4400'

const TEMPLATE_RULES = {
  queue:
    'a queue card is: one question on one line · options as buttons, each with a one-line basis, one recommended\n' +
    '· read_first = the board by the agent that did the work · a body of a few sentences · no card id or callsign without a gloss',
  review:
    'a review decision is: a question with options as buttons, each with a one-line basis, one recommended\n' +
    '· evidence goes in the detail field above the options, not on the button · no term without a gloss',
  compare:
    'a compare verdict is: pick the winning arm, or tie, or all-bad · the comparison sits above the verdict, not a pointer elsewhere\n' +
    '· no arm name or case id without a gloss at first use',
  eval:
    'a dossier verdict is: pass or needs-work after the notes · a blind compare pick: the better candidate, unlabeled\n' +
    '· a matrix best: strongest answer per row; overall verdict per case · no dataset or model id without a gloss',
  gallery:
    'a gallery vote is: pick the candidate that ships, or none of these · the image is the argument, not a description of it\n' +
    '· pin width to the size the design actually ships at · no variant name without a label',
  replay:
    'a replay verdict is: pick which arm held up on this exchange, or tie, or all-bad\n' +
    '· the user message and each arm\'s reply are above the verdict · no arm name without a gloss at first use',
  rulings:
    'a ruling is: a label and rationale, then a vote widget — accept or override\n' +
    '· skim sections (options: []) have no buttons · no label without a plain-language meaning in the teach block',
  // page has no decision UI — no rule block
}

function hasDecisions(content) {
  if (content.includes('What I need from you') || content.includes('Recommendation:')) return true
  const lines = content.split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]) && lines[i + 1].trimEnd().endsWith('?')) return true
  }
  return false
}

const USAGE = `usage:
  easel open <file.html|file.md> [--title T] [--json]
  easel open --template <review|eval|compare|replay|gallery|rulings|page|queue> --data <file.json> [--title T] [--json]
  easel publish <key> [--note "..."] [--json]
  easel await <key> [--agent ID] [--cursor N] [--ack M] [--timeout-s T] [--json]
  easel feedback <key> [--since N] [--json]
  easel reply <key> <message> [--agent ID] [--json]
  easel status [<key>] [--json]
  easel end <key> [--reopen] [--json]
  easel gc [--older-than 7d] [--json]
  easel purge [--older-than 30d] [--json]
  easel update
  easel autoupdate on [--at HH:MM] | off | status`

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

/* One clone means the daemon serves the tree you edit. Name that once, on the
   two commands that expose it, rather than leaving it to look like a bug.
   Silent under --json: callers pipe stderr in and the banner corrupts the parse. */
async function warnServingTree(asJson) {
  if (asJson) return
  let info
  try {
    info = await request('GET', '/health')
  } catch {
    return // an unreachable daemon is the next call's problem to report
  }
  const bits = []
  if (info.branch && info.branch !== 'main') bits.push(`branch ${info.branch}`)
  if (info.dirty) bits.push(`${info.dirty} uncommitted file${info.dirty === 1 ? '' : 's'}`)
  if (info.stale) bits.push(`running ${info.commit}, disk at ${info.onDisk}`)
  if (!bits.length) return
  console.error(`easel: serving from ${bits.join(', ')} — chrome/ and render/.gen are live on save`)
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
    if (!values.json) {
      if (values.template && TEMPLATE_RULES[values.template]) {
        console.log(TEMPLATE_RULES[values.template])
      } else if (!values.template && body.file?.endsWith('.md')) {
        try {
          if (hasDecisions(readFileSync(body.file, 'utf8'))) {
            console.log('this file has decisions in it — the review template gives them buttons; `easel open --template review` with the questions as decisions')
          }
        } catch {}
      }
    }
  },

  async publish() {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { note: { type: 'string' }, agent: { type: 'string' }, json: { type: 'boolean' } },
      allowPositionals: true,
    })
    const key = positionals[0] || fail(USAGE)
    await warnServingTree(values.json)
    // Identify the publisher so the daemon drops their own parked listener in-turn.
    const agent = values.agent || process.env.CLAUDE_SESSION_ID || null
    const data = await call('POST', `/api/b/${key}/publish`, { note: values.note, agent })
    output(data, values.json, (d) => (d.unchanged
      ? `nothing to publish — the source renders identical to round ${d.round}; write your changes to the registered path first (\`easel status ${key}\`)`
      : `published round ${d.round}`) +
      (d.listenerDropped ? `\nyour parked listener was dropped — relaunch \`easel await\`` : '') +
      (d.audit?.findings?.length ? `\naudit (advisory): ${JSON.stringify(d.audit.findings)}` : '') +
      (d.reader?.length ? '\n' + formatFindings(d.reader) : ''))
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
    // Before the block, not inside the loop — a re-attach must stay silent.
    await warnServingTree(values.json)
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
      if (!values.json) console.log('answer each item on the board, at its anchor, in the next round')
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

  // Local like update: the opt-in unattended updater, off until turned on.
  async autoupdate() {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { at: { type: 'string' } },
      allowPositionals: true,
    })
    const flag = { on: '--enable', off: '--disable', status: '--status' }[positionals[0]]
    if (!flag) fail(USAGE)
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../install/auto-update.sh')
    const args = [script, flag]
    if (values.at) args.push('--at', values.at)
    const { status, error } = spawnSync('bash', args, { stdio: 'inherit' })
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
