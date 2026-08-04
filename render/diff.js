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
  if (/^(---|\+\+\+)(\s|$)/.test(line)) return 'meta'
  if (/^@@/.test(line)) return 'hunk'
  if (/^\\ No newline/.test(line)) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

const MARKED = new Set(['add', 'del', 'ctx'])

/* Punctuation is its own token, so "words." still matches the "words" it grew from.
   Entities lead: splitting &lt; would put a mark inside markup. Whitespace kept as-is. */
const TOKEN = /&[a-zA-Z][a-zA-Z0-9]*;|&#\d+;|&#x[0-9a-fA-F]+;|\s+|[\w']+|[^\s\w]/g
const tokenize = (s) => s.match(TOKEN) ?? []

/* The differing middle of two token lists, as [start, endFromRight]. Null when they
   share no edge tokens — marking the whole line says nothing the tint has not. */
function changedSpan(a, b) {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head &&
         a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  if (head === 0 && tail === 0) return null
  return [head, tail]
}

/* Whitespace tokens sit outside the mark: highlighting the space before a word
   makes the tint look misaligned by a character. */
function markSpan(tokens, span) {
  if (!span) return tokens.join('')
  let start = span[0]
  let end = tokens.length - span[1]
  while (start < end && !tokens[start].trim()) start++
  while (end > start && !tokens[end - 1].trim()) end--
  if (start >= end) return tokens.join('')
  return tokens.slice(0, start).join('') +
    `<mark class="sd-diff-word">${tokens.slice(start, end).join('')}</mark>` +
    tokens.slice(end).join('')
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

/* A lone del pairs with the add right after it; further adds in the run are
   wholly new. A multi-del run (-a -b +c) has no unambiguous pairing. */
function pairedAt(kinds, i) {
  return kinds[i] === 'del' && kinds[i - 1] !== 'del' && kinds[i + 1] === 'add'
}

export function renderDiffBody(source) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n')
  // A fence's trailing newline would otherwise render as a blank final line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const kinds = lines.map(classify)
  const out = []

  for (let i = 0; i < lines.length; i++) {
    if (pairedAt(kinds, i)) {
      const del = tokenize(lines[i].slice(1))
      const add = tokenize(lines[i + 1].slice(1))
      const span = changedSpan(del, add)
      out.push(lineHtml('del', lines[i], i, markSpan(del, span)))
      out.push(lineHtml('add', lines[i + 1], i + 1, markSpan(add, span)))
      i++
      continue
    }
    out.push(lineHtml(kinds[i], lines[i], i))
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
