/* Shared helpers for the easel templates.
   Templates emit body-inner HTML only, never sf- classes, never data-sid. */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function esc(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c])
}

/** Attribute value: same escaping, but always returns a quoted-safe string. */
export function attr(value) {
  return esc(value)
}

export class TemplateError extends Error {}

export function fail(message) {
  throw new TemplateError(message)
}

export function requireObject(data, template) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(`${template}: data must be an object, got ${Array.isArray(data) ? 'array' : typeof data}`)
  }
}

export function requireArray(value, path) {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array, got ${value === null ? 'null' : typeof value}`)
  }
  return value
}

export function requireString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${path} must be a non-empty string`)
  }
  return value
}

/** Small block-level markdown for prose fields only: headings, fences, lists,
    quotes, paragraphs, and inline code/bold/italic/links. */
export function markdown(src) {
  if (src === null || src === undefined) return ''
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0

  const flushList = (items, ordered) => {
    const tag = ordered ? 'ol' : 'ul'
    out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`)
  }

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') { i++; continue }

    if (isTableRow(line) && i + 1 < lines.length && isAlignRow(lines[i + 1])) {
      const headCells = splitRow(line)
      const align = alignments(lines[i + 1])
      i += 2
      const body = []
      while (i < lines.length && isTableRow(lines[i]) && lines[i].trim() !== '') body.push(splitRow(lines[i++]))
      const width = headCells.length
      out.push(tableMarkup(
        headCells.map(inline),
        // Ragged rows are padded, never dropped — a short row must not swallow
        // the cells after it or silently lose data.
        body.map((r) => Array.from({ length: width }, (_, c) => inline(r[c] ?? ''))),
        align,
      ))
      continue
    }

    const fence = line.match(/^```\s*(\S*)(?:\s.*)?$/)
    if (fence) {
      // Only a plausible language name becomes a class; ``` {1,3} has none.
      const lang = /^[A-Za-z0-9_+-]+$/.test(fence[1]) ? fence[1] : ''
      const body = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      const code = body.join('\n')
      // A mermaid fence becomes the pre.mermaid element render/mermaid.js
      // replaces at publish time. Source stays escaped until then.
      // A diff fence becomes the pre.sd-diff element render/diff.js expands at
      // publish time, the same arrangement as mermaid above.
      // A chart fence becomes the pre.sd-chart element render/chart.js replaces
      // with an inline SVG at publish time, likewise.
      out.push(lang === 'mermaid' ? `<pre class="mermaid">${esc(code)}</pre>`
        : lang === 'diff' ? `<pre class="sd-diff">${esc(code)}</pre>`
        : lang === 'chart' ? `<pre class="sd-chart">${esc(code)}</pre>`
        : `<pre><code${lang ? ` class="language-${attr(lang)}"` : ''}>${esc(code)}</code></pre>`)
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length + 1
      out.push(`<h${Math.min(level, 5)}>${inline(heading[2])}</h${Math.min(level, 5)}>`)
      i++
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''))
      flushList(items, false)
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))
      flushList(items, true)
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`)
      continue
    }

    // Consumes at least one line unconditionally: if any guard above ever
    // excludes a line its branch does not claim, this must still advance.
    const para = []
    do {
      para.push(lines[i++])
    } while (i < lines.length && lines[i].trim() !== '' && !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|\s*>)/.test(lines[i]))
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }

  return out.join('\n')
}

/* GitHub-flavoured tables. Leading and trailing pipes are optional; a pipe
   escaped as \| is literal content, so splitting cannot happen on it. */

const isTableRow = (line) => /\|/.test(line) && !/^\s*\|?\s*$/.test(line)

const splitRow = (line) => line
  .replace(/^\s*\|/, '')
  // Only an UNESCAPED trailing pipe is the delimiter; `ends \|` is content.
  .replace(/(?<!\\)\|\s*$/, '')
  .split(/(?<!\\)\|/)
  .map((c) => c.trim().replace(/\\\|/g, '|'))

const isAlignRow = (line) => {
  if (!/\|/.test(line)) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

const alignments = (line) => splitRow(line).map((c) => {
  const left = c.startsWith(':')
  const right = c.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
})

function inline(text) {
  let s = esc(text)
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  // Only http(s) and mailto survive — no javascript: or data: URLs.
  // Obsidian-style size hint: ![alt|96](url) pins the rendered width in px.
  s = s.replace(/!\[([^\]|]*)(?:\|(\d{1,4}))?\]\((https?:[^)\s]+)\)/g, (_, alt, w, src) =>
    `<img class="sd-md-img" src="${src}" alt="${alt}"${w ? ` width="${w}"` : ''} loading="lazy">`)
  s = s.replace(/\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, '<a href="$2">$1</a>')
  return s
}

/** Guards widget-id uniqueness per render: two widgets sharing an id would
    record to the same key. */
export function makeIdGuard(template) {
  const seen = new Set()
  return (id, path) => {
    if (path) requireString(id, path)
    if (seen.has(id)) fail(`${template}: duplicate widget id "${id}" — ids must be unique per board`)
    seen.add(id)
    return id
  }
}

const BADGE_TONES = new Set(['success', 'warning', 'error', 'info', 'neutral'])

/** A design-system badge. "neutral" is the unstyled default, so it adds no tone class. */
export function badge(label, style, path, title) {
  let cls = ''
  if (style !== undefined && style !== null) {
    requireString(style, path ?? 'badge style')
    if (!BADGE_TONES.has(style)) fail(`${path ?? 'badge style'} must be one of ${[...BADGE_TONES].join(', ')}, got "${style}"`)
    if (style !== 'neutral') cls = ` sd-badge-${style}`
  }
  const titleAttr = title ? ` title="${attr(title)}"` : ''
  return `<span class="sd-badge${cls}"${titleAttr}>${esc(label)}</span>`
}

/** Widget markup only — client.js owns behavior. Options are native buttons so
    the annotation layer cannot swallow the click. */
export function widget({ type, id, prompt, help, options, compact }) {
  requireString(type, 'widget.type')
  requireString(id, 'widget.id')
  const allowed = ['vote', 'decision', 'approve', 'rating']
  if (!allowed.includes(type)) fail(`widget.type must be one of ${allowed.join(', ')}, got "${type}"`)
  const opts = requireArray(options, `widget[${id}].options`)
  if (opts.length === 0) fail(`widget[${id}].options must not be empty`)

  const buttons = opts.map((o) => {
    const value = typeof o === 'string' ? o : o.value
    const label = typeof o === 'string' ? o : (o.label ?? o.value)
    requireString(value, `widget[${id}] option value`)
    return `<button type="button" data-option="${attr(value)}">${esc(label)}</button>`
  }).join('')

  return [
    `<div data-widget="${attr(type)}" data-widget-id="${attr(id)}"${compact ? ' class="sd-widget-compact"' : ''}>`,
    prompt ? `<div class="sd-widget-prompt">${esc(prompt)}</div>` : '',
    help ? `<div class="sd-widget-help">${esc(help)}</div>` : '',
    `<div class="sd-widget-options">${buttons}</div>`,
    '</div>',
  ].filter(Boolean).join('')
}

const ALIGN_CLASS = { left: 'sd-align-left', center: 'sd-align-center', right: 'sd-align-right' }

/** Assemble the table markup from cells that are ALREADY HTML. Alignment rides
    a class, never a style attribute — the publish sanitizer drops style. */
function tableMarkup(headCells, bodyRows, align = []) {
  const cls = (i) => (ALIGN_CLASS[align[i]] ? ` class="${ALIGN_CLASS[align[i]]}"` : '')
  const head = headCells.map((c, i) => `<th${cls(i)}>${c}</th>`).join('')
  const body = bodyRows
    .map((r) => `<tr>${r.map((cell, i) => `<td${cls(i)}>${cell}</td>`).join('')}</tr>`)
    .join('')
  return `<div class="sd-tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

/** Wide tables always ship inside their own horizontal scroll container. */
export function table(columns, rows) {
  return tableMarkup(columns.map((c) => esc(c)), rows)
}
