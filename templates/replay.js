/* replay template — conversation exchanges replayed through N labeled arms, one verdict per
   exchange: the message, what each arm replied, and the judge's call to check. */

import { esc, markdown, widget, badge, makeIdGuard, requireObject, requireArray, requireString, fail } from './_html.js'

export const name = 'replay'

const MAX_ARMS = 4
// Past this, a message renders as a lead plus the full text collapsed —
// long pastes must not bury the replies they produced.
const USER_PREVIEW_CHARS = 700

const runLine = (run, path) => {
  requireObject(run, path)
  const bits = Object.entries(run)
    .map(([k, v]) => `<span class="sd-muted">${esc(k)}</span> <strong>${esc(v)}</strong>`)
  if (!bits.length) return ''
  return `<div class="sd-row">${bits.join(' · ')}</div>`
}

/* A hard slice could leave a code fence open and swallow the rest of the card —
   cut at the last paragraph break, then back off past any fence still open. */
const leadOf = (text) => {
  let end = text.lastIndexOf('\n\n', USER_PREVIEW_CHARS)
  if (end < USER_PREVIEW_CHARS / 2) end = USER_PREVIEW_CHARS
  const lines = text.slice(0, end).split('\n')
  let open = -1
  lines.forEach((line, i) => { if (/^\s{0,3}(```|~~~)/.test(line)) open = open === -1 ? i : -1 })
  return (open === -1 ? lines : lines.slice(0, open)).join('\n').trimEnd()
}

const userBlock = (text, path) => {
  requireString(text, path)
  if (text.length <= USER_PREVIEW_CHARS) {
    return `<div class="sd-card"><div class="sd-card-title">user</div>${markdown(text)}</div>`
  }
  const lead = leadOf(text)
  return [
    '<div class="sd-card"><div class="sd-card-title">user</div>',
    `${markdown(lead)}<div class="sd-muted">…</div>`,
    `<details class="sd-collapse"><summary>full message (${text.length.toLocaleString('en-US')} chars)</summary>`,
    `<div class="sd-collapse-body">${markdown(text)}</div></details>`,
    '</div>',
  ].join('\n')
}

const judgeBlock = (judge, path) => {
  requireObject(judge, path)
  const verdict = requireString(judge.verdict, `${path}.verdict`)
  const tone = judge.tone ?? 'info'
  return [
    `<div class="sd-row">${badge(`judge: ${verdict}`, tone, `${path}.tone`)}</div>`,
    judge.reasons ? `<div class="sd-muted">${markdown(String(judge.reasons))}</div>` : '',
  ].filter(Boolean).join('\n')
}

const referenceBlock = (ref, path) => {
  requireObject(ref, path)
  requireString(ref.text, `${path}.text`)
  const label = ref.label ?? 'reference'
  return [
    `<details class="sd-collapse"><summary>${esc(label)}</summary>`,
    `<div class="sd-collapse-body">${markdown(ref.text)}</div></details>`,
  ].join('\n')
}

export function render(data) {
  requireObject(data, 'replay')
  requireString(data.title, 'replay.title')

  const arms = requireArray(data.arms, 'replay.arms').map((a, i) => requireString(a, `replay.arms[${i}]`))
  if (arms.length < 2) fail('replay.arms needs at least 2 arms — one arm is not a comparison')
  if (arms.length > MAX_ARMS) fail(`replay.arms takes at most ${MAX_ARMS} arms; more reply columns stop being readable`)
  if (new Set(arms).size !== arms.length) fail('replay.arms must be unique — they are the reply headings and the vote options')

  const cases = requireArray(data.cases, 'replay.cases')
  if (cases.length === 0) fail('replay: cases must not be empty')

  const uniqueId = makeIdGuard('replay')
  const seen = new Set()

  const caseHtml = cases.map((c, i) => {
    const path = `replay.cases[${i}]`
    requireObject(c, path)
    const id = requireString(c.id, `${path}.id`)
    if (seen.has(id)) fail(`replay: duplicate case id "${id}" — ids must be unique per board`)
    seen.add(id)

    requireObject(c.replies, `${path}.replies`)
    const replies = c.replies
    const missing = arms.filter((a) => replies[a] === undefined)
    if (missing.length) fail(`${path}.replies is missing arm${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')} — every arm replied or the case cannot be judged`)

    const replyCards = [
      '<div class="sd-grid">',
      ...arms.map((a) => [
        '<div class="sd-card">',
        `<div class="sd-card-title">${esc(a)}</div>`,
        markdown(String(replies[a])),
        '</div>',
      ].join('\n')),
      '</div>',
    ].join('\n')

    let verdictHtml = ''
    if (c.verdict !== false) {
      const options = c.verdict === undefined
        ? [...arms, 'tie', 'all-bad']
        : requireArray(c.verdict, `${path}.verdict`).map((o, j) => requireString(o, `${path}.verdict[${j}]`))
      verdictHtml = widget({
        type: 'vote',
        id: uniqueId(`v-${id}`, `${path}.id`),
        prompt: c.ask ?? 'Your call on this exchange?',
        help: c.askHelp,
        options,
      })
    }

    return [
      '<section class="sd-section">',
      `<h2>${esc(c.name ?? id)}</h2>`,
      c.badges ? `<div class="sd-row">${requireArray(c.badges, `${path}.badges`).map((b) => badge(typeof b === 'string' ? b : b.label, typeof b === 'string' ? null : b.tone, `${path}.badges tone`)).join('')}</div>` : '',
      c.context ? `<div class="sd-muted">${markdown(String(c.context))}</div>` : '',
      userBlock(c.user, `${path}.user`),
      replyCards,
      c.judge ? judgeBlock(c.judge, `${path}.judge`) : '',
      c.reference ? referenceBlock(c.reference, `${path}.reference`) : '',
      verdictHtml,
      '</section>',
    ].filter(Boolean).join('\n')
  }).join('\n')

  return [
    `<h1>${esc(data.title)}</h1>`,
    data.summary ? `<div class="sd-muted">${markdown(data.summary)}</div>` : '',
    data.run ? runLine(data.run, 'replay.run') : '',
    caseHtml,
  ].filter(Boolean).join('\n')
}
