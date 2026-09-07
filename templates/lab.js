import { esc, markdown, table as htmlTable, widget, badge, requireObject, requireArray, requireString, fail } from './_html.js'

export const name = 'lab'

const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens']
const REQUEST_FIELDS = [...TOKEN_FIELDS, 'costUsd', 'latencyMs', 'compactions']
const STATES = ['pending', 'running', 'complete', 'error']
const CHECK_STATES = ['pass', 'fail', 'unknown']
const known = (v) => typeof v === 'number' && Number.isFinite(v)
const num = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 2 })
const money = (v) => `$${v.toFixed(4)}`
const seconds = (v) => `${(v / 1000).toFixed(2)}s`
const table = (columns, rows) => htmlTable(columns, rows.map((row) => row.map(esc)))

function number(value, path, integer = false) {
  if (value == null) return
  if (!known(value) || value < 0 || (integer && !Number.isSafeInteger(value))) fail(`${path} must be a non-negative ${integer ? 'integer' : 'number'} or null`)
}

function exactKeys(value, keys, path) {
  requireObject(value, path)
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${path} is missing "${key}"`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path} has unknown key "${key}"`)
}

function uniqueStrings(values, path) {
  requireArray(values, path).forEach((v, i) => requireString(v, `${path}[${i}]`))
  if (new Set(values).size !== values.length) fail(`${path} must be unique`)
}

function validate(data) {
  requireObject(data, 'lab')
  requireString(data.title, 'lab.title')
  requireObject(data.manifest, 'lab.manifest')
  for (const key of ['dataset', 'date', 'procedure', 'judge']) requireString(data.manifest[key], `lab.manifest.${key}`)
  if (!['synthetic', 'measured', 'planned'].includes(data.manifest.evidence)) fail('lab.manifest.evidence must be synthetic, measured, or planned')
  if (!Number.isSafeInteger(data.repetitions) || data.repetitions < 1) fail('lab.repetitions must be a positive integer')
  requireArray(data.arms, 'lab.arms')
  if (data.arms.length < 2 || data.arms.length > 6) fail('lab.arms needs 2–6 arms')
  const armIds = data.arms.map((arm, i) => {
    const p = `lab.arms[${i}]`
    requireObject(arm, p)
    for (const key of ['id', 'name', 'model', 'provider']) requireString(arm[key], `${p}.${key}`)
    requireObject(arm.config, `${p}.config`)
    for (const [key, value] of Object.entries(arm.config)) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) fail(`${p}.config.${key} must be a string, finite number, or boolean`)
    }
    return arm.id
  })
  uniqueStrings(armIds, 'lab.arms ids')
  uniqueStrings(data.arms.map((a) => a.name), 'lab.arms names')
  if (data.arms.some((a) => ['Tie', 'Neither', 'Insufficient evidence'].includes(a.name))) fail('lab.arms names cannot use reserved verdict labels')
  if (!armIds.includes(data.baseline)) fail('lab.baseline must name an arm id')
  requireArray(data.cases, 'lab.cases')
  if (!data.cases.length) fail('lab.cases must not be empty')
  const caseIds = []
  const runIds = new Set()
  for (const [i, c] of data.cases.entries()) {
    const p = `lab.cases[${i}]`
    requireObject(c, p)
    caseIds.push(requireString(c.id, `${p}.id`))
    requireString(c.name, `${p}.name`)
    requireString(c.prompt, `${p}.prompt`)
    uniqueStrings(c.criteria, `${p}.criteria`)
    if (!c.criteria.length) fail(`${p}.criteria must not be empty`)
    exactKeys(c.runs, armIds, `${p}.runs`)
    for (const arm of armIds) {
      const rp = `${p}.runs.${arm}`
      requireArray(c.runs[arm], rp)
      const repetitions = new Set()
      for (const [j, run] of c.runs[arm].entries()) {
        const r = `${rp}[${j}]`
        requireObject(run, r)
        requireString(run.id, `${r}.id`)
        if (runIds.has(run.id)) fail(`${r}.id duplicates run "${run.id}"`)
        runIds.add(run.id)
        if (!Number.isSafeInteger(run.repetition) || run.repetition < 1 || run.repetition > data.repetitions || repetitions.has(run.repetition)) fail(`${r}.repetition must be unique within the case/arm and between 1 and lab.repetitions`)
        repetitions.add(run.repetition)
        if (!STATES.includes(run.status)) fail(`${r}.status must be ${STATES.join(', ')}`)
        if (!['complete', 'partial'].includes(run.accounting)) fail(`${r}.accounting must be complete or partial`)
        if (run.status === 'error') requireString(run.error, `${r}.error`)
        number(run.latencyMs, `${r}.latencyMs`)
        requireArray(run.requests, `${r}.requests`)
        if (run.status === 'complete' && !run.requests.length) fail(`${r}.requests cannot be empty for a complete run`)
        if (run.status === 'pending' && run.requests.length) fail(`${r}: a pending run cannot already have requests`)
        if (data.manifest.evidence === 'planned' && (run.requests.length || run.status !== 'pending')) fail(`${r}: planned evidence can only contain pending runs without requests`)
        const ids = []
        run.requests.forEach((request, k) => {
          const q = `${r}.requests[${k}]`
          requireObject(request, q)
          ids.push(requireString(request.id, `${q}.id`))
          if (!['complete', 'error'].includes(request.status)) fail(`${q}.status must be complete or error`)
          for (const field of REQUEST_FIELDS) number(request[field], `${q}.${field}`, TOKEN_FIELDS.includes(field) || field === 'compactions')
          if (known(request.costUsd)) requireString(request.costSource, `${q}.costSource`)
          if (known(request.inputTokens) && (request.cacheReadTokens ?? 0) + (request.cacheWriteTokens ?? 0) > request.inputTokens) fail(`${q}: cache read + write tokens exceed inclusive inputTokens`)
          if (known(request.reasoningTokens) && known(request.outputTokens) && request.reasoningTokens > request.outputTokens) fail(`${q}: reasoningTokens exceeds inclusive outputTokens`)
        })
        uniqueStrings(ids, `${r}.requests ids`)
        exactKeys(run.checks, c.criteria, `${r}.checks`)
        for (const criterion of c.criteria) {
          const check = run.checks[criterion]
          requireObject(check, `${r}.checks.${criterion}`)
          if (!CHECK_STATES.includes(check.status)) fail(`${r}.checks.${criterion}.status must be pass, fail, or unknown`)
          requireString(check.evidence, `${r}.checks.${criterion}.evidence`)
        }
      }
    }
  }
  uniqueStrings(caseIds, 'lab.cases ids')
}

