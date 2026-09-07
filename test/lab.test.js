import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { render, summarize } from '../templates/lab.js'
import { TemplateError } from '../templates/_html.js'

const sample = () => JSON.parse(readFileSync(new URL('./samples/lab.json', import.meta.url)))
const complete = () => {
  const data = sample()
  data.cases = data.cases.slice(0, 2)
  return data
}

test('totals come from requests; compactions are observations, not inferred from run input', () => {
  const data = complete()
  data.cases = data.cases.slice(0, 1)
  const s = summarize(data).baseline
  assert.equal(s.fields.inputTokens.value, 180000)
  assert.equal(s.requests, 3)
  assert.equal(s.fields.compactions.value, 0)
  assert.equal(s.fields.outputTokens.value, 360)
  assert.equal(s.fields.reasoningTokens.value, 120)
})

test('cost per correct task charges failed quality outcomes too', () => {
  const stats = summarize(complete())
  assert.equal(stats.baseline.correct, 2)
  assert.ok(Math.abs(stats.baseline.costPerCorrect - 1.1) < 1e-9)
  assert.equal(stats.excerpt.correct, 1)
  assert.equal(stats.excerpt.qualityFailures, 1)
  assert.ok(Math.abs(stats.excerpt.costPerCorrect - .588) < 1e-9)
  const html = render(complete())
  assert.match(html, /superseded date/)
  assert.match(html, /1 quality failures/)
  assert.match(html, /<summary>[^<]*Quality check failed/)
  assert.match(html, /check quality/)
})

test('failed attempts remain in spend and request totals', () => {
  const data = complete()
  const run = data.cases[0].runs.baseline[0]
  const retry = { ...run.requests[0], id: 'failed-attempt', status: 'error', costUsd: .1 }
  run.requests.unshift(retry)
  const stats = summarize(data).baseline
  assert.equal(stats.requests, 6)
  assert.ok(Math.abs(stats.fields.costUsd.value - 2.3) < 1e-9)
})

test('pending, missing, errored and partial records cannot render a completed cost comparison', () => {
  const data = sample()
  const stats = summarize(data)
  for (const arm of Object.values(stats)) assert.equal(arm.costPerCorrect, null)
  assert.equal(stats.compact.errors, 1)
  assert.equal(stats.baseline.pending, 1)
  assert.equal(stats.excerpt.pending, 1)
  const html = render(data)
  assert.match(html, /Not comparable yet/)
  assert.match(html, /observed · incomplete/)
  assert.match(html, /Pending — this arm has not run/)
  assert.match(html, /Unknown/)
})

test('missing one repetition blocks comparisons even when all supplied records completed', () => {
  const data = complete()
  data.repetitions = 2
  assert.equal(summarize(data).baseline.costPerCorrect, null)
  assert.equal(summarize(data).baseline.pending, 2)
})

test('unknown quality or missing charges do not become zero or passing', () => {
  const data = complete()
  data.cases[0].runs.compact[0].checks['Exact facts'].status = 'unknown'
  data.cases[0].runs.baseline[0].requests[0].costUsd = null
  const stats = summarize(data)
  assert.equal(stats.compact.correct, 1)
  assert.equal(stats.compact.costPerCorrect, null)
  assert.equal(stats.baseline.fields.costUsd.complete, false)
  assert.equal(stats.baseline.costPerCorrect, null)
})

test('a partial run ledger stays incomplete even if each supplied request has usage', () => {
  const data = complete()
  data.cases[0].runs.compact[0].accounting = 'partial'
  assert.equal(summarize(data).compact.costPerCorrect, null)
})

test('a measured zero cost stays a real zero', () => {
  const data = complete()
  for (const c of data.cases) for (const run of c.runs.baseline) for (const request of run.requests) request.costUsd = 0
  assert.equal(summarize(data).baseline.costPerCorrect, 0)
  assert.match(render(data), /Baseline cost is zero/)
})

test('latency uses completed end-to-end runs, labels sample size, excludes errors', () => {
  const stats = summarize(sample()).compact
  assert.equal(stats.latencySamples, 2)
  assert.equal(stats.p50, 7800)
  assert.equal(stats.p95, 10230)
  assert.match(render(sample()), /n=2\/3/)
})

test('invalid counters, duplicated records and missing arms fail with paths', () => {
  const mutations = [
    [(d) => { d.cases[0].runs.baseline[0].requests[0].inputTokens = -1 }, /inputTokens/],
    [(d) => { d.cases[0].runs.baseline[0].requests[0].inputTokens = 1.5 }, /inputTokens/],
    [(d) => { d.cases[0].runs.baseline[0].requests[0].cacheReadTokens = 70000 }, /exceed inclusive/],
    [(d) => { d.cases[0].runs.baseline[0].requests[0].reasoningTokens = 200 }, /reasoningTokens exceeds/],
    [(d) => { delete d.cases[0].runs.compact }, /missing "compact"/],
    [(d) => { d.cases[0].runs.baseline.push(d.cases[0].runs.baseline[0]) }, /duplicates run/],
    [(d) => { d.cases[0].runs.baseline[0].requests.push(d.cases[0].runs.baseline[0].requests[0]) }, /requests ids must be unique/],
    [(d) => { delete d.cases[0].runs.baseline[0].checks['Exact facts'] }, /missing "Exact facts"/],
    [(d) => { delete d.cases[0].runs.baseline[0].requests[0].costSource }, /costSource/],
    [(d) => { d.manifest.evidence = 'planned' }, /planned evidence/],
    [(d) => { d.arms[0].name = 'Neither' }, /reserved verdict/],
  ]
  for (const [mutate, pattern] of mutations) {
    const data = complete()
    mutate(data)
    assert.throws(() => render(data), (error) => error instanceof TemplateError && pattern.test(error.message))
  }
})

test('planned boards are honest about absent results', () => {
  const data = complete()
  data.manifest.evidence = 'planned'
  for (const c of data.cases) for (const a of data.arms) c.runs[a.id] = []
  const html = render(data)
  assert.match(html, /no results yet/)
  assert.match(html, /Not measured/)
  assert.doesNotMatch(html, /\$0\.0000/)
})

test('rendering is deterministic and escapes data and evidence', () => {
  const data = complete()
  data.title = '<img src=x onerror=alert(1)>'
  data.cases[0].runs.baseline[0].checks['Exact facts'].evidence = '<script>bad()</script>'
  const html = render(data)
  assert.equal(render(data), html)
  assert.doesNotMatch(html, /<(script|img)\b/)
  assert.match(html, /&lt;script&gt;/)
  assert.equal((html.match(/data-widget="vote"/g) || []).length, data.cases.length)
})
