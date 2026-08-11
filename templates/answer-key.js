/* answer-key template — teach-first preamble, then category x person cells.
   Evidence arrives already resolved; the template never reaches a database. */

import { esc, markdown, widget, badge, attr, makeIdGuard, requireObject, requireArray, requireString, fail } from './_html.js'

export const name = 'answer-key'

const DEFAULT_MUST_NOT_VIOLATE = 'zero tolerance — any violation fails the case'
const DEFAULT_CELL_OPTIONS = ['looks right', 'has a problem']
const DEFAULT_VERDICT_OPTIONS = ['scope is right', 'mis-scoped', 'needs a contract change']

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/* FNV-1a. The readable slug is lossy — "C++" and "C#" both reduce to "c", and a
   non-Latin name reduces to nothing — so the raw value rides along as a digest. */
function digest(...parts) {
  let h = 0x811c9dc5
  for (const ch of parts.map((x) => String(x).length + ':' + x).join('')) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(7, '0')
}

const widgetId = (prefix, ...parts) => [prefix, ...parts.map(slug).filter(Boolean), digest(...parts)].join('-')

const eyebrow = (text, strict) => `<div class="sd-eyebrow${strict ? ' sd-eyebrow-strict' : ''}">${esc(text)}</div>`

/* Outlined text, not a saturated fill: these name a reason, they do not raise
   an alarm. Only the zero-tolerance tier keeps a filled treatment. */
function tag(label, path, title) {
  requireString(label, path)
  const titleAttr = title ? ` title="${attr(title)}"` : ''
  return `<span class="sd-tag"${titleAttr}>${esc(label)}</span>`
}

/* An authored `style` is data, not decoration: dropping it would silently turn
   a key author's "error" into grey. Outlined tag only when none was supplied. */
function statusMark(label, style, stylePath, labelPath, title) {
  if (style === undefined || style === null || style === '') return tag(label, labelPath, title)
  requireString(label, labelPath)
  return badge(label, style, stylePath, title)
}

export function render(data) {
  requireObject(data, 'answer-key')
  requireString(data.title, 'answer-key.title')
  requireString(data.intro, 'answer-key.intro')
  requireString(data.footer, 'answer-key.footer')

  const cells = requireArray(data.cells, 'answer-key.cells')
  if (cells.length === 0) fail('answer-key.cells must not be empty')

  const categoryLabels = labelMap(data.category_labels)
  const reasons = reasonMap(data.reasons)
  const mustNotViolateLabel = data.must_not_violate_label ?? DEFAULT_MUST_NOT_VIOLATE
  requireString(mustNotViolateLabel, 'answer-key.must_not_violate_label')

  const uniqueId = makeIdGuard('answer-key')

  // Teach before content is the load-bearing ordering, not a style choice: a
  // reviewer who meets an entry before the rules judges it against their own.
  const parts = [
    '<div class="sd-masthead">',
    `<h1>${esc(data.title)}</h1>`,
    statusTags(data.status_badges),
    `<div class="sd-intro">${markdown(data.intro)}</div>`,
    '</div>',
    teachBlock(data.teach),
    checkFocus(data.check_focus),
    categorySections(cells, { categoryLabels, reasons, mustNotViolateLabel, data, uniqueId }),
    howToTest(data.how_to_test),
    `<section class="sd-section sd-colophon">${markdown(data.footer)}</section>`,
  ]

  return parts.filter(Boolean).join('\n')
}

function statusTags(list) {
  if (list === undefined || list === null) return ''
  const items = requireArray(list, 'answer-key.status_badges')
  if (items.length === 0) return ''
  const html = items.map((b, i) => {
    requireObject(b, `answer-key.status_badges[${i}]`)
    return statusMark(b.text, b.style, `answer-key.status_badges[${i}].style`, `answer-key.status_badges[${i}].text`)
  }).join('')
  return `<div class="sd-row sd-taglist">${html}</div>`
}

