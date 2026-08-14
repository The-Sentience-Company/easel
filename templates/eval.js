/* eval template — one template, three modes switched on the case shape:
   notes → dossiers, candidates → blind compare, items → matrix. */

import { esc, markdown, widget, table, badge, makeIdGuard, requireObject, requireArray, requireString, fail } from './_html.js'

export const name = 'eval'

const TONE_BY_STATUS = { pass: 'success', fail: 'error', error: 'error', skip: 'warning', partial: 'warning' }
const FOLD_PASSES_ABOVE = 15

const MODE_BY_FIELD = { notes: 'dossier', candidates: 'compare', items: 'matrix' }

const modeOf = (c, path) => {
  const present = Object.keys(MODE_BY_FIELD).filter((f) => c[f] !== undefined)
  if (present.length > 1) fail(`${path} carries ${present.join(' and ')} — a case has exactly one shape field`)
  return present.length ? MODE_BY_FIELD[present[0]] : null
}

/** "ahmet — 2 entries" often arrives as name "ahmet ahmet — 2 entries"; the
    heading shows the id once. Only a whole-word prefix strips ("alpha" keeps its a). */
const nameTail = (c) => {
  const name = String(c.name ?? '')
  if (name === c.id) return ''
  return (name.startsWith(c.id) && /^\s/.test(name.slice(c.id.length)) ? name.slice(c.id.length) : name).trim()
}

const caseHeading = (c) =>
  `<h2><span class="sd-mono">${esc(c.id)}</span>${nameTail(c) ? ` ${esc(nameTail(c))}` : ''}</h2>`

const statusBadge = (c, i) => {
  if (c.status === undefined || c.status === null) return ''
  const status = String(c.status)
  return badge(status, TONE_BY_STATUS[status] ?? null, `eval.cases[${i}].status`)
}

/* Edge punctuation is stripped for matching, interior ./@ kept so emails compare whole. */
const norm = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}@]+|[^\p{L}\p{N}]+$/gu, '')

export function emphasize(text, siblings) {
  const sets = siblings.map((s) => new Set(String(s).split(/\s+/).map(norm).filter(Boolean)))
  return String(text).split(/(\s+)/).map((tok) => {
    if (/^\s*$/.test(tok)) return tok
    const n = norm(tok)
    if (!n) return esc(tok)
    return sets.length && sets.every((set) => set.has(n)) ? esc(tok) : `<strong>${esc(tok)}</strong>`
  }).join('')
}

export function render(data) {
  requireObject(data, 'eval')
  requireString(data.title, 'eval.title')

  const metrics = requireArray(data.metrics ?? [], 'eval.metrics')
  const cases = requireArray(data.cases ?? [], 'eval.cases')
  if (cases.length === 0) fail('eval: cases must not be empty')
  const uniqueWidgetId = makeIdGuard('eval')

  const seen = new Set()
  let mode = null
  cases.forEach((c, i) => {
    requireObject(c, `eval.cases[${i}]`)
    const id = requireString(c.id, `eval.cases[${i}].id`)
    if (seen.has(id)) fail(`eval: duplicate case id "${id}" — ids must be unique per board`)
    seen.add(id)
    const m = modeOf(c, `eval.cases[${i}] ("${id}")`)
    if (!m) fail(`eval.cases[${i}] ("${id}") has none of notes, candidates, or items — one is required`)
    mode = mode ?? m
    if (m !== mode) fail(`eval: mixed case shapes — cases[0] is ${mode}, "${id}" is ${m}; one board renders one mode`)
  })

  const run = data.run && typeof data.run === 'object' ? data.run : {}
  const runLine = Object.entries(run)
    .map(([k, v]) => `<span class="sd-muted">${esc(k)}</span> <strong>${esc(v)}</strong>`)
    .join(' · ')

  const head = [
    '<div class="sd-masthead">',
    `<h1>${esc(data.title)}</h1>`,
    data.summary ? `<div class="sd-lede">${markdown(data.summary)}</div>` : '',
    runLine ? `<p>${runLine}</p>` : '',
    '</div>',
  ].filter(Boolean).join('\n')

  const metricsHtml = metrics.length
    ? `<section class="sd-section"><div class="sd-metrics">${
        metrics.map((m, i) => {
          requireObject(m, `eval.metrics[${i}]`)
          requireString(m.label, `eval.metrics[${i}].label`)
          if (m.value === undefined || m.value === null) fail(`eval.metrics[${i}].value is required`)
          return [
            '<div class="sd-metric">',
            `<div class="sd-metric-label">${esc(m.label)}</div>`,
            `<div class="sd-metric-value">${esc(m.value)}</div>`,
            m.note ? `<div class="sd-metric-note">${esc(m.note)}</div>` : '',
            '</div>',
          ].filter(Boolean).join('')
        }).join('')
      }</div></section>`
    : ''

  // The old template drew this table even when every status/score cell was
  // empty; now it only appears when it has something to say.
  const hasTableData = cases.some((c) => (c.status ?? null) !== null || (c.score ?? null) !== null)
  const summaryTable = hasTableData
    ? `<section class="sd-section"><h2>Cases</h2>${
        table(['case', 'status', 'name', 'score'], cases.map((c) => [
          `<span class="sd-mono">${esc(c.id)}</span>`,
          c.status ? statusBadge(c, cases.indexOf(c)) : '<span class="sd-muted">—</span>',
          esc(c.name ?? ''),
          c.score === undefined || c.score === null ? '<span class="sd-muted">—</span>' : `<span class="sd-mono">${esc(c.score)}</span>`,
        ]))
      }</section>`
    : ''

  const body = mode === 'dossier' ? renderDossiers(cases, uniqueWidgetId, data.verdicts !== false)
    : mode === 'compare' ? renderCompare(cases, data.blindKey, uniqueWidgetId)
    : renderMatrix(cases, data.itemColumn, uniqueWidgetId, data.picks !== false)

  return [head, metricsHtml, summaryTable, body].filter(Boolean).join('\n')
}

