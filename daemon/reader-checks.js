/* What a cold reader trips on, found by pattern on the built html. Advisory
   only: publish prints each finding with its rule and refuses nothing. */

const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
const words = (s) => strip(s).split(/\s+/).filter(Boolean)

const POINTERS = /\b(see round \d+|as (?:we )?discussed|your round[- ]\d+ ruling|full (?:text|note): \/|section \d+[a-z]? of the (?:approved|earlier)|on the other board)\b/gi
const RULES = {
  wall: 'Every paragraph takes the shape of what it is made of (authoring.md)',
  shorthand: 'Gloss every internal name, the first time it appears (authoring.md)',
  pointer: 'Restate, never point (authoring.md)',
  label: 'A decision carries the basis for answering it — the label is two or three words (authoring.md)',
  formatting: 'Look at the page before announcing it',
  prose: 'A long section carries a list, table, or block (review.md)',
  table: 'One row per thing, not one per pair — a repeating first column is a cross product (authoring.md)',
}

const STRUCTURE = /<table|<ul|<ol|<pre|<details|sd-grid|sd-card|sd-callout|data-island/

export function readerChecks(html) {
  // Quoted specimens are not the author's prose; baked diagrams and styles are not prose at all.
  html = html.replace(/<(blockquote|svg|style)\b[\s\S]*?<\/\1>/gi, ' ')
  const findings = []
  const add = (type, detail, sample) => findings.push({ type, rule: RULES[type], detail, sample })

  // Walls: a paragraph over ~110 words.
  for (const m of html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
    const w = words(m[1])
    if (w.length > 110) add('wall', `${w.length}-word paragraph`, w.slice(0, 8).join(' ') + ' …')
  }

  // Prose-only sections: over 250 words with nothing but paragraphs.
  for (const m of html.matchAll(/<section\b[^>]*\bsd-section\b[^>]*>([\s\S]*?)<\/section>/g)) {
    const heading = strip((m[1].match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || ['', ''])[1])
    const w = words(m[1].replace(/<h2[^>]*>[\s\S]*?<\/h2>/, ' '))
    if (w.length > 250 && !STRUCTURE.test(m[1])) {
      add('prose', `${w.length}-word section with no list, table, or block`, heading)
    }
  }

  // A first column that repeats is a cross product flattened to one row per pair.
  // Both conditions hold together: a short table and a table of distinct labels stay clean.
  for (const m of html.matchAll(/<table\b[\s\S]*?<\/table>/g)) {
    const body = [...m[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((r) => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => strip(c[1])))
      .filter((cells) => cells.length)
    if (body.length < 6) continue
    const first = body.map((r) => r[0] ?? '')
    const counts = new Map()
    for (const v of first) counts.set(v, (counts.get(v) ?? 0) + 1)
    if (counts.size * 2 > body.length) continue
    const [worst, n] = [...counts].sort((a, b) => b[1] - a[1])[0]
    add('table', `${body.length}-row table, ${counts.size} distinct values in the first column`, `"${worst}" ${n} times`)
  }

  // Shorthand: campaign codes, callsigns, ticket ids and snake_case outside code,
  // not defined in any table cell.
  const prose = html.replace(/<(pre|code)[\s\S]*?<\/\1>/g, ' ')
  const defined = new Set([...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].flatMap((m) => strip(m[1]).split(/[,/·]/).map((t) => t.trim())))
  const tokens = new Map()
  for (const m of strip(prose).matchAll(/\b([A-Z]{2,5}-\d{1,4}|[a-z]{2}-[a-z]\d|[a-z]+_[a-z_]+[a-z]|[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)+)\b/g)) {
    const t = m[1]
    if ([...defined].some((d) => d.includes(t))) continue
    tokens.set(t, (tokens.get(t) ?? 0) + 1)
  }
  if (tokens.size) add('shorthand', `${tokens.size} undefined token${tokens.size > 1 ? 's' : ''}`, [...tokens.keys()].slice(0, 8).join(', '))

  // Pointers.
  const pointers = [...strip(prose).matchAll(POINTERS)].map((m) => m[0])
  if (pointers.length) add('pointer', `${pointers.length} pointer${pointers.length > 1 ? 's' : ''} to content not on this round`, [...new Set(pointers)].slice(0, 5).join(' · '))

  // Labels: a button over five words.
  for (const m of html.matchAll(/<button[^>]*data-option="[^"]*"[^>]*>([\s\S]*?)<\/button>/g)) {
    const w = words(m[1])
    if (w.length > 5) add('label', `${w.length}-word button`, w.slice(0, 8).join(' ') + ' …')
  }

  // Formatting bugs.
  const escaped = (html.match(/&lt;(br|details|summary|b|i|p)\b/g) || []).length
  if (escaped) add('formatting', `${escaped} html tag${escaped > 1 ? 's' : ''} printed as text`, (html.match(/&lt;[a-z]+[^&]{0,20}/) || [''])[0])
  const placeholders = html.match(/\{[A-Z_]{2,}\}/g)
  if (placeholders) add('formatting', `${placeholders.length} unfilled placeholder${placeholders.length > 1 ? 's' : ''}`, [...new Set(placeholders)].slice(0, 5).join(' '))
  const bare = [...strip(prose.replace(/<a\b[\s\S]*?<\/a>/g, ' ')).matchAll(/(?<![\w/])#\d{3,5}\b/g)].map((m) => m[0])
  if (bare.length) add('formatting', `${bare.length} PR number${bare.length > 1 ? 's' : ''} with no link`, [...new Set(bare)].slice(0, 6).join(' '))
  const dashRows = (html.match(/<tr>(?:<td[^>]*>\s*[—–-]\s*<\/td>){2,}<\/tr>/g) || []).length
  if (dashRows) add('formatting', `${dashRows} table row${dashRows > 1 ? 's' : ''} of only dashes`, '')

  return findings
}

/** Findings not present in the previous round's set, plus a count of the ones that were. */
export function sinceLast(current, previous) {
  const key = (f) => `${f.type}|${f.detail}|${f.sample}`
  const seen = new Set(previous.map(key))
  const fresh = current.filter((f) => !seen.has(key(f)))
  return { fresh, carried: current.length - fresh.length }
}

/** The publish-output shape: one line per finding, rule first. Returns '' when clean. */
export function formatFindings(findings) {
  if (!findings.length) return ''
  return 'reader checks:\n' + findings.map((f) => `• ${f.detail}${f.sample ? ` — "${f.sample}"` : ''}\n    rule: ${f.rule}`).join('\n')
}
