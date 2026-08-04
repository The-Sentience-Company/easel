/* Publish-time diff rendering: <pre class="sd-diff">unified diff</pre> becomes one
   block element per line. Renders a supplied diff; never computes one. */

const PRE = /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

/* Walks the attributes in order rather than searching the whole string: a
   title or data- value mentioning class="sd-diff" must not claim the block. */
const hasClass = (attrs, want) => {
  ATTR.lastIndex = 0
  for (let m = ATTR.exec(attrs); m; m = ATTR.exec(attrs)) {
    if (m[1].toLowerCase() !== 'class') continue
    return (m[2] ?? m[3] ?? m[4] ?? '').split(/\s+/).includes(want)
  }
  return false
}

/* Order matters: a file header starts with --- or +++ and would otherwise read
   as a removed or added line. */
function classify(line) {
  if (/^(diff |index |similarity |rename |new file|deleted file|old mode|new mode)/.test(line)) return 'meta'
  if (/^(---|\+\+\+|−−−)(\s|$)/.test(line)) return 'meta'
  if (/^@@/.test(line)) return 'hunk'
  if (/^\\ No newline/.test(line)) return 'meta'
  if (line.startsWith('+')) return 'add'
  // U+2212: LLM-authored diffs substitute the typographic minus for ASCII '-'.
  if (line.startsWith('-') || line.startsWith('−')) return 'del'
  return 'ctx'
}

const MARKED = new Set(['add', 'del', 'ctx'])

/* Punctuation is its own token, so "words." still matches the "words" it grew from.
   Entities lead: splitting &lt; would put a mark inside markup. Whitespace kept as-is. */
const TOKEN = /&[a-zA-Z][a-zA-Z0-9]*;|&#\d+;|&#x[0-9a-fA-F]+;|\s+|[\w']+|[^\s\w]/g
const tokenize = (s) => s.match(TOKEN) ?? []

/* ~1000 differing tokens a side: 4MB and 7ms, once per paired line, and past any
   real prose line. Beyond it the middle is marked whole, as it always was. */
const MAX_LCS_CELLS = 1000000

/* Four separate tints on one line stop reading as "these words changed". */
const MAX_MARK_RUNS = 3

/* Which positions on each side changed, as two boolean lists. Null when the
   lines share no edge tokens — marking everything says nothing the tint has not. */
function changedFlags(a, b) {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head &&
         a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  if (head === 0 && tail === 0) return null

  const fa = new Array(a.length).fill(false)
  const fb = new Array(b.length).fill(false)
  const mid = (f, len) => { for (let i = head; i < len - tail; i++) f[i] = true }
  const n = a.length - tail - head
  const m = b.length - tail - head
  if (n <= 0 || m <= 0 || n * m > MAX_LCS_CELLS) {
    mid(fa, a.length)
    mid(fb, b.length)
    return [fa, fb]
  }

  // Longest common subsequence of the differing middle: two edits on one line
  // must mark two spans rather than one covering the unchanged text between.
  const dp = new Int32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[head + i] === b[head + j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) { i++; j++; continue }
    if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) fa[head + i++] = true
    else fb[head + j++] = true
  }
  for (; i < n; i++) fa[head + i] = true
  for (; j < m; j++) fb[head + j] = true

  bridgeGaps(a, fa)
  bridgeGaps(b, fb)
  // A rewritten line shares incidental words with its old self, and marking each
  // one shreds the tint into confetti. Past a few edits the middle marks whole.
  if (runCount(fa) > MAX_MARK_RUNS || runCount(fb) > MAX_MARK_RUNS) {
    fa.fill(false)
    fb.fill(false)
    mid(fa, a.length)
    mid(fb, b.length)
  }
  return [fa, fb]
}

const runCount = (flags) => flags.reduce((n, on, i) => n + (on && !flags[i - 1] ? 1 : 0), 0)

/* Two changed words with only a space between them read as one edit, so the gap
   joins them rather than splitting the mark in half. */