function teachBlock(teach) {
  requireObject(teach, 'answer-key.teach')
  requireString(teach.lead, 'answer-key.teach.lead')
  requireString(teach.positives, 'answer-key.teach.positives')
  requireString(teach.negatives, 'answer-key.teach.negatives')
  const steps = requireArray(teach.steps, 'answer-key.teach.steps')
  if (steps.length === 0) fail('answer-key.teach.steps must not be empty — the board must explain the eval before any content')

  const stepRows = steps.map((s, i) => {
    requireObject(s, `answer-key.teach.steps[${i}]`)
    requireString(s.title, `answer-key.teach.steps[${i}].title`)
    requireString(s.desc, `answer-key.teach.steps[${i}].desc`)
    return [
      '<div class="sd-step">',
      `<div class="sd-step-index">${i + 1}</div>`,
      '<div class="sd-step-body">',
      `<div class="sd-step-title">${esc(s.title)}</div>`,
      `<div class="sd-muted">${esc(s.desc)}</div>`,
      '</div>',
      '</div>',
    ].join('')
  }).join('')

  return [
    '<section class="sd-section">',
    '<h2>How this eval works — read this first</h2>',
    `<div>${markdown(teach.lead)}</div>`,
    `<div class="sd-steps">${stepRows}</div>`,
    '<div class="sd-rules">',
    `<div class="sd-rule">${eyebrow('the output should include these')}${markdown(teach.positives)}</div>`,
    `<div class="sd-rule">${eyebrow('the output must NOT include these', true)}${markdown(teach.negatives)}</div>`,
    '</div>',
    teach.footnote ? `<div class="sd-muted">${markdown(teach.footnote)}</div>` : '',
    '</section>',
  ].filter(Boolean).join('\n')
}

function checkFocus(list) {
  const items = requireArray(list, 'answer-key.check_focus')
  if (items.length === 0) fail('answer-key.check_focus must not be empty — the reviewer needs to know what to check')
  const lis = items.map((it, i) => {
    requireObject(it, `answer-key.check_focus[${i}]`)
    requireString(it.text, `answer-key.check_focus[${i}].text`)
    const mark = statusMark(it.label, it.style, `answer-key.check_focus[${i}].style`, `answer-key.check_focus[${i}].label`)
    return `<li>${mark} ${esc(it.text)}</li>`
  }).join('')
  return [
    '<section class="sd-section sd-focus">',
    eyebrow('what to check on every row'),
    `<ul class="sd-focus-list">${lis}</ul>`,
    '</section>',
  ].join('\n')
}

/* A category with no plain-language label would put an internal name in front of
   the reviewer — the failure the review protocol names outright. Throw, never warn. */
function labelMap(raw) {
  requireObject(raw ?? fail('answer-key.category_labels is required — every category needs a plain-language label'), 'answer-key.category_labels')
  const out = new Map()
  for (const [key, label] of Object.entries(raw)) {
    out.set(key, requireString(label, `answer-key.category_labels["${key}"]`))
  }
  return out
}

function reasonMap(raw) {
  requireObject(raw ?? fail('answer-key.reasons is required — every negative names a reason and each reason needs a description'), 'answer-key.reasons')
  const out = new Map()
  for (const [key, value] of Object.entries(raw)) {
    requireObject(value, `answer-key.reasons["${key}"]`)
    requireString(value.label, `answer-key.reasons["${key}"].label`)
    requireString(value.desc, `answer-key.reasons["${key}"].desc`)
    out.set(key, value)
  }
  return out
}