const correct = (run) => run.status === 'complete' && Object.values(run.checks).every((c) => c.status === 'pass')
const settled = (run) => ['complete', 'error'].includes(run.status)

function quantile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (sorted.length - 1) * p
  const lower = Math.floor(rank)
  return sorted[lower] + (sorted[Math.ceil(rank)] - sorted[lower]) * (rank - lower)
}

function aggregate(runs, expected) {
  const requests = runs.flatMap((r) => r.requests)
  const complete = runs.length === expected && runs.every(settled)
  const accounted = complete && runs.every((r) => r.accounting === 'complete')
  const fields = Object.fromEntries(REQUEST_FIELDS.map((field) => {
    const values = requests.map((r) => r[field]).filter(known)
    return [field, {
      value: values.length ? values.reduce((a, b) => a + b, 0) : null,
      complete: accounted && requests.length > 0 && values.length === requests.length && runs.every((r) => r.requests.length > 0),
    }]
  }))
  const latencies = runs.filter((r) => r.status === 'complete' && known(r.latencyMs)).map((r) => r.latencyMs)
  const successes = runs.filter(correct).length
  return {
    expected, complete, accounted, requests: requests.length, correct: successes,
    finished: runs.filter((r) => r.status === 'complete').length,
    qualityFailures: runs.filter((r) => r.status === 'complete' && Object.values(r.checks).some((c) => c.status === 'fail')).length,
    errors: runs.filter((r) => r.status === 'error').length,
    pending: expected - runs.filter(settled).length,
    unjudged: runs.filter((r) => r.status === 'complete' && Object.values(r.checks).some((c) => c.status === 'unknown')).length,
    fields, latencySamples: latencies.length, p50: quantile(latencies, .5), p95: quantile(latencies, .95),
    costPerCorrect: fields.costUsd.complete && successes > 0 && !runs.some((r) => r.status === 'complete' && Object.values(r.checks).some((c) => c.status === 'unknown')) ? fields.costUsd.value / successes : null,
  }
}

