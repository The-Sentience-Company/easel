// Stable node ids (data-sid) + DOM tree diff between rounds. parse5-based.
// Classification: added / removed / modified / moved, leaf-most for modified.

import { parseFragment, serialize } from 'parse5'
import { createHash } from 'node:crypto'

const BLOCK_TAGS = new Set([
  'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure',
  'figcaption', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody',
  // Cells anchor individually: a thead th stands for its column (chrome-side),
  // a body cell for itself; rows keep sids for legacy rounds and edge clicks.
  'tr', 'th', 'td', 'details', 'summary', 'form', 'fieldset',
])

const isElement = (n) => Boolean(n.tagName)

function textOf(node) {
  if (node.nodeName === '#text') return node.value
  // Style/script text is markup plumbing (an SVG's <style> most of all), not
  // content — it must reach neither matching nor excerpts.
  if (node.tagName === 'style' || node.tagName === 'script') return ''
  if (!node.childNodes) return ''
  return node.childNodes.map(textOf).join('')
}

const norm = (s) => s.replace(/\s+/g, ' ').trim()

// Below this similarity score, a leftover same-tag pair is a remove+add, not an edit.
const PAIR_MIN_SIMILARITY = 0.3

function bigrams(s) {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function dice(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const x of a) if (b.has(x)) shared++
  return (2 * shared) / (a.size + b.size)
}

// Word-overlap Dice; short texts also try char bigrams, so a typo or
// punctuation fix in a heading still reads as the same node.
function similarity(a, b) {
  if (a === b) return 1
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  const ta = new Set(la.split(' ').filter(Boolean))
  const tb = new Set(lb.split(' ').filter(Boolean))
  const words = dice(ta, tb)
  if (Math.min(ta.size, tb.size) > 3) return words
  return Math.max(words, dice(bigrams(la), bigrams(lb)))
}

function getAttr(node, name) {
  return node.attrs?.find((a) => a.name === name)?.value ?? null
}

function setAttr(node, name, value) {
  const existing = node.attrs.find((a) => a.name === name)
  if (existing) existing.value = value
  else node.attrs.push({ name, value })
}

// Renders as something even with no text, so it stays annotatable.
const VISIBLE_EMPTY = new Set(['img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'hr', 'input'])

// Empty but still painted by the design system — measured in a real page, not
// assumed: each carries a border, background, or shadow of its own.
const PAINTED_EMPTY_TAGS = new Set(['blockquote', 'pre', 'td', 'th'])
const PAINTED_EMPTY_CLASSES = new Set([
  'sd-card', 'sd-tablewrap', 'sd-metric', 'sd-badge', 'sd-badge-key',
  'sd-tag', 'sd-flag', 'sd-entry', 'sd-focus', 'sd-island',
])

function paintsWhenEmpty(node) {
  if (PAINTED_EMPTY_TAGS.has(node.tagName)) return true
  const cls = getAttr(node, 'class')
  return cls ? cls.split(/\s+/).some((c) => PAINTED_EMPTY_CLASSES.has(c)) : false
}

function hasVisibleContent(node) {
  if (node.nodeName === '#text') return norm(node.value) !== ''
  if (isElement(node) && (VISIBLE_EMPTY.has(node.tagName) || paintsWhenEmpty(node))) return true
  return (node.childNodes ?? []).some(hasVisibleContent)
}

// Atomic: label divs inside the SVG must not become blocks, or a replaced
// diagram ghosts as every label — once per baked theme variant.
const isDiagram = (node) =>
  (getAttr(node, 'class') ?? '').split(/\s+/).includes('sd-diagram')

// Collects block-level nodes in document order with path + text signatures.
// A node with nothing to see gets no sid: it would paint at zero height while
// still accepting annotations, giving a queue row with no marker to pair to.
function collectBlocks(root) {
  const blocks = []
  ;(function walk(node, path) {
    if (!node.childNodes) return
    node.childNodes.forEach((child, i) => {
      if (!isElement(child)) return
      const childPath = [...path, i]
      const diagram = isDiagram(child)
      if (BLOCK_TAGS.has(child.tagName) && hasVisibleContent(child)) {
        blocks.push({
          node: child,
          path: childPath,
          tag: child.tagName,
          fullText: norm(textOf(child)),
          sid: getAttr(child, 'data-sid'),
          diagram,
        })
      }
      if (!diagram) walk(child, childPath)
    })
  })(root, [])
  return blocks
}

function freshSid(block, taken) {
  const base = `${block.tag}|${block.fullText}|${block.path.join('.')}`
  for (let n = 0; ; n++) {
    const sid = 's-' + createHash('sha1').update(`${base}|${n}`).digest('hex').slice(0, 8)
    if (!taken.has(sid)) {
      taken.add(sid)
      return sid
    }
  }
}

// Serialized shape of a node minus data-sid, for attribute-change detection.
function shapeOf(block) {
  const clone = serialize({ nodeName: '#document-fragment', childNodes: [block.node] })
  return clone.replace(/\s*data-sid="[^"]*"/g, '')
}

function longestIncreasingSubsequence(indices) {
  const tails = []
  const tailIdx = []
  const prev = new Array(indices.length).fill(-1)
  for (let i = 0; i < indices.length; i++) {
    let lo = 0, hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < indices[i]) lo = mid + 1
      else hi = mid
    }
    tails[lo] = indices[i]
    tailIdx[lo] = i
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1
  }
  const inLis = new Set()
  let k = tailIdx[tails.length - 1]
  while (k !== -1 && k !== undefined) {
    inLis.add(k)
    k = prev[k]
  }
  return inLis
}

