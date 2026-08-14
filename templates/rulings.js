/* rulings template — labeled cases adjudicated one by one, grouped by decision:
   sections ordered by judgment needed, one vote per case, skim sections one line each. */

import { esc, markdown, widget, attr, badge, makeIdGuard, requireObject, requireArray, requireString, fail } from './_html.js'

export const name = 'rulings'

const DEFAULT_CASE_OPTIONS = ['good', 'bad']
const DEFAULT_SECTION_OPTIONS = ['section is right', 'needs amending']

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/* FNV-1a — same shape as answer-key's: slugs are lossy, so the digest keeps
   punctuation-distinct and non-Latin titles from colliding. */
function digest(...parts) {
  let h = 0x811c9dc5
  for (const ch of parts.map((x) => String(x).length + ':' + x).join('')) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(7, '0')
}

export function render(data) {
  requireObject(data, 'rulings')
  requireString(data.title, 'rulings.title')
  requireString(data.intro, 'rulings.intro')
  requireString(data.footer, 'rulings.footer')

  const labels = labelMap(data.labels)
  const sections = requireArray(data.sections, 'rulings.sections')
  if (sections.length === 0) fail('rulings.sections must not be empty')

  const uniqueId = makeIdGuard('rulings')
  const ctx = { labels, data, uniqueId }

  return [
    '<div class="sd-masthead">',
    `<h1>${esc(data.title)}</h1>`,
    statusTags(data.status_badges),
    `<div class="sd-intro">${markdown(data.intro)}</div>`,
    '</div>',
    teachBlock(data.teach, labels),
    questionsBlock(data.questions, ctx),
    sections.map((s, i) => section(s, i, ctx)).join('\n'),
    `<section class="sd-section sd-colophon">${markdown(data.footer)}</section>`,
  ].filter(Boolean).join('\n')
}

function labelMap(raw) {
  requireObject(raw, 'rulings.labels')
  const entries = Object.entries(raw)
  if (entries.length === 0) fail('rulings.labels must not be empty — every case label needs a plain-language description')
  const map = new Map()
  for (const [key, desc] of entries) {
    requireString(desc, `rulings.labels["${key}"]`)
    map.set(key, desc)
  }
  return map
}

function statusTags(list) {
  if (list === undefined || list === null) return ''
  const items = requireArray(list, 'rulings.status_badges')
  return items.length
    ? `<div class="sd-row sd-taglist">${items.map((b, i) => {
        requireObject(b, `rulings.status_badges[${i}]`)
        requireString(b.text, `rulings.status_badges[${i}].text`)
        const style = b.style && ['success', 'info', 'warning', 'error', 'neutral'].includes(b.style) ? b.style : 'neutral'
        return `<span class="sd-badge sd-badge-${style}">${esc(b.text)}</span>`
      }).join('')}</div>`
    : ''
}

/* Teach-first is inherited from the answer-key protocol: the reviewer meets the
   label definitions before any case, or they judge against their own. */
function teachBlock(teach, labels) {
  requireObject(teach, 'rulings.teach')
  requireString(teach.lead, 'rulings.teach.lead')
  const defs = [...labels.entries()].map(([key, desc]) => [
    '<div class="sd-step">',
    `<div class="sd-step-body">`,
    `<div class="sd-step-title sd-mono">${esc(key)}</div>`,
    `<div class="sd-muted">${esc(desc)}</div>`,
    '</div>',
    '</div>',
  ].join('')).join('')
  return [
    '<section class="sd-section">',
    '<h2>How to read this board — start here</h2>',
    `<div>${markdown(teach.lead)}</div>`,
    `<div class="sd-steps">${defs}</div>`,
    teach.footnote ? `<p class="sd-muted">${markdown(teach.footnote)}</p>` : '',
    '</section>',
  ].filter(Boolean).join('')
}

/* Open policy questions are first-class: each is one decision widget, not prose
   the reviewer must notice inside an intro paragraph. */