function categorySections(cells, ctx) {
  const byCategory = new Map()
  cells.forEach((cell, i) => {
    requireObject(cell, `answer-key.cells[${i}]`)
    requireString(cell.category, `answer-key.cells[${i}].category`)
    requireString(cell.person, `answer-key.cells[${i}].person`)
    if (!ctx.categoryLabels.has(cell.category)) {
      fail(`answer-key.cells[${i}].category "${cell.category}" has no entry in category_labels — a reviewer must never meet an internal name`)
    }
    if (!byCategory.has(cell.category)) byCategory.set(cell.category, [])
    byCategory.get(cell.category).push({ cell, i })
  })

  return [...byCategory.entries()].map(([category, group]) => {
    const entries = group.map(({ cell, i }) => cellEntry(cell, i, ctx)).join('')
    const verdictOptions = requireArray(ctx.data.verdict_options ?? DEFAULT_VERDICT_OPTIONS, 'answer-key.verdict_options')
    return [
      '<section class="sd-section">',
      `<h2>${esc(ctx.categoryLabels.get(category))}</h2>`,
      `<div class="sd-count sd-muted">${group.length} ${group.length === 1 ? 'person' : 'people'}</div>`,
      `<div class="sd-entries">${entries}</div>`,
      widget({
        type: 'decision',
        id: ctx.uniqueId(widgetId('verdict', category)),
        prompt: `Is "${ctx.categoryLabels.get(category)}" scoped correctly as a whole?`,
        help: 'Answer at the category level — a systemic problem should not arrive as scattered per-entry notes.',
        options: verdictOptions,
      }),
      '</section>',
    ].join('\n')
  }).join('\n')
}

function cellEntry(cell, i, ctx) {
  const path = `answer-key.cells[${i}]`
  const meta = requireArray(cell.header ?? [], `${path}.header`)
    .map((h, n) => `<span>${esc(requireString(h, `${path}.header[${n}]`))}</span>`).join('')

  const positives = requireArray(cell.positives ?? [], `${path}.positives`)
  const negatives = requireArray(cell.negatives ?? [], `${path}.negatives`)
  if (positives.length === 0 && negatives.length === 0) {
    fail(`${path} has neither positives nor negatives — an empty cell tells the reviewer nothing`)
  }

  const cellOptions = requireArray(ctx.data.cell_options ?? DEFAULT_CELL_OPTIONS, 'answer-key.cell_options')
  /* A cell's own entry_options wins; [] switches per-entry votes off for that
     cell (e.g. a routine skim section on a board that votes everywhere else). */
  const entryOptions = requireArray(cell.entry_options ?? ctx.data.entry_options ?? [], `${path}.entry_options`)
  const cellCtx = { ...ctx, entryOptions, category: cell.category, person: cell.person }

  return [
    '<div class="sd-entry">',
    `<div class="sd-entry-name">${esc(cell.person)}</div>`,
    meta ? `<div class="sd-entry-meta sd-muted sd-mono">${meta}</div>` : '',
    entryList(positives, `${path}.positives`, 'positive', cellCtx),
    entryList(negatives, `${path}.negatives`, 'negative', cellCtx),
    widget({
      type: 'approve',
      id: ctx.uniqueId(widgetId('cell', cell.category, cell.person)),
      prompt: `${cell.person} — does this cell look right?`,
      options: cellOptions,
    }),
    '</div>',
  ].filter(Boolean).join('')
}

function entryList(entries, path, kind, ctx) {
  if (entries.length === 0) return ''
  const heading = kind === 'positive'
    ? eyebrow('should include')
    : eyebrow('must not include', true)

  const items = entries.map((entry, n) => {
    const at = `${path}[${n}]`
    requireObject(entry, at)
    requireString(entry.content, `${at}.content`)

    const flags = []
    if (kind === 'positive' && entry.must_not_violate) {
      flags.push(`<span class="sd-flag">${esc(ctx.mustNotViolateLabel)}</span>`)
    }
    if (kind === 'negative') {
      const key = requireString(entry.reason, `${at}.reason`)
      const reason = ctx.reasons.get(key)
      if (!reason) fail(`${at}.reason "${key}" has no entry in answer-key.reasons — every reason needs a plain-language description`)
      flags.push(statusMark(reason.label, reason.style, `answer-key.reasons["${key}"].style`, `answer-key.reasons["${key}"].label`, reason.desc))
    }

    const vote = (ctx.entryOptions ?? []).length
      ? widget({
          type: 'vote',
          id: ctx.uniqueId(`case-${slug(ctx.person)}-${digest(ctx.category, ctx.person, kind, String(n), entry.content)}`),
          options: ctx.entryOptions,
          compact: true,
        })
      : ''
    return [
      '<li>',
      esc(entry.content),
      flags.length ? ` ${flags.join(' ')}` : '',
      entry.note ? `<div class="sd-muted sd-note">${esc(entry.note)}</div>` : '',
      evidenceChips(entry.evidence, `${at}.evidence`, ctx),
      vote,
      '</li>',
    ].filter(Boolean).join('')
  }).join('')

  return `<div class="sd-claims">${heading}<ul>${items}</ul></div>`
}

