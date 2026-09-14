/* review template — sections of prose, decisions with working submit, votes. */

import { esc, attr, markdown, widget, badge, makeIdGuard, requireObject, requireArray, requireString, fail } from './_html.js'

export const name = 'review'

const CALLOUT_TONES = ['info', 'success', 'warning', 'error']

const renderBadges = (badges, path) => requireArray(badges ?? [], path)
  .map((b) => {
    const label = typeof b === 'string' ? b : b.label
    const tone = typeof b === 'string' ? null : b.tone
    return badge(label, tone, `${path} tone`)
  }).join('')

/** Layout blocks under a section's prose: a cards grid, callouts, or an island. */
const renderBlocks = (blocks, path) => requireArray(blocks, path).map((b, j) => {
  const p = `${path}[${j}]`
  requireObject(b, p)
  if (b.kind === 'cards') {
    const items = requireArray(b.items, `${p}.items`)
    if (items.length === 0) fail(`${p}.items must not be empty`)
    return `<div class="sd-grid">${items.map((c, k) => {
      const cp = `${p}.items[${k}]`
      requireObject(c, cp)
      const badges = renderBadges(c.badges, `${cp}.badges`)
      return [
        '<div class="sd-card">',
        `<div class="sd-card-title">${esc(requireString(c.title, `${cp}.title`))}</div>`,
        badges ? `<div class="sd-row">${badges}</div>` : '',
        markdown(c.body ?? ''),
        '</div>',
      ].filter(Boolean).join('')
    }).join('')}</div>`
  }
  if (b.kind === 'callouts') {
    const items = requireArray(b.items, `${p}.items`)
    if (items.length === 0) fail(`${p}.items must not be empty`)
    const rendered = items.map((c, k) => {
      const cp = `${p}.items[${k}]`
      requireObject(c, cp)
      if (c.tone !== undefined && !CALLOUT_TONES.includes(c.tone)) {
        fail(`${cp}.tone must be one of ${CALLOUT_TONES.join(', ')}, got "${c.tone}"`)
      }
      return [
        `<div class="sd-callout${c.tone ? ` sd-callout-${c.tone}` : ''}">`,
        c.title ? `<div class="sd-callout-title">${esc(c.title)}</div>` : '',
        markdown(c.body ?? ''),
        '</div>',
      ].filter(Boolean).join('')
    })
    // One callout boxes a thing off on its own; two or more sit side by side.
    return rendered.length === 1 ? rendered[0] : `<div class="sd-grid">${rendered.join('')}</div>`
  }
  if (b.kind === 'island') {
    requireString(b.html, `${p}.html`)
    if (b.height !== undefined && !(Number.isFinite(b.height) && b.height > 0)) fail(`${p}.height must be a positive number`)
    const title = b.title ? ` data-island-title="${attr(b.title)}"` : ''
    const height = b.height ? ` data-island-height="${b.height}"` : ''
    return `<div data-island${title}${height}>${b.html}</div>`
  }
  fail(`${p}.kind must be cards, callouts, or island`)
})

export function render(data) {
  requireObject(data, 'review')
  requireString(data.title, 'review.title')

  const sections = requireArray(data.sections ?? [], 'review.sections')
  const decisions = requireArray(data.decisions ?? [], 'review.decisions')
  const votes = requireArray(data.votes ?? [], 'review.votes')
  const metrics = requireArray(data.metrics ?? [], 'review.metrics')

  if (sections.length === 0 && decisions.length === 0 && votes.length === 0) {
    fail('review: needs at least one of sections, decisions, or votes')
  }
  if (metrics.length && sections.length === 0) {
    fail('review: metrics frame the sections below them — a board of only metrics has nothing to frame')
  }

  const uniqueId = makeIdGuard('review')

  const renderDecision = (d, path) => {
    requireObject(d, path)
    return [
      '<div class="sd-card">',
      d.detail ? `<div class="sd-muted">${markdown(d.detail)}</div>` : '',
      widget({
        type: 'decision',
        id: uniqueId(d.id, `${path}.id`),
        prompt: requireString(d.question, `${path}.question`),
        help: d.context,
        options: requireArray(d.options, `${path}.options`),
      }),
      '</div>',
    ].filter(Boolean).join('\n')
  }

  const renderVote = (v, path) => {
    requireObject(v, path)
    return widget({
      type: v.type === 'approve' ? 'approve' : 'vote',
      id: uniqueId(v.id, `${path}.id`),
      prompt: requireString(v.question, `${path}.question`),
      help: v.context,
      options: requireArray(v.options ?? ['yes', 'no'], `${path}.options`),
    })
  }

  const head = [
    `<h1>${esc(data.title)}</h1>`,
    data.summary ? `<div class="sd-muted">${markdown(data.summary)}</div>` : '',
  ].filter(Boolean).join('\n')

  const metricsHtml = metrics.length
    ? `<section class="sd-section"><div class="sd-metrics">${
        metrics.map((m, i) => {
          requireObject(m, `review.metrics[${i}]`)
          requireString(m.label, `review.metrics[${i}].label`)
          if (m.value === undefined || m.value === null) fail(`review.metrics[${i}].value is required`)
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

  const sectionHtml = sections.map((s, i) => {
    requireObject(s, `review.sections[${i}]`)
    requireString(s.heading, `review.sections[${i}].heading`)
    const body = markdown(s.body ?? '')
    const badges = renderBadges(s.badges, `review.sections[${i}].badges`)
    const blocks = renderBlocks(s.blocks ?? [], `review.sections[${i}].blocks`).join('\n')
    const inlineDecisions = requireArray(s.decisions ?? [], `review.sections[${i}].decisions`)
      .map((d, j) => renderDecision(d, `review.sections[${i}].decisions[${j}]`)).join('\n')
    const inlineVotes = requireArray(s.votes ?? [], `review.sections[${i}].votes`)
      .map((v, j) => renderVote(v, `review.sections[${i}].votes[${j}]`)).join('\n')
    return [
      '<section class="sd-section">',
      `<h2>${esc(s.heading)}</h2>`,
      badges ? `<div class="sd-row">${badges}</div>` : '',
      body,
      blocks,
      inlineDecisions,
      inlineVotes,
      '</section>',
    ].filter(Boolean).join('\n')
  }).join('\n')

  const decisionHtml = decisions.length
    ? [
        '<section class="sd-section">',
        '<h2>Decisions</h2>',
        decisions.map((d, i) => renderDecision(d, `review.decisions[${i}]`)).join('\n'),
        '</section>',
      ].join('\n')
    : ''

  const voteHtml = votes.length
    ? [
        '<section class="sd-section">',
        '<h2>Votes</h2>',
        votes.map((v, i) => renderVote(v, `review.votes[${i}]`)).join('\n'),
        '</section>',
      ].join('\n')
    : ''

  return [head, metricsHtml, sectionHtml, decisionHtml, voteHtml].filter(Boolean).join('\n')
}