export function summarize(data) {
  validate(data)
  return Object.fromEntries(data.arms.map((a) => [a.id, aggregate(data.cases.flatMap((c) => c.runs[a.id]), data.cases.length * data.repetitions)]))
}

function measured(field, format = num) {
  if (field.value === null) return 'Unknown'
  return `${format(field.value)}${field.complete ? '' : ' observed · incomplete'}`
}

function delta(stats, baseline) {
  if (!known(stats.costPerCorrect) || !known(baseline.costPerCorrect)) return 'Not comparable yet'
  if (baseline.costPerCorrect === 0) return 'Baseline cost is zero'
  const value = (stats.costPerCorrect / baseline.costPerCorrect - 1) * 100
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}% · check quality`
}

function requestTable(requests) {
  if (!requests.length) return '<p class="sd-muted">No request records yet. Usage and cost are unknown.</p>'
  const value = (r, key, format = num) => known(r[key]) ? format(r[key]) : 'Unknown'
  return table(['Request', 'State', 'Input', 'Cache read / write', 'Output / reasoning', 'Cost / source', 'Compactions', 'Latency'], requests.map((r) => [
    r.id, r.status, value(r, 'inputTokens'), `${value(r, 'cacheReadTokens')} / ${value(r, 'cacheWriteTokens')}`,
    `${value(r, 'outputTokens')} / ${value(r, 'reasoningTokens')}`, `${value(r, 'costUsd', money)}${r.costSource ? ` · ${r.costSource}` : ''}`,
    value(r, 'compactions'), value(r, 'latencyMs', seconds),
  ]))
}

function runDetails(run) {
  const failed = Object.values(run.checks).some((c) => c.status === 'fail')
  const label = run.status === 'complete' ? correct(run) ? 'All checks pass' : failed ? 'Quality check failed' : 'Quality not established' : run.status
  const tone = run.status === 'error' || failed ? 'error' : correct(run) ? 'success' : 'warning'
  return `<details class="sd-collapse"><summary>Repetition ${run.repetition} · ${esc(run.id)} · ${esc(label)}</summary><div class="sd-collapse-body">