function renderDossiers(cases, uniqueWidgetId, verdicts = true) {
  const fold = cases.length > FOLD_PASSES_ABOVE
  return cases.map((c, i) => {
    // A dossier board published to be read, not ruled on, takes verdicts: false.
    const inner = [
      `<div class="sd-card">${markdown(requireString(c.notes, `eval.cases[${i}].notes`))}</div>`,
      verdicts ? widget({
        type: 'rating',
        id: uniqueWidgetId(`verdict-${c.id}`),
        prompt: `${c.id}: verdict`,
        options: requireArray(c.verdictOptions ?? ['pass', 'needs-work'], `eval.cases[${c.id}].verdictOptions`),
      }) : '',
    ].filter(Boolean).join('\n')
    if (fold && String(c.status) === 'pass') {
      return [
        '<section class="sd-section">',
        '<details class="sd-collapse">',
        `<summary><span class="sd-mono">${esc(c.id)}</span>${statusBadge(c, i)}${nameTail(c) ? `<span class="sd-muted">${esc(nameTail(c))}</span>` : ''}</summary>`,
        `<div class="sd-collapse-body">${inner}</div>`,
        '</details>',
        '</section>',
      ].join('\n')
    }
    return `<section class="sd-section">\n${caseHeading(c)}\n${inner}\n</section>`
  }).join('\n')
}

/* One-line candidates pack 42 cases onto a screen as table rows; anything
   longer gets the two-column section treatment. The data decides, per mode. */
const DENSE_MAX_CHARS = 160

function compareContextBlock(context) {
  if (!context) return ''
  if (context.length <= 400) return `<div class="sd-muted">${markdown(context)}</div>`
  return `<details class="sd-collapse"><summary>context</summary><div class="sd-collapse-body">${markdown(context)}</div></details>`
}

function renderCompare(cases, blindKey, uniqueWidgetId) {
  if (blindKey === undefined || blindKey === null) {
    fail('eval: compare mode requires blindKey — the harness holds the mapping, the page never names the runs')
  }
  requireObject(blindKey, 'eval.blindKey')
  const rows = cases.map((c, i) => {
    const candidates = requireArray(c.candidates, `eval.cases[${i}].candidates`)
    if (candidates.length !== 2) fail(`eval.cases[${i}].candidates must have exactly 2 entries, got ${candidates.length}`)
    candidates.forEach((t) => requireString(t, `eval.cases[${i}].candidates[]`))
    if (c.context !== undefined) requireString(c.context, `eval.cases[${i}].context`)
    if (c.group !== undefined) requireString(c.group, `eval.cases[${i}].group`)
    const first = blindKey[c.id]
    if (first !== 0 && first !== 1) fail(`eval.blindKey["${c.id}"] must be 0 or 1 — which candidate renders as output 1`)
    const [left, right] = first === 0 ? candidates : [candidates[1], candidates[0]]
    return { c, left, right }
  })

  const dense = rows.every(({ left, right }) =>
    [left, right].every((t) => !t.includes('\n') && t.length <= DENSE_MAX_CHARS))
  if (dense) return renderCompareTable(rows, uniqueWidgetId)

  return rows.map(({ c, left, right }) => [
    '<section class="sd-section">',
    caseHeading(c),
    compareContextBlock(c.context),
    '<div class="sd-rules">',
    `<div class="sd-rule"><div class="sd-eyebrow">output 1</div>${markdown(left)}</div>`,
    `<div class="sd-rule"><div class="sd-eyebrow">output 2</div>${markdown(right)}</div>`,
    '</div>',
    widget({
      type: 'vote',
      id: uniqueWidgetId(`cmp-${c.id}`),
      prompt: `${c.id}: which is better?`,
      options: ['output-1', 'output-2', 'tie'],
    }),
    '</section>',
  ].filter(Boolean).join('\n')).join('\n')
}