/* Renders inline before every pointer (chips are inert — the pre-easel builder's
   click-to-copy semantics do not apply), so a command-length prefix is a hard error. */
const EVIDENCE_PREFIX_MAX = 16

function evidencePrefix(data) {
  const prefix = data.evidence_copy_prefix
  if (prefix === undefined || prefix === null || prefix === '') return ''
  requireString(prefix, 'answer-key.evidence_copy_prefix')
  if (prefix.length > EVIDENCE_PREFIX_MAX) {
    fail(
      `answer-key.evidence_copy_prefix is ${prefix.length} chars — it renders inline before every evidence pointer, not as a click-to-copy payload. ` +
      `Keep it a short token (≤${EVIDENCE_PREFIX_MAX} chars, e.g. "evrow "); put full commands in how_to_test.code_blocks instead.`,
    )
  }
  return prefix
}

/* Inert by design: the pointer is selectable text, not a copy button. */
function evidenceChips(evidence, path, ctx) {
  const items = requireArray(evidence ?? [], path)
  if (items.length === 0) return ''
  return items.map((ev, n) => {
    const at = `${path}[${n}]`
    requireObject(ev, at)
    const pointer = requireString(ev.pointer, `${at}.pointer`)
    const prefix = evidencePrefix(ctx.data)
    const excerpt = ev.text
      ? esc(ev.text)
      : '(evidence text was not resolved at build time)'
    return [
      '<div class="sd-evidence">',
      `<span class="sd-evidence-pointer sd-mono">${esc(prefix)}${esc(pointer)}</span>`,
      `<span class="sd-evidence-text">${excerpt}</span>`,
      '</div>',
    ].join('')
  }).join('')
}

function howToTest(spec) {
  if (spec === undefined || spec === null) return ''
  requireObject(spec, 'answer-key.how_to_test')
  const steps = requireArray(spec.review_steps ?? [], 'answer-key.how_to_test.review_steps')
  const blocks = requireArray(spec.code_blocks ?? [], 'answer-key.how_to_test.code_blocks')
  if (steps.length === 0 && blocks.length === 0) return ''

  const stepList = steps.length
    ? `<ol>${steps.map((s, i) => `<li>${esc(requireString(s, `answer-key.how_to_test.review_steps[${i}]`))}</li>`).join('')}</ol>`
    : ''
  const blockHtml = blocks.map((b, i) => {
    const at = `answer-key.how_to_test.code_blocks[${i}]`
    requireObject(b, at)
    requireString(b.title, `${at}.title`)
    requireString(b.code, `${at}.code`)
    return [
      `<div class="sd-code-title">${esc(b.title)}</div>`,
      b.note ? `<div class="sd-muted">${esc(b.note)}</div>` : '',
      `<pre><code>${esc(b.code)}</code></pre>`,
    ].filter(Boolean).join('')
  }).join('')

  return [
    '<section class="sd-section">',
    '<h2>How to dig further</h2>',
    stepList,
    blockHtml,
    '</section>',
  ].filter(Boolean).join('\n')
}