// Allowlist sanitizer for round html on the daemon origin — see docs/api.md "Threat model".
const HTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** Pulls each data-island element's inner html out verbatim for sandboxed-frame
    rendering, leaving an empty placeholder block. Outermost island wins. */
export function extractIslands(html) {
  const tree = parseFragment(html)
  const islands = []
  const walk = (node) => {
    const children = node.childNodes ?? []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (!isElement(child)) continue
      if (getAttr(child, 'data-island') != null) {
        const index = islands.length
        islands.push({
          index,
          html: serialize(child),
          title: getAttr(child, 'data-island-title') || null,
          height: Number(getAttr(child, 'data-island-height')) || null,
        })
        const attrs = [
          { name: 'class', value: 'sd-island' },
          { name: 'data-island-index', value: String(index) },
        ]
        const title = getAttr(child, 'data-island-title')
        if (title) attrs.push({ name: 'data-island-title', value: title })
        const height = getAttr(child, 'data-island-height')
        if (height) attrs.push({ name: 'data-island-height', value: height })
        children[i] = {
          nodeName: 'div', tagName: 'div', attrs,
          namespaceURI: HTML_NS, childNodes: [], parentNode: node,
        }
      } else {
        walk(child)
      }
    }
  }
  walk(tree)
  return { html: islands.length ? serialize(tree) : html, islands }
}

// Ordinary document markup + the sd- design system (class-based) + widget button.
const HTML_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br',
  'button', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'ins', 'kbd', 'label', 'li', 'main', 'mark',
  'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time',
  'tr', 'u', 'ul', 'var', 'wbr',
])

// Our own mmdc render (docs/api.md). foreignObject HTML labels fall back to HTML_NS.
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'textpath', 'defs', 'marker', 'symbol', 'use', 'image', 'a', 'filter',
  'fedropshadow', 'fegaussianblur', 'feoffset', 'feflood', 'fecomposite', 'femerge',
  'femergenode', 'fecolormatrix', 'feblend', 'clippath', 'mask', 'pattern',
  'lineargradient', 'radialgradient', 'stop', 'foreignobject', 'title', 'desc', 'style',
])

const HTML_ATTRS = new Set([
  'class', 'id', 'title', 'role', 'lang', 'dir', 'translate', 'href', 'src', 'alt', 'width',
  'height', 'type', 'datetime', 'colspan', 'rowspan', 'headers', 'scope', 'start', 'reversed',
  'value', 'cite', 'open', 'for', 'loading', 'download',
])

const URL_ATTRS = new Set(['href', 'src', 'xlink:href'])

// SVG attributes whose value is CSS or a funciri, so a fetch can hide in them.
const CSS_ATTRS = new Set([
  'style', 'fill', 'stroke', 'clip-path', 'mask', 'filter', 'cursor', 'color-profile',
  'marker', 'marker-start', 'marker-mid', 'marker-end',
])