function questionsBlock(questions, ctx) {
  if (questions === undefined || questions === null) return ''
  const items = requireArray(questions, 'rulings.questions')
  if (items.length === 0) return ''
  const html = items.map((q, i) => {
    const at = `rulings.questions[${i}]`
    requireObject(q, at)
    requireString(q.prompt, `${at}.prompt`)
    return widget({
      type: 'decision',
      id: ctx.uniqueId(`question-${digest(q.prompt)}`),
      prompt: q.prompt,
      help: q.help,
      options: requireArray(q.options, `${at}.options`),
    })
  }).join('')
  return `<section class="sd-section"><h2>Open questions — your call decides these</h2>${html}</section>`
}

function section(s, i, ctx) {
  const at = `rulings.sections[${i}]`
  requireObject(s, at)
  requireString(s.heading, `${at}.heading`)
  const cases = requireArray(s.cases, `${at}.cases`)
  if (cases.length === 0) fail(`${at}.cases must not be empty`)

  /* [] = skim section (no votes); undefined = per-case default —
     contested cases adjudicate key-vs-model, uncontested get good/bad. */
  const explicitOptions = s.options ?? ctx.data.case_options
  if (explicitOptions !== undefined) requireArray(explicitOptions, `${at}.options`)
  const caseOptions = (c) => {
    if (explicitOptions !== undefined) return explicitOptions
    const dissent = dissentLabel(c)
    if (dissent) return [`key is good: ${c.label}`, `model is good: ${dissent}`, 'neither']
    return DEFAULT_CASE_OPTIONS
  }
  const sectionOptions = requireArray(ctx.data.section_options ?? DEFAULT_SECTION_OPTIONS, 'rulings.section_options')

  return [
    '<section class="sd-section">',
    `<h2>${esc(s.heading)}</h2>`,
    s.help ? `<div class="sd-muted">${markdown(s.help)}</div>` : '',
    `<div class="sd-count sd-muted">${cases.length} ${cases.length === 1 ? 'case' : 'cases'}</div>`,
    `<div class="sd-claims"><ul>${cases.map((c, n) => caseBlock(c, `${at}.cases[${n}]`, caseOptions(c), ctx)).join('')}</ul></div>`,
    widget({
      type: 'decision',
      id: ctx.uniqueId(`section-${slug(s.heading)}-${digest(s.heading)}`),
      prompt: `Is "${s.heading}" right as a whole?`,
      help: 'Answer at the section level — a systemic problem should not arrive as scattered per-case notes.',
      options: sectionOptions,
    }),
    '</section>',
  ].filter(Boolean).join('\n')
}

/* The model's verdict when it differs from the key's; null when they agree or
   when none was recorded — different states, both pill-less here. */
function dissentLabel(c) {
  if (c.counter?.label) return c.counter.label
  if (typeof c.model === 'string' && c.model && c.model !== c.label) return c.model
  return null
}

