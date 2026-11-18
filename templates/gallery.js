/* gallery template — image candidates you judge by looking at them.
   No eval mode renders images; a season of design-call boards hand-built this on page. */

import { esc, markdown, widget, badge, makeIdGuard, requireObject, requireArray, requireString, fail } from './_html.js'

export const name = 'gallery'

const HTTP = /^https?:\/\//i

export function render(data) {
  requireObject(data, 'gallery')
  requireString(data.title, 'gallery.title')

  const groups = requireArray(data.groups ?? [{ candidates: data.candidates ?? [] }], 'gallery.groups')
  if (groups.length === 0) fail('gallery: needs at least one group of candidates')

  const uniqueId = makeIdGuard('gallery')
  const seen = new Set()

  const groupHtml = groups.map((g, i) => {
    const path = `gallery.groups[${i}]`
    requireObject(g, path)
    const candidates = requireArray(g.candidates, `${path}.candidates`)
    if (candidates.length === 0) fail(`${path}.candidates must not be empty`)

    const labels = candidates.map((c, j) => {
      const cp = `${path}.candidates[${j}]`
      requireObject(c, cp)
      const label = requireString(c.label, `${cp}.label`)
      const src = requireString(c.src, `${cp}.src`)
      // The publish sanitizer drops anything else, so a bad src would render an
      // empty card that looks like the candidate failed to generate.
      if (!HTTP.test(src)) fail(`${cp}.src must be an http(s) URL — ${src.slice(0, 40)} will not survive publish`)
      return label
    })
    if (new Set(labels).size !== labels.length) fail(`${path}.candidates labels must be unique — they are the vote options`)

    const cards = candidates.map((c, j) => {
      const width = c.width ? `|${Number(c.width)}` : ''
      return [
        '<div class="sd-card">',
        `<div class="sd-card-title">${esc(c.label)}</div>`,
        markdown(`![${c.label}${width}](${c.src})`),
        c.note ? `<div class="sd-muted">${markdown(c.note)}</div>` : '',
        '</div>',
      ].filter(Boolean).join('\n')
    }).join('\n')

    // One vote across the group, with identical options, so picks aggregate.
    const id = g.id ?? `g${i + 1}`
    if (seen.has(id)) fail(`gallery: duplicate group id "${id}"`)
    seen.add(id)
    const options = g.options === undefined
      ? [...labels, 'none of these']
      : requireArray(g.options, `${path}.options`)
    const vote = g.vote === false ? '' : widget({
      type: 'vote',
      id: uniqueId(`v-${id}`, `${path}.id`),
      prompt: g.ask ?? 'Which one ships?',
      help: g.askHelp,
      options,
    })

    return [
      '<section class="sd-section">',
      g.heading ? `<h2>${esc(g.heading)}</h2>` : '',
      g.badges ? `<div class="sd-row">${requireArray(g.badges, `${path}.badges`).map((b) => badge(typeof b === 'string' ? b : b.label, typeof b === 'string' ? null : b.tone, `${path}.badges tone`)).join('')}</div>` : '',
      g.context ? `<div class="sd-muted">${markdown(g.context)}</div>` : '',
      `<div class="sd-grid">${cards}</div>`,
      vote,
      '</section>',
    ].filter(Boolean).join('\n')
  }).join('\n')

  return [
    `<h1>${esc(data.title)}</h1>`,
    data.summary ? `<div class="sd-muted">${markdown(data.summary)}</div>` : '',
    groupHtml,
  ].filter(Boolean).join('\n')
}