function bridgeGaps(tokens, flags) {
  for (let i = 1; i < flags.length - 1; i++) {
    if (!flags[i] && !tokens[i].trim() && flags[i - 1] && flags[i + 1]) flags[i] = true
  }
}

/* Whitespace tokens sit outside a mark: highlighting the space before a word
   makes the tint look misaligned by a character. */
function markRuns(tokens, flags) {
  if (!flags) return tokens.join('')
  let out = ''
  for (let i = 0; i < tokens.length;) {
    if (!flags[i]) { out += tokens[i++]; continue }
    let end = i
    while (end < tokens.length && flags[end]) end++
    let start = i
    let stop = end
    while (start < stop && !tokens[start].trim()) start++
    while (stop > start && !tokens[stop - 1].trim()) stop--
    out += tokens.slice(i, start).join('')
    if (start < stop) out += `<mark class="sd-diff-word">${tokens.slice(start, stop).join('')}</mark>`
    out += tokens.slice(stop, end).join('')
    i = end
  }
  return out
}

function lineHtml(kind, line, ordinal, wordHtml) {
  const mark = MARKED.has(kind) ? line.slice(0, 1) : ''
  const body = wordHtml ?? (MARKED.has(kind) ? line.slice(1) : line)
  // The glyph stays real text, not aria-hidden: it is what tells a screen reader
  // (and a colourblind reader) which side of the diff the line is on.
  const marker = MARKED.has(kind)
    ? `<span class="sd-diff-mark">${mark || ' '}</span>`
    : ''
  return `<div class="sd-diff-line sd-diff-${kind}" data-diff-line="${ordinal}">` +
    `${marker}<span class="sd-diff-text">${body}</span></div>`
}

/* N removals then N additions pair by position — the shape an edited list makes.
   One removal pairs with the first add; the rest of that run is wholly new. */
function pairedBlock(kinds, lines, i) {
  if (kinds[i] !== 'del' || kinds[i - 1] === 'del') return null
  let dels = 0
  while (kinds[i + dels] === 'del') dels++
  // A hand-authored diff often sets the runs apart with a blank line; it
  // separates them visually, not semantically, so pairing reads across it.
  let gap = 0
  while (kinds[i + dels + gap] === 'ctx' && !(lines[i + dels + gap] ?? 'x').trim()) gap++
  let adds = 0
  while (kinds[i + dels + gap + adds] === 'add') adds++
  if (!adds) return null
  if (dels === adds) return { dels, gap, pairs: dels }
  return dels === 1 ? { dels: 1, gap, pairs: 1 } : null
}

export function renderDiffBody(source) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n')
  // A fence's trailing newline would otherwise render as a blank final line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const kinds = lines.map(classify)
  const out = []

  for (let i = 0; i < lines.length; i++) {
    const block = pairedBlock(kinds, lines, i)
    if (block) {
      const { dels, gap, pairs } = block
      const addAt = i + dels + gap
      for (let k = 0; k < dels; k++) out[i + k] = lineHtml('del', lines[i + k], i + k)
      for (let k = 0; k < gap; k++) out[i + dels + k] = lineHtml('ctx', lines[i + dels + k], i + dels + k)
      for (let k = 0; k < pairs; k++) {
        const del = tokenize(lines[i + k].slice(1))
        const add = tokenize(lines[addAt + k].slice(1))
        const flags = changedFlags(del, add)
        out[i + k] = lineHtml('del', lines[i + k], i + k, markRuns(del, flags && flags[0]))
        out[addAt + k] = lineHtml('add', lines[addAt + k], addAt + k, markRuns(add, flags && flags[1]))
      }
      i += dels + gap + pairs - 1
      continue
    }
    out[i] = lineHtml(kinds[i], lines[i], i)
  }
  return out.join('')
}

/** Replaces every <pre class="sd-diff"> body with per-line markup. */
export function preRender(html) {
  try {
    return String(html).replace(PRE, (whole, attrs, body) =>
      hasClass(attrs, 'sd-diff') && !/<div/i.test(body)
        ? `<pre${attrs}>${renderDiffBody(body)}</pre>`
        : whole)
  } catch {
    return html
  }
}