function caseBlock(c, at, caseOptions, ctx) {
  requireObject(c, at)
  requireString(c.title, `${at}.title`)
  const label = requireString(c.label, `${at}.label`)
  if (!ctx.labels.has(label)) {
    fail(`${at}.label "${label}" has no entry in rulings.labels — a reviewer must never meet an undefined label`)
  }

  if (c.model !== undefined) {
    const m = requireString(c.model, `${at}.model`)
    if (!ctx.labels.has(m)) fail(`${at}.model "${m}" has no entry in rulings.labels`)
  }
  /* The verdicts lead the body — the contest, or its absence, reads before any prose. */
  const verdicts = []
  const dissent = dissentLabel(c)
  if (c.model !== undefined && !dissent) {
    verdicts.push(badge('key + model aligned', 'success', at, 'the model returned the same label the key did — nothing to adjudicate'))
  }
  verdicts.push(badge(`key says: ${label}`, 'info', at, ctx.labels.get(label)))
  if (dissent) {
    verdicts.push(badge(`model says: ${dissent}`, 'warning', at, ctx.labels.get(dissent) ?? "the model's verdict on this case"))
  }
  if (c.borderline) verdicts.push(badge('borderline', 'neutral', at, 'keyed away from the penalized label under the tie-break; this ruling moves the metric'))
  const verdictRow = `<div class="sd-verdicts">${verdicts.join('')}</div>`

  const counter = c.counter
    ? (() => {
        requireObject(c.counter, `${at}.counter`)
        requireString(c.counter.label, `${at}.counter.label`)
        requireString(c.counter.reason, `${at}.counter.reason`)
        const saw = c.counter.saw !== undefined
          ? `<div class="sd-note sd-saw"><span class="sd-eyebrow">what the model saw</span>${markdown(requireString(c.counter.saw, `${at}.counter.saw`))}</div>`
          : ''
        return saw + `<div class="sd-note sd-counter"><span class="sd-eyebrow sd-eyebrow-strict">model rationale</span>${markdown(c.counter.reason)}</div>`
      })()
    : ''

  const quote = c.quote
    ? (() => {
        requireObject(c.quote, `${at}.quote`)
        requireString(c.quote.text, `${at}.quote.text`)
        return [
          '<div class="sd-evidence">',
          c.quote.source ? `<span class="sd-evidence-pointer sd-mono">${esc(c.quote.source)}</span>` : '',
          `<span class="sd-evidence-text">${esc(c.quote.text)}</span>`,
          '</div>',
        ].filter(Boolean).join('')
      })()
    : ''

  const vote = caseOptions.length
    ? widget({
        type: 'vote',
        id: ctx.uniqueId(`case-${slug(c.title).slice(0, 40)}-${digest(at, c.title)}`),
        options: caseOptions,
        compact: true,
      })
    : ''

  let image = ''
  if (c.image !== undefined) {
    let spec
    if (typeof c.image === 'string') spec = { src: c.image }
    else {
      requireObject(c.image, `${at}.image`)
      spec = c.image
    }
    const src = requireString(spec.src, `${at}.image.src`)
    if (!/^https?:\/\//.test(src)) fail(`${at}.image.src must be an http(s) URL — the publish sanitizer drops anything else`)
    let width = ''
    if (spec.px !== undefined) {
      if (!Number.isFinite(spec.px) || spec.px < 16 || spec.px > 800) fail(`${at}.image.px must be a number 16..800`)
      width = ` width="${Math.round(spec.px)}"`
    }
    const cls = `sd-case-image${spec.round ? ' sd-case-image-round' : ''}`
    image = `<img class="${cls}" src="${attr(src)}" alt="${attr(c.title)}"${width}>`
  }
  if (c.footnote !== undefined) requireString(c.footnote, `${at}.footnote`)

  let ask = ''
  if (c.ask !== undefined) {
    let text = c.ask
    let askWidget = ''
    if (typeof c.ask !== 'string') {
      requireObject(c.ask, `${at}.ask`)
      text = requireString(c.ask.text, `${at}.ask.text`)
      const opts = requireArray(c.ask.options, `${at}.ask.options`)
      if (opts.length === 0) fail(`${at}.ask.options must not be empty — use a plain string for advisory prose`)
      askWidget = widget({
        type: 'decision',
        id: ctx.uniqueId(`ask-${slug(c.title).slice(0, 40)}-${digest(at, 'ask')}`),
        options: opts,
        compact: true,
      })
    }
    ask = `<div class="sd-ask"><span class="sd-eyebrow">your agent</span>${markdown(text)}${askWidget}</div>`
  }

  // "i cant vote on these without seeing what date the run is for" — provenance
  // rides above the verdict, not in the footnote's small print.
  const context = c.context !== undefined
    ? `<div class="sd-note sd-case-context"><span class="sd-eyebrow">what this case is</span>${markdown(requireString(c.context, `${at}.context`))}</div>`
    : ''

  const body = [
    context,
    image,
    c.rationale ? `<div class="sd-ruling"><span class="sd-eyebrow">key rationale</span>${markdown(requireString(c.rationale, `${at}.rationale`))}</div>` : '',
    quote,
    counter,
    vote,
    ask,
    c.footnote ? `<div class="sd-case-footnote">${esc(c.footnote)}</div>` : '',
  ].filter(Boolean).join('')
  /* A case with a body folds, and its verdicts lead that body; a skim case has
     nothing to fold, so they ride the title or the line would say nothing. */
  if (!body) return `<li><div class="sd-case-title">${esc(c.title)} ${verdicts.join('')}</div></li>`
  return [
    '<li>',
    '<details class="sd-collapse" open>',
    `<summary><span class="sd-case-title">${esc(c.title)}</span></summary>`,
    `<div class="sd-collapse-body">${verdictRow}${body}</div>`,
    '</details>',
    '</li>',
  ].join('')
}
