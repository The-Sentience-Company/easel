/* CLI print behavior: template rule blocks, markdown nudge, await trailer. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const pExecFile = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-cli-prints-'))

let daemon
const api = makeApi(BASE)

function cli(...args) {
  return pExecFile('node', [join(ROOT, 'cli', 'easel.js'), ...args], {
    env: { ...process.env, EASEL_URL: BASE },
  })
}

before(async () => {
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
})

after(() => daemon?.kill())

// --- template rule blocks ---

test('open --template queue prints the spec rule block after the URL', async () => {
  const dataFile = join(DATA_DIR, 'queue.json')
  writeFileSync(dataFile, JSON.stringify({
    campaign: 'test',
    entries: [],
    review_stamps: [],
    open_prs: [],
  }))
  const { stdout } = await cli('open', '--template', 'queue', '--data', dataFile, '--title', 'Test queue')
  const lines = stdout.trim().split('\n')
  assert.ok(lines.length >= 2, 'should have URL line plus rule block')
  const ruleText = lines.slice(1).join('\n')
  assert.ok(
    ruleText.includes('a queue card is:'),
    `rule block should start with "a queue card is:", got: ${ruleText}`,
  )
  assert.ok(ruleText.includes('one question on one line'), 'rule mentions one question on one line')
  assert.ok(ruleText.includes('one-line basis, one recommended'), 'rule mentions basis and recommended')
  assert.ok(ruleText.includes('no card id or callsign without a gloss'), 'rule mentions gloss requirement')
})

test('open --template queue rule block matches spec text exactly', async () => {
  const dataFile = join(DATA_DIR, 'queue2.json')
  writeFileSync(dataFile, JSON.stringify({ campaign: 'x', entries: [], review_stamps: [], open_prs: [] }))
  const { stdout } = await cli('open', '--template', 'queue', '--data', dataFile, '--title', 'Q2')
  const lines = stdout.trim().split('\n')
  const ruleBlock = lines.slice(1).join('\n')
  const expected =
    'a queue card is: one question on one line · options as buttons, each with a one-line basis, one recommended\n' +
    '· read_first = the board by the agent that did the work · a body of a few sentences · no card id or callsign without a gloss'
  assert.equal(ruleBlock, expected)
})

test('open --template page prints no rule block (no structured decision UI)', async () => {
  const dataFile = join(DATA_DIR, 'page.json')
  writeFileSync(dataFile, JSON.stringify({ title: 'Page', html: '<p>hello</p>' }))
  const { stdout } = await cli('open', '--template', 'page', '--data', dataFile, '--title', 'Page')
  const lines = stdout.trim().split('\n')
  assert.equal(lines.length, 1, `page template should print only the URL line, got: ${stdout}`)
})

test('open --template review prints a rule block', async () => {
  const dataFile = join(DATA_DIR, 'review.json')
  writeFileSync(dataFile, JSON.stringify({
    title: 'Test',
    sections: [{ heading: 'S', body: 'body' }],
  }))
  const { stdout } = await cli('open', '--template', 'review', '--data', dataFile, '--title', 'Review')
  const lines = stdout.trim().split('\n')
  assert.ok(lines.length >= 2, 'review should have a rule block')
  assert.ok(stdout.includes('a review decision is:'), 'review rule block present')
})

// --- markdown nudge ---

test('open plain .md with "What I need from you" prints nudge', async () => {
  const mdFile = join(DATA_DIR, 'decisions1.md')
  writeFileSync(mdFile, '# Plan\n\nWhat I need from you: approve or reject.\n')
  const { stdout } = await cli('open', mdFile, '--title', 'decisions1')
  assert.ok(
    stdout.includes('this file has decisions in it'),
    `nudge should appear, got: ${stdout}`,
  )
})

test('open plain .md with "Recommendation:" prints nudge', async () => {
  const mdFile = join(DATA_DIR, 'decisions2.md')
  writeFileSync(mdFile, '# Proposal\n\nRecommendation: go with option A.\n')
  const { stdout } = await cli('open', mdFile, '--title', 'decisions2')
  assert.ok(stdout.includes('this file has decisions in it'), `nudge should appear, got: ${stdout}`)
})

test('open plain .md with question mark directly under heading prints nudge', async () => {
  const mdFile = join(DATA_DIR, 'decisions3.md')
  writeFileSync(mdFile, '# Section\nShould we do this?\n\nMore text.\n')
  const { stdout } = await cli('open', mdFile, '--title', 'decisions3')
  assert.ok(stdout.includes('this file has decisions in it'), `nudge should appear, got: ${stdout}`)
})

test('open plain .md with no decision markers prints no nudge', async () => {
  const mdFile = join(DATA_DIR, 'plain.md')
  writeFileSync(mdFile, '# Section\n\nJust a paragraph with no decisions.\n')
  const { stdout } = await cli('open', mdFile, '--title', 'plain')
  assert.ok(!stdout.includes('this file has decisions in it'), `nudge should NOT appear, got: ${stdout}`)
})

test('open .md nudge is suppressed with --json', async () => {
  const mdFile = join(DATA_DIR, 'decisions-json.md')
  writeFileSync(mdFile, '# Plan\n\nWhat I need from you: approve.\n')
  const { stdout } = await cli('open', '--json', mdFile)
  assert.ok(!stdout.includes('this file has decisions in it'), `nudge should be absent in json mode, got: ${stdout}`)
  // should be valid JSON
  assert.doesNotThrow(() => JSON.parse(stdout))
})

// --- await trailer ---

test('easel await batch output ends with the trailer line', async () => {
  // Open a board and post a chat message so await gets real feedback
  const pageFile = join(DATA_DIR, 'await-trailer.html')
  writeFileSync(pageFile, '<h1>Trailer</h1><p>text</p>')
  const { data: openData } = await api('POST', '/api/open', { file: pageFile, title: 'await-trailer' })
  const key = openData.key
  const { data: state } = await api('GET', `/api/b/${key}/state?round=1`)
  const sid = state.currentRound.html.match(/data-sid="([^"]+)"/)[1]

  const agentId = 'cli-prints-test:t1'
  // Start the await before feedback arrives
  const child = spawn('node', [join(ROOT, 'cli', 'easel.js'), 'await', key, '--agent', agentId], {
    env: { ...process.env, EASEL_URL: BASE },
  })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d))

  // Give it a moment to attach, then post feedback
  await new Promise((r) => setTimeout(r, 300))
  await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'test-client', round: 1, anchor: { sid }, comment: 'looks good',
  })
  await api('POST', `/api/b/${key}/send`, { clientId: 'test-client' })

  await new Promise((resolve) => child.on('exit', resolve))
  assert.ok(
    stdout.includes('answer each item on the board, at its anchor, in the next round'),
    `trailer line should appear in stdout, got: ${stdout}`,
  )
})

test('easel await --json batch output does NOT include trailer line', async () => {
  const pageFile = join(DATA_DIR, 'await-trailer-json.html')
  writeFileSync(pageFile, '<h1>Trailer JSON</h1><p>content</p>')
  const { data: openData } = await api('POST', '/api/open', { file: pageFile, title: 'await-trailer-json' })
  const key = openData.key
  const { data: state } = await api('GET', `/api/b/${key}/state?round=1`)
  const sid = state.currentRound.html.match(/data-sid="([^"]+)"/)[1]

  const agentId = 'cli-prints-test:t2'
  const child = spawn('node', [join(ROOT, 'cli', 'easel.js'), 'await', key, '--agent', agentId, '--json'], {
    env: { ...process.env, EASEL_URL: BASE },
  })
  let stdout = ''
  child.stdout.on('data', (d) => (stdout += d))

  await new Promise((r) => setTimeout(r, 300))
  await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'test-client-j', round: 1, anchor: { sid }, comment: 'ok',
  })
  await api('POST', `/api/b/${key}/send`, { clientId: 'test-client-j' })

  await new Promise((resolve) => child.on('exit', resolve))
  assert.ok(
    !stdout.includes('answer each item on the board'),
    `trailer should be absent in json mode, got: ${stdout}`,
  )
  // stdout should be valid JSON
  assert.doesNotThrow(() => JSON.parse(stdout.trim()))
})