function isSvg(el) {
  return el.namespaceURI === SVG_NS
}

// Browsers ignore embedded control chars when resolving a scheme; strip them
// first so "java\tscript:" can't slip past as a scheme-less relative URL.
function safeUrl(value) {
  const s = String(value).replace(/[\u0000-\u0020]+/g, '')
  if (/^\/\//.test(s)) return false // protocol-relative //host resolves to an external origin
  if (/^(#|\/|\.)/.test(s)) return true // fragment or relative path
  const m = s.match(/^([a-z][a-z0-9+.-]*):/i)
  if (!m) return true // no scheme → relative
  return ['http', 'https', 'mailto'].includes(m[1].toLowerCase())
}

// The only two url() shapes real diagram output emits: mermaid's same-document
// #fragments and the woff2 subset the sketch diagrams embed.
const SAFE_CSS_URL = /^data:font\/woff2;base64,[a-z0-9+/=]*$/i

function readCssString(src, i) {
  const quote = src[i]
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') j++
    else if (src[j] === quote) return { text: src.slice(i, j + 1), value: src.slice(i + 1, j), end: j + 1 }
    else if (src[j] === '\n') break
  }
  return null
}

/** Reads name(...) with quotes and nesting honoured. null when it does not
    close — the shape that used to slip through unscrubbed. */
function readCssFunction(src, i) {
  const head = /^([-\w]+)\(/.exec(src.slice(i))
  if (!head) return null
  let depth = 1
  let args = ''
  let hasString = false
  for (let j = i + head[0].length; j < src.length; ) {
    const ch = src[j]
    if (ch === '"' || ch === "'") {
      const str = readCssString(src, j)
      if (!str) return null
      hasString = true
      args += str.text
      j = str.end
      continue
    }
    if (ch === '(') depth++
    if (ch === ')' && --depth === 0) {
      return { name: head[1].toLowerCase(), args, hasString, end: j + 1, text: src.slice(i, j + 1) }
    }
    args += ch
    j++
  }
  return null
}

/** Neutralises every CSS construct that can issue a fetch. Returns null when the
    value cannot be parsed, so callers drop it rather than pass it through. */
function scrubCss(css) {
  const src = String(css)
  // A CSS escape is invisible to this scanner but not to the browser's
  // tokenizer: `\75 rl(...)` reads as url(). Nothing we render escapes.
  if (src.includes('\\')) return null
  let out = ''
  for (let i = 0; i < src.length; ) {
    // Removed spans leave a space behind. Deleting them outright would weld the
    // neighbours together, and `u/**/rl(...)` would come out as a live url().
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) return null
      out += ' '
      i = end + 2
      continue
    }
    // An at-rule that pulls a stylesheet: drop through the terminator.
    if (src[i] === '@' && /^@import\b/i.test(src.slice(i))) {
      const semi = src.indexOf(';', i)
      if (semi === -1) return out + ' '
      out += ' '
      i = semi + 1
      continue
    }
    if (/[-\w]/.test(src[i]) && /^[-\w]+\(/.test(src.slice(i))) {
      const fn = readCssFunction(src, i)
      if (!fn) return null
      if (fn.name === 'url') {
        const raw = fn.args.trim()
        const target = (raw[0] === '"' || raw[0] === "'" ? readCssString(raw, 0)?.value : raw) ?? ''
        const t = target.trim()
        out += t.startsWith('#') || SAFE_CSS_URL.test(t) ? fn.text : 'none'
      } else if (fn.hasString || /\burl\(/i.test(fn.args) || /\/\//.test(fn.args)) {
        // Any other function naming a resource — image-set(), cross-fade(), and
        // whatever CSS adds next. Geometry and calc() never carry a string or //.
        out += 'none'
      } else {
        out += fn.text
      }
      i = fn.end
      continue
    }
    out += src[i]
    i++
  }
  return out
}

function sanitizeAttrs(el, inSvg = false) {
  if (!el.attrs) return
  const svg = isSvg(el)
  el.attrs = el.attrs.filter((a) => {
    const name = a.name.toLowerCase()
    if (name.startsWith('on')) return false
    if (name === 'data-sid') return false // this module owns sid assignment; inbound ones shadow real blocks
    if (URL_ATTRS.has(name) && !safeUrl(a.value)) return false
    // Every funciri-bearing attribute, but not `d`/`aria-*` which cannot fetch.
    // The content test nets any funciri attribute not named in the set.
    if (svg) {
      if (!CSS_ATTRS.has(name) && !/url\(|\\/i.test(a.value)) return true
      const scrubbed = scrubCss(a.value)
      if (scrubbed === null) return false
      a.value = scrubbed
      return true
    }
    if (name === 'style') {
      // A mermaid label lives in HTML inside <foreignObject>, and mmdc sized its
      // node box around the metrics these carry. Scrubbed like any SVG css.
      if (!inSvg) return false // css url() exfil from HTML-context markup
      const scrubbed = scrubCss(a.value)
      if (scrubbed === null) return false
      a.value = scrubbed
      return true
    }
    if (name.startsWith('data-') || name.startsWith('aria-')) return true
    return HTML_ATTRS.has(name)
  })
}

function dropWhole(el) {
  const tag = el.tagName?.toLowerCase()
  return tag === 'script' || tag === 'template' || (tag === 'style' && !isSvg(el))
}

function allowedElement(el) {
  const tag = el.tagName.toLowerCase()
  return isSvg(el) ? SVG_ELEMENTS.has(tag) : HTML_ELEMENTS.has(tag)
}

function sanitize(node, inSvg = false) {
  const out = []
  for (const child of node.childNodes || []) {
    if (!child.tagName) {
      out.push(child)
      continue
    }
    if (dropWhole(child)) continue
    sanitize(child, inSvg || isSvg(child)) // descendants first, keep or promote after
    if (allowedElement(child)) {
      sanitizeAttrs(child, inSvg)
      if (isSvg(child) && child.tagName.toLowerCase() === 'style') {
        for (const t of child.childNodes || []) {
          if (t.nodeName === '#text') t.value = scrubCss(t.value) ?? ''
        }
      }
      out.push(child)
    } else {
      for (const grand of child.childNodes || []) {
        grand.parentNode = node
        out.push(grand)
      }
    }
  }
  node.childNodes = out
}

// Assigns data-sid to blocks in `html`; diffs against prevHtml when given.
// Returns { html, diff } — diff null for round 1.
export function annotateAndDiff(html, prevHtml = null) {
  const tree = parseFragment(html)
  sanitize(tree)
  const blocks = collectBlocks(tree)
  const taken = new Set()

  if (!prevHtml) {
    for (const b of blocks) setAttr(b.node, 'data-sid', freshSid(b, taken))
    return { html: serialize(tree), diff: null }
  }

  const oldTree = parseFragment(prevHtml)
  const oldBlocks = collectBlocks(oldTree)
  for (const ob of oldBlocks) if (ob.sid) taken.add(ob.sid)

  // Pass 1: exact matches on tag + normalized subtree text.
  const byKey = new Map()
  for (const ob of oldBlocks) {
    const key = `${ob.tag}\0${ob.fullText}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(ob)
  }
  const exactPairs = []
  const unmatchedNew = []
  for (const nb of blocks) {
    const queue = byKey.get(`${nb.tag}\0${nb.fullText}`)
    if (queue?.length) {
      const ob = queue.shift()
      ob.matched = true
      exactPairs.push({ old: ob, new: nb })
    } else {
      unmatchedNew.push(nb)
    }
  }
  const unmatchedOld = oldBlocks.filter((ob) => !ob.matched)

  // Pass 2: same-tag pairing of leftovers → modified (sid carried). Only similar
  // texts pair, else a remove+add would migrate the removed sid (and its annotations).
  // Strongest matches assign first, so pairing is order-independent.
  const candidates = []
  for (let oi = 0; oi < unmatchedOld.length; oi++) {
    for (let ni = 0; ni < unmatchedNew.length; ni++) {
      if (unmatchedOld[oi].tag !== unmatchedNew[ni].tag) continue
      const score = similarity(unmatchedOld[oi].fullText, unmatchedNew[ni].fullText)
      if (score >= PAIR_MIN_SIMILARITY) candidates.push({ score, oi, ni })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.oi - b.oi || a.ni - b.ni)
  const pairedNew = new Map()
  for (const c of candidates) {
    if (unmatchedOld[c.oi].matched || pairedNew.has(c.ni)) continue
    unmatchedOld[c.oi].matched = true
    pairedNew.set(c.ni, unmatchedOld[c.oi])
  }
  const modifiedPairs = []
  const added = []
  for (let ni = 0; ni < unmatchedNew.length; ni++) {
    if (pairedNew.has(ni)) modifiedPairs.push({ old: pairedNew.get(ni), new: unmatchedNew[ni] })
    else added.push(unmatchedNew[ni])
  }
  const removed = oldBlocks.filter((ob) => !ob.matched)

  // Carry sids forward; fresh sids for added.
  for (const { old, new: nb } of [...exactPairs, ...modifiedPairs]) {
    nb.assignedSid = old.sid || freshSid(nb, taken)
  }
  for (const nb of added) nb.assignedSid = freshSid(nb, taken)
  for (const b of blocks) setAttr(b.node, 'data-sid', b.assignedSid)

  // Moved: exact pairs whose relative order changed (not in the LIS).
  const orderedExact = exactPairs.map((p, i) => ({ ...p, newIdx: i, oldIdx: oldBlocks.indexOf(p.old) }))
  const inLis = longestIncreasingSubsequence(orderedExact.map((p) => p.oldIdx))
  const moved = orderedExact.filter((_, i) => !inLis.has(i)).map((p) => p.new)

  // Exact-text pairs with attribute/markup changes count as modified.
  const attrModified = exactPairs
    .filter((p) => shapeOf(p.old) !== shapeOf(p.new))
    .map((p) => p.new)

  const isAncestor = (a, b) =>
    a.path.length < b.path.length && a.path.every((v, i) => v === b.path[i])
  const leafMost = (list, context) =>
    list.filter((b) => !context.some((other) => other !== b && isAncestor(b, other)))
  // A wholly-new subtree is entirely `added`, so report its outermost block, not
  // its leaves — collapsing against the modified set would drop the new container.
  const topMost = (list) =>
    list.filter((b) => !list.some((other) => other !== b && isAncestor(other, b)))

  const changedContext = [...modifiedPairs.map((p) => p.new), ...added, ...attrModified]
  const removedWithSid = removed.filter((b) => b.sid)
  // Anchor each removal to the nearest surviving SIBLING (afterSid) or container
  // (withinSid) — a block nested in an earlier sibling would drag the ghost too deep.
  const sameParent = (a, b) =>
    a.path.length === b.path.length && a.path.slice(0, -1).every((v, i) => v === b.path[i])
  const removedDetail = removedWithSid.map((b) => {
    const i = oldBlocks.indexOf(b)
    let afterSid = null
    let withinSid = null
    for (let j = i - 1; j >= 0; j--) {
      const o = oldBlocks[j]
      if (!o.matched || !o.sid) continue
      if (isAncestor(o, b)) { withinSid = o.sid; break }
      if (sameParent(o, b)) { afterSid = o.sid; break }
    }
    return { sid: b.sid, excerpt: b.diagram ? '(diagram)' : b.fullText.slice(0, 200), afterSid, withinSid }
  })
  const diff = {
    added: topMost(added).map((b) => b.assignedSid),
    removed: removedWithSid.map((b) => b.sid),
    removedDetail,
    modified: leafMost([...modifiedPairs.map((p) => p.new), ...attrModified], changedContext)
      .filter((b) => !added.includes(b))
      .map((b) => b.assignedSid),
    moved: moved.map((b) => b.assignedSid),
  }
  return { html: serialize(tree), diff }
}

// Text of the node carrying `sid` in stored round html, clipped for excerpts.
export function excerptForSid(html, sid, max = 200) {
  const tree = parseFragment(html)
  let found = null
  ;(function walk(node) {
    if (found || !node.childNodes) return
    for (const child of node.childNodes) {
      if (isElement(child) && getAttr(child, 'data-sid') === sid) {
        found = child
        return
      }
      walk(child)
    }
  })(tree)
  if (!found) return null
  return norm(textOf(found)).slice(0, max)
}
