/* review template — sections of prose, decisions with working submit, votes. */

import { esc, markdown, widget, badge, makeIdGuard, requireObject, requireArray, requireString, fail } from './_html.js'

export const name = 'review'

export function render(data) {
  requireObject(data, 'review')
  requireString(data.title, 'review.title')

  const sections = requireArray(data.sections ?? [], 'review.sections')
  const decisions = requireArray(data.decisions ?? [], 'review.decisions')
  const votes = requireArray(data.votes ?? [], 'review.votes')

  if (sections.length === 0 && decisions.length === 0 && votes.length === 0) {
    fail('review: needs at least one of sections, decisions, or votes')
  }

  const uniqueId = makeIdGuard('review')

  const renderDecision = (d, path) => {
    requireObject(d, path)
    return [
      '<div class="sd-card">',
      widget({
        type: 'decision',
        id: uniqueId(d.id, `${path}.id`),
        prompt: requireString(d.question, `${path}.question`),
        help: d.context,
        options: requireArray(d.options, `${path}.options`),
      }),
      d.detail ? `<div class="sd-muted">${markdown(d.detail)}</div>` : '',
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

  const sectionHtml = sections.map((s, i) => {
    requireObject(s, `review.sections[${i}]`)
    requireString(s.heading, `review.sections[${i}].heading`)
    const body = markdown(s.body ?? '')
    const badges = requireArray(s.badges ?? [], `review.sections[${i}].badges`)
      .map((b) => {
        const label = typeof b === 'string' ? b : b.label
        const tone = typeof b === 'string' ? null : b.tone
        return badge(label, tone, `review.sections[${i}].badges tone`)
      }).join('')
    const inlineDecisions = requireArray(s.decisions ?? [], `review.sections[${i}].decisions`)
      .map((d, j) => renderDecision(d, `review.sections[${i}].decisions[${j}]`)).join('\n')
    const inlineVotes = requireArray(s.votes ?? [], `review.sections[${i}].votes`)
      .map((v, j) => renderVote(v, `review.sections[${i}].votes[${j}]`)).join('\n')
    return [
      '<section class="sd-section">',
      `<h2>${esc(s.heading)}</h2>`,
      badges ? `<div class="sd-row">${badges}</div>` : '',
      body,
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

  return [head, sectionHtml, decisionHtml, voteHtml].filter(Boolean).join('\n')
}
