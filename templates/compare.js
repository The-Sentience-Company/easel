/* compare template — N arms side by side, one verdict per case.
   eval's blind compare takes exactly two candidates; this takes 2–6 named ones. */

import { esc, markdown, widget, badge, makeIdGuard, requireObject, requireArray, requireString, fail } from './_html.js'
import { emphasize } from './eval.js'

export const name = 'compare'

const MAX_ARMS = 6

const modeOf = (c, path) => {
  const has = ['columns', 'rows'].filter((k) => c[k] !== undefined)
  if (has.length === 0) fail(`${path} has neither columns nor rows — one is required`)
  if (has.length > 1) fail(`${path} has both columns and rows — a case is one or the other`)
  return has[0]
}

const runLine = (run, path) => {
  requireObject(run, path)
  const bits = Object.entries(run)
    .map(([k, v]) => `<span class="sd-muted">${esc(k)}</span> <strong>${esc(v)}</strong>`)
  if (!bits.length) return ''
  return `<div class="sd-row">${bits.join(' · ')}</div>`
}

export function render(data) {
  requireObject(data, 'compare')
  requireString(data.title, 'compare.title')

  const arms = requireArray(data.arms, 'compare.arms').map((a, i) => requireString(a, `compare.arms[${i}]`))
  if (arms.length < 2) fail('compare.arms needs at least 2 arms — one arm is not a comparison')
  if (arms.length > MAX_ARMS) fail(`compare.arms takes at most ${MAX_ARMS} arms; ${arms.length} columns stop being readable`)
  if (new Set(arms).size !== arms.length) fail('compare.arms must be unique — they are the column headers and the vote options')

  const cases = requireArray(data.cases, 'compare.cases')
  if (cases.length === 0) fail('compare: cases must not be empty')

  const uniqueId = makeIdGuard('compare')
  const seen = new Set()
  let mode = null

  const armCells = (obj, path) => {
    requireObject(obj, path)
    const missing = arms.filter((a) => obj[a] === undefined)
    if (missing.length) fail(`${path} is missing arm${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')} — every arm needs a cell so the columns line up`)
    return arms.map((a) => String(obj[a]))
  }

  const caseHtml = cases.map((c, i) => {
    const path = `compare.cases[${i}]`
    requireObject(c, path)
    const id = requireString(c.id, `${path}.id`)
    if (seen.has(id)) fail(`compare: duplicate case id "${id}" — ids must be unique per board`)
    seen.add(id)

    const m = modeOf(c, `${path} ("${id}")`)
    mode = mode ?? m
    if (m !== mode) fail(`${path} ("${id}") is ${m}-shaped but the board is ${mode}-shaped — one shape per board`)

    let comparison
    if (m === 'columns') {
      const cells = armCells(c.columns, `${path}.columns`)
      comparison = [
        '<div class="sd-grid">',
        ...cells.map((text, j) => [
          '<div class="sd-card">',
          `<div class="sd-card-title">${esc(arms[j])}</div>`,
          markdown(text),
          '</div>',
        ].join('\n')),
        '</div>',
      ].join('\n')
    } else {
      const rows = requireArray(c.rows, `${path}.rows`)
      if (rows.length === 0) fail(`${path}.rows must not be empty`)
      const body = rows.map((r, j) => {
        const rp = `${path}.rows[${j}]`
        requireObject(r, rp)
        requireString(r.label, `${rp}.label`)
        const cells = armCells(r.cells, `${rp}.cells`)
        // What every arm says recedes; what one arm says alone is the whole point.
        const tds = cells.map((text, k) => `<td>${emphasize(text, cells.filter((_, n) => n !== k))}</td>`).join('')
        return `<tr><td><strong>${esc(r.label)}</strong>${r.note ? `<div class="sd-muted">${esc(r.note)}</div>` : ''}</td>${tds}</tr>`
      }).join('\n')
      comparison = [
        '<div class="sd-tablewrap"><table>',
        `<thead><tr><th>${esc(data.rowColumn ?? 'what')}</th>${arms.map((a) => `<th>${esc(a)}</th>`).join('')}</tr></thead>`,
        `<tbody>${body}</tbody>`,
        '</table></div>',
      ].join('\n')
    }

    // One verdict for the case, never one per row — a reader asked to rule on
    // every line stops reading and rules on none.
    let verdictHtml = ''
    if (c.verdict !== false) {
      const options = c.verdict === undefined
        ? [...arms, 'tie', 'all-bad']
        : requireArray(c.verdict, `${path}.verdict`)
      verdictHtml = widget({
        type: 'vote',
        id: uniqueId(`v-${id}`, `${path}.id`),
        prompt: c.ask ?? 'Which arm wins this case?',
        help: c.askHelp,
        options,
      })
    }

    return [
      '<section class="sd-section">',
      `<h2>${esc(c.name ?? id)}</h2>`,
      c.badges ? `<div class="sd-row">${requireArray(c.badges, `${path}.badges`).map((b) => badge(typeof b === 'string' ? b : b.label, typeof b === 'string' ? null : b.tone, `${path}.badges tone`)).join('')}</div>` : '',
      c.context ? `<div class="sd-muted">${markdown(c.context)}</div>` : '',
      comparison,
      verdictHtml,
      '</section>',
    ].filter(Boolean).join('\n')
  }).join('\n')

  return [
    `<h1>${esc(data.title)}</h1>`,
    data.summary ? `<div class="sd-muted">${markdown(data.summary)}</div>` : '',
    data.run ? runLine(data.run, 'compare.run') : '',
    caseHtml,
  ].filter(Boolean).join('\n')
}