${badge(label, tone)}
<p class="sd-muted">Accounting: ${esc(run.accounting)} · completion latency: ${known(run.latencyMs) ? seconds(run.latencyMs) : 'Unknown'}</p>
${run.error ? `<p>${esc(run.error)}</p>` : ''}
${table(['Check', 'Result', 'Evidence'], Object.entries(run.checks).map(([key, check]) => [key, check.status, check.evidence]))}
${run.output ? `<h4>Output</h4>${markdown(run.output)}` : '<p class="sd-muted">No output recorded.</p>'}
<h4>Provider requests and attempts</h4>${requestTable(run.requests)}
</div></details>`
}

export function render(data) {
  const stats = summarize(data)
  const baseline = stats[data.baseline]
  const row = (label, get) => [label, ...data.arms.map((a) => get(stats[a.id], a))]
  const summaryRows = [
    row('Correct tasks / planned', (s) => `${s.correct} / ${s.expected}${s.unjudged ? ` · ${s.unjudged} unjudged` : ''}`),
    row('Finished / errors / pending', (s) => `${s.finished} / ${s.errors} / ${s.pending}`),
    row('Tasks with failed quality checks', (s) => `${s.qualityFailures}${s.pending || s.unjudged ? ' observed · evaluation incomplete' : ''}`),
    row('Provider requests recorded', (s) => `${s.requests}${s.accounted ? '' : ' · incomplete'}`),
    ...[['Input tokens', 'inputTokens'], ['Cache reads', 'cacheReadTokens'], ['Cache writes', 'cacheWriteTokens'], ['Output tokens', 'outputTokens'], ['Reasoning (included in output)', 'reasoningTokens'], ['Compactions observed', 'compactions']].map(([label, key]) => row(label, (s) => measured(s.fields[key]))),
    row('All-attempt cost', (s) => measured(s.fields.costUsd, money)),
    row('Cost / correct task', (s) => known(s.costPerCorrect) ? money(s.costPerCorrect) : 'Not established'),
    row('Cost / correct vs baseline', (s, a) => a.id === data.baseline ? 'Baseline' : delta(s, baseline)),
    row('Completion p50 / p95', (s) => s.latencySamples ? `${seconds(s.p50)} / ${seconds(s.p95)} · n=${s.latencySamples}/${s.expected}` : 'Not measured'),
  ]
  const keys = [...new Set(data.arms.flatMap((a) => Object.keys(a.config)))].sort()
  const configurations = [
    ['Model', ...data.arms.map((a) => a.model)], ['Provider', ...data.arms.map((a) => a.provider)],
    ...keys.map((key) => [key, ...data.arms.map((a) => Object.hasOwn(a.config, key) ? String(a.config[key]) : 'Not specified')]),
  ]
  return [
    `<h1>${esc(data.title)}</h1>`,
    badge({ synthetic: 'Synthetic example · not benchmark evidence', measured: 'Measured run data · inspect provenance', planned: 'Planned experiment · no results yet' }[data.manifest.evidence], data.manifest.evidence === 'synthetic' ? 'warning' : 'info'),
    data.summary ? markdown(data.summary) : '',
    '<section class="sd-section"><h2>Experiment</h2>',
    table(['Dataset', 'Date', 'Judge', 'Repetitions per case / arm'], [[data.manifest.dataset, data.manifest.date, data.manifest.judge, data.repetitions]]),
    markdown(data.manifest.procedure),
    table(['Configuration', ...data.arms.map((a) => a.name)], configurations), '</section>',
    '<section class="sd-section"><h2>Results ledger</h2>',
    '<p class="sd-muted">Input is summed across requests, not context length. Costs include recorded failed attempts. Pending or missing accounting blocks cost comparisons. Reasoning is already included in output. Percentiles describe observed completed runs only; small samples do not establish parity.</p>',
    table(['Metric', ...data.arms.map((a) => a.name)], summaryRows),
    '<p class="sd-muted">A lower cost per correct task is not a quality verdict. Review failures, unresolved checks, and provider differences before choosing an arm.</p></section>',
    ...data.cases.map((c) => `<section class="sd-section"><h2>${esc(c.name)}</h2>
${markdown(c.prompt)}
${c.context ? markdown(c.context) : ''}
${table(['Arm', 'Correct / planned', 'Input', 'Cost', 'State'], data.arms.map((a) => {
      const s = aggregate(c.runs[a.id], data.repetitions)
      const state = [s.pending ? `${s.pending} pending or running` : '', s.errors ? `${s.errors} errors` : '', s.qualityFailures ? `${s.qualityFailures} quality failures` : '', s.unjudged ? `${s.unjudged} unjudged` : ''].filter(Boolean).join(' · ')
      return [a.name, `${s.correct} / ${s.expected}`, measured(s.fields.inputTokens), measured(s.fields.costUsd, money), state || 'Finished']
    }))}
${data.arms.map((a) => `<h3>${esc(a.name)}</h3>${c.runs[a.id].length ? [...c.runs[a.id]].sort((a, b) => a.repetition - b.repetition).map(runDetails).join('\n') : '<p class="sd-muted">Pending — this arm has not run.</p>'}`).join('\n')}
${widget({ type: 'vote', id: `lab-${c.id}`, prompt: 'Which result is acceptable for this case?', help: 'Inspect the checks and request records above. Choose insufficient evidence when no comparison is supported.', options: [...data.arms.map((a) => a.name), 'Tie', 'Neither', 'Insufficient evidence'] })}
</section>`),
  ].join('\n')
}