function renderCompareTable(rows, uniqueWidgetId) {
  const groups = []
  for (const r of rows) {
    const name = r.c.group ?? ''
    if (!groups.length || groups.at(-1).name !== name) groups.push({ name, rows: [] })
    groups.at(-1).rows.push(r)
  }
  return groups.map((g) => {
    const hasContext = g.rows.some((r) => r.c.context)
    const head = ['case', ...(hasContext ? ['context'] : []), 'output 1', 'output 2', 'pick']
    const body = g.rows.map(({ c, left, right }) => [
      `<span class="sd-mono">${esc(c.name ?? c.id)}</span>`,
      ...(hasContext ? [c.context ? `<span class="sd-muted">${esc(c.context)}</span>` : '—'] : []),
      esc(left),
      esc(right),
      widget({
        type: 'vote',
        id: uniqueWidgetId(`cmp-${c.id}`),
        options: ['output-1', 'output-2', 'tie'],
        compact: true,
      }),
    ])
    return [
      '<section class="sd-section">',
      g.name ? `<h2>${esc(g.name)} <span class="sd-count">${g.rows.length}</span></h2>` : '',
      table(head, body),
      '</section>',
    ].filter(Boolean).join('\n')
  }).join('\n')
}

function renderMatrix(cases, itemColumn, uniqueWidgetId, picks = true) {
  return cases.map((c, i) => {
    const items = requireArray(c.items, `eval.cases[${i}].items`)
    if (items.length === 0) fail(`eval.cases[${i}].items must not be empty`)
    requireObject(items[0].candidates, `eval.cases[${i}].items[0].candidates`)
    const candKeys = Object.keys(items[0].candidates)
    if (candKeys.length === 0) fail(`eval.cases[${i}].items[0].candidates must not be empty`)

    const rows = items.map((item, j) => {
      requireObject(item, `eval.cases[${i}].items[${j}]`)
      requireString(item.label, `eval.cases[${i}].items[${j}].label`)
      requireObject(item.candidates, `eval.cases[${i}].items[${j}].candidates`)
      const itemKeys = Object.keys(item.candidates)
      if ([...itemKeys].sort().join('\n') !== [...candKeys].sort().join('\n')) {
        fail(`eval.cases[${i}].items[${j}] candidates (${itemKeys.join(', ')}) do not match the case's (${candKeys.join(', ')})`)
      }
      const texts = Object.values(item.candidates)
      const cells = candKeys.map((k) => {
        const text = String(item.candidates[k])
        const others = texts.filter((t) => t !== item.candidates[k])
        return `<td>${emphasize(text, others.length ? others : [text])}</td>`
      }).join('')
      // A reader asked to rule on every row rules on none — `picks: false`
      // keeps the table readable and leaves the per-case verdict as the ask.
      const row = `<tr><td><strong>${esc(item.label)}</strong>${item.note ? `<div class="sd-muted">${esc(item.note)}</div>` : ''}</td>${cells}</tr>`
      if (!picks) return row
      const pick = widget({
        type: 'vote',
        id: uniqueWidgetId(item.id ?? `best-${c.id}-${j}`),
        options: [...candKeys.map((k) => ({ value: k, label: `${k} best` })), 'tie', 'all-bad'],
      })
      return [
        row,
        `<tr><td class="sd-muted">best?</td><td colspan="${candKeys.length}">${pick}</td></tr>`,
      ].join('')
    }).join('')

    const header = [itemColumn ?? 'item', ...candKeys]
      .map((h) => `<th class="sd-align-left">${esc(h)}</th>`).join('')
    return [
      '<section class="sd-section">',
      caseHeading(c),
      `<div class="sd-tablewrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`,
      widget({
        type: 'vote',
        id: uniqueWidgetId(`overall-${c.id}`),
        prompt: `Overall — ${c.id}`,
        options: [...candKeys, 'tie'],
      }),
      '</section>',
    ].join('\n')
  }).join('\n')
}
