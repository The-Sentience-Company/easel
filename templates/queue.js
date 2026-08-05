/* queue template — per-campaign decision queue: open asks with vote widgets,
   review stamps, and open PRs in merge-dependency order. */

import { esc, attr, widget, badge, table, makeIdGuard, requireObject, requireArray, requireString, fail } from './_html.js'

export const name = 'queue'

const KIND_TONES = { decision: 'info', review: 'warning', merge: 'success' }
const STATUSES = new Set(['open', 'answered'])
const DEFAULT_OPTIONS = ['approve', 'reject', 'discuss']

export function formatAge(ms) {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  if (m < 2880) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}

function validateEntry(e, i) {
  requireObject(e, `queue.entries[${i}]`)
  const path = `queue.entries[${i}]`
  requireString(e.id, `${path}.id`)
  requireString(e.pane, `${path}.pane`)
  requireString(e.question, `${path}.question`)
  const kind = requireString(e.kind, `${path}.kind`)
  if (!(kind in KIND_TONES)) fail(`${path}.kind must be one of ${Object.keys(KIND_TONES).join(', ')}, got "${kind}"`)
  const status = requireString(e.status, `${path}.status`)
  if (!STATUSES.has(status)) fail(`${path}.status must be one of ${[...STATUSES].join(', ')}, got "${status}"`)
  const filedMs = Date.parse(requireString(e.filed_at, `${path}.filed_at`))
  if (Number.isNaN(filedMs)) fail(`${path}.filed_at must be an ISO-8601 timestamp, got "${e.filed_at}"`)
  if (e.context_link !== undefined) requireString(e.context_link, `${path}.context_link`)
  if (e.options !== undefined && requireArray(e.options, `${path}.options`).length === 0) {
    fail(`${path}.options must not be empty — omit it for the approve/reject/discuss default`)
  }
  return { ...e, filedMs }
}

// The daemon chrome re-renders [data-live-age] from datetime, so the age stays
// live; the text here is only the age as of publish.
function ageMarkup(filedMs) {
  const iso = new Date(filedMs).toISOString()
  return `<time class="sd-muted" datetime="${attr(iso)}" data-live-age>waiting ${formatAge(Date.now() - filedMs)}</time>`
}

function entryCard(e, i, uniqueId) {
  const open = e.status === 'open'
  const meta = [
    badge(e.kind, KIND_TONES[e.kind]),
    `<span class="sd-badge"><span class="sd-badge-key">pane</span><span class="sd-badge-value">${esc(e.pane)}</span></span>`,
    open ? ageMarkup(e.filedMs) : badge('answered', 'success'),
    e.context_link ? `<a href="${attr(e.context_link)}">context</a>` : '',
  ].filter(Boolean).join('')
  return [
    `<div class="sd-card${open ? ' sd-accent' : ''}">`,
    `<div class="sd-row sd-badge-row">${meta}</div>`,
    open ? `<p><strong>${esc(e.question)}</strong></p>` : `<p class="sd-muted">${esc(e.question)}</p>`,
    open
      ? widget({ type: 'decision', id: uniqueId(e.id, `queue.entries[${i}].id`), options: e.options ?? DEFAULT_OPTIONS })
      : '',
    '</div>',
  ].filter(Boolean).join('\n')
}

function stampRows(stamps) {
  return stamps.map((s, i) => {
    requireObject(s, `queue.review_stamps[${i}]`)
    const artifact = requireString(s.artifact, `queue.review_stamps[${i}].artifact`)
    const last = requireString(s.last_reviewed_version, `queue.review_stamps[${i}].last_reviewed_version`)
    const current = requireString(s.current_version, `queue.review_stamps[${i}].current_version`)
    const status = last === current ? badge('current', 'success') : badge('changed since review', 'warning')
    return [esc(artifact), esc(last), esc(current), status]
  })
}

function prRows(prs) {
  return prs.map((p, i) => {
    requireObject(p, `queue.open_prs[${i}]`)
    const path = `queue.open_prs[${i}]`
    if (typeof p.number !== 'number' && typeof p.number !== 'string') fail(`${path}.number must be a number or string`)
    const url = requireString(p.url, `${path}.url`)
    const title = requireString(p.title, `${path}.title`)
    if (p.pane !== undefined) requireString(p.pane, `${path}.pane`)
    const blocked = p.blocked_by !== undefined && p.blocked_by !== null ? `waits on #${esc(p.blocked_by)}` : '—'
    return [`<a href="${attr(url)}">#${esc(p.number)}</a>`, esc(title), p.pane ? esc(p.pane) : '—', blocked]
  })
}

export function render(data) {
  requireObject(data, 'queue')
  const campaign = requireString(data.campaign, 'queue.campaign')
  const entries = requireArray(data.entries ?? [], 'queue.entries').map(validateEntry)
  const stamps = requireArray(data.review_stamps ?? [], 'queue.review_stamps')
  const prs = requireArray(data.open_prs ?? [], 'queue.open_prs')
  const uniqueId = makeIdGuard('queue')

  const open = entries.filter((e) => e.status === 'open')
  const answered = entries.filter((e) => e.status === 'answered')

  const openHtml = [
    '<section class="sd-section">',
    `<h2>Waiting on you <span class="sd-count">${open.length}</span></h2>`,
    open.length
      ? open.map((e) => entryCard(e, entries.indexOf(e), uniqueId)).join('\n')
      : '<p class="sd-muted">Nothing waiting.</p>',
    '</section>',
  ].join('\n')

  const answeredHtml = answered.length
    ? [
        '<section class="sd-section">',
        `<h2>Answered <span class="sd-count">${answered.length}</span></h2>`,
        answered.map((e) => entryCard(e, entries.indexOf(e), uniqueId)).join('\n'),
        '</section>',
      ].join('\n')
    : ''

  const stampsHtml = stamps.length
    ? [
        '<section class="sd-section">',
        `<h2>Review stamps <span class="sd-count">${stamps.length}</span></h2>`,
        table(['Artifact', 'Last reviewed', 'Current', 'Status'], stampRows(stamps)),
        '</section>',
      ].join('\n')
    : ''

  const prsHtml = prs.length
    ? [
        '<section class="sd-section">',
        `<h2>Open PRs, in merge order <span class="sd-count">${prs.length}</span></h2>`,
        table(['PR', 'Title', 'Pane', 'Waits on'], prRows(prs)),
        '</section>',
      ].join('\n')
    : ''

  return [
    `<h1>Decision queue — ${esc(campaign)}</h1>`,
    openHtml,
    answeredHtml,
    stampsHtml,
    prsHtml,
  ].filter(Boolean).join('\n')
}
