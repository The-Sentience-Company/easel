/* Publish-time chart rendering: <pre class="sd-chart">JSON</pre> becomes a themed
   inline SVG — bar / grouped / hbar / line. Never throws. See docs/templates/chart.md. */

import { esc } from '../templates/_html.js'
import { decodeEntities, sourceHash } from './mermaid.js'

const PRE = /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

/* Walks the attributes in order rather than searching the whole string: a
   title or data- value mentioning class="sd-chart" must not claim the block. */
const hasClass = (attrs, want) => {
  ATTR.lastIndex = 0
  for (let m = ATTR.exec(attrs); m; m = ATTR.exec(attrs)) {
    if (m[1].toLowerCase() !== 'class') continue
    return (m[2] ?? m[3] ?? m[4] ?? '').split(/\s+/).includes(want)
  }
  return false
}

class ChartDataError extends Error {}
const fail = (message) => { throw new ChartDataError(message) }

/* Only the drawing box varies by size; text stays 11/12px throughout, so a
   small chart is genuinely smaller rather than a shrunken large one. */
/* sm is the only size two charts can sit side by side in: the content column
   is 1040px at its widest and narrower once the reader pulls it in. */
const SIZES = {
  sm: { W: 480, plotH: 220, rowH: 26, maxLabels: 9 },
  md: { W: 640, plotH: 300, rowH: 32, maxLabels: 12 },
  lg: { W: 800, plotH: 380, rowH: 38, maxLabels: 15 },
}

const TYPES = new Set(['bar', 'hbar', 'line'])
const MAX_SERIES = 5
const MAX_X = 120
const MAX_X_HBAR = 40

const TOP = 12
const RIGHT = 12
const CHAR_PX = 6.6 // 11px font, measured against the chrome's stack

const round2 = (v) => Math.round(v * 100) / 100
const textPx = (s) => Math.ceil(String(s).length * CHAR_PX)

export function validate(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail(`chart data must be a JSON object, got ${Array.isArray(data) ? 'array' : typeof data}`)
  }
  const type = data.type
  if (!TYPES.has(type)) fail(`type must be one of ${[...TYPES].join(', ')}, got ${JSON.stringify(data.type ?? null)}`)

  const size = data.size === undefined || data.size === null ? 'md' : data.size
  if (!SIZES[size]) fail(`size must be one of sm, md, lg, got ${JSON.stringify(data.size)}`)

  if (!Array.isArray(data.x)) fail('x must be an array of category labels')
  const cap = type === 'hbar' ? MAX_X_HBAR : MAX_X
  if (data.x.length === 0) fail('x must have at least one entry')
  if (data.x.length > cap) fail(`x has ${data.x.length} entries; ${type} charts cap at ${cap} — split the chart`)
  const x = data.x.map((label) => String(label))

  if (!Array.isArray(data.series)) fail('series must be an array')
  if (data.series.length === 0) fail('series must have at least one entry')
  if (data.series.length > MAX_SERIES) {
    fail(`series has ${data.series.length} entries; the cap is ${MAX_SERIES} — split the chart`)
  }

  const series = data.series.map((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) fail(`series[${i}] must be an object`)
    if (data.series.length > 1 && (typeof s.label !== 'string' || s.label.trim() === '')) {
      fail(`series[${i}].label is required when there is more than one series`)
    }
    if (!Array.isArray(s.values)) fail(`series[${i}].values must be an array`)
    if (s.values.length !== x.length) {
      fail(`series[${i}].values has ${s.values.length} entries but x has ${x.length}`)
    }
    const values = s.values.map((v, j) => {
      if (v === null) return null
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        fail(`series[${i}].values[${j}] must be a finite number or null, got ${JSON.stringify(v)}`)
      }
      return v
    })
    return { label: typeof s.label === 'string' ? s.label : '', values }
  })

  const str = (v, name) => {
    if (v === undefined || v === null) return ''
    if (typeof v !== 'string') fail(`${name} must be a string`)
    return v
  }

  return {
    type,
    size,
    x,
    series,
    title: str(data.title, 'title'),
    yLabel: str(data.yLabel, 'yLabel'),
    unit: str(data.unit, 'unit'),
  }
}

/* Round tick steps (1/2/5 × 10ⁿ), so gridlines land on numbers a reader can
   hold in their head rather than on the data's own extremes. */
function ticks(min, max) {
  const span = (max - min) || 1
  const step0 = Math.pow(10, Math.floor(Math.log10(span / 5)))
  const err = span / 5 / step0
  const step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1)
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const out = []
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10))
  return out
}

const trim1 = (x) => String(+x.toFixed(1))

export function fmtNum(v) {
  const a = Math.abs(v)
  if (a >= 1e9) return trim1(v / 1e9) + 'B'
  if (a >= 1e6) return trim1(v / 1e6) + 'M'
  if (a >= 1e4) return trim1(v / 1e3) + 'k'
  if (a >= 1) return String(+v.toFixed(a >= 100 ? 0 : 1)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return String(+v.toFixed(2))
}

const PREFIX_UNITS = new Set(['$', '€', '£', '¥'])

const withUnit = (v, unit) => {
  const n = fmtNum(v)
  if (!unit) return n
  return PREFIX_UNITS.has(unit) ? `${unit}${n}` : `${n} ${unit}`
}

/* Every coordinate is rounded as it is written: unrounded arithmetic leaks
   295.79999999999995 into the markup and makes the output diff-unstable. */
const q = (v) => Math.round(v * 100) / 100

/* Rounds the top edge only: a 4-corner radius anchored to a baseline reads as a
   bar floating off it. Call barPathDown for values hanging below zero. */
function barPath(x, w, yTop, h, r) {
  if (r <= 0 || h <= 0) return `M${q(x)},${q(yTop + h)}V${q(yTop)}H${q(x + w)}V${q(yTop + h)}Z`
  return `M${q(x)},${q(yTop + h)}V${q(yTop + r)}Q${q(x)},${q(yTop)} ${q(x + r)},${q(yTop)}` +
         `H${q(x + w - r)}Q${q(x + w)},${q(yTop)} ${q(x + w)},${q(yTop + r)}V${q(yTop + h)}Z`
}

function barPathDown(x, w, yTop, h, r) {
  if (r <= 0 || h <= 0) return `M${q(x)},${q(yTop)}V${q(yTop + h)}H${q(x + w)}V${q(yTop)}Z`
  return `M${q(x)},${q(yTop)}V${q(yTop + h - r)}Q${q(x)},${q(yTop + h)} ${q(x + r)},${q(yTop + h)}` +
         `H${q(x + w - r)}Q${q(x + w)},${q(yTop + h)} ${q(x + w)},${q(yTop + h - r)}V${q(yTop)}Z`
}

/* Horizontal bar from x (the baseline edge) extending w rightward, rounded right end. */
function hbarPath(x, w, y, h, r) {
  if (r <= 0 || w <= 0) return `M${q(x)},${q(y)}H${q(x + w)}V${q(y + h)}H${q(x)}Z`
  return `M${q(x)},${q(y)}H${q(x + w - r)}Q${q(x + w)},${q(y)} ${q(x + w)},${q(y + r)}` +
         `V${q(y + h - r)}Q${q(x + w)},${q(y + h)} ${q(x + w - r)},${q(y + h)}H${q(x)}Z`
}

function hbarPathLeft(x, w, y, h, r) {
  if (r <= 0 || w <= 0) return `M${q(x)},${q(y)}H${q(x - w)}V${q(y + h)}H${q(x)}Z`
  return `M${q(x)},${q(y)}H${q(x - w + r)}Q${q(x - w)},${q(y)} ${q(x - w)},${q(y + r)}` +
         `V${q(y + h - r)}Q${q(x - w)},${q(y + h)} ${q(x - w + r)},${q(y + h)}H${q(x)}Z`
}

function domain(series) {
  let lo = Infinity
  let hi = -Infinity
  for (const s of series) {
    for (const v of s.values) {
      if (v === null) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  if (lo === Infinity) return [0, 1]
  const min = Math.min(0, lo)
  const max = Math.max(0, hi)
  return min === 0 && max === 0 ? [0, 1] : [min, max]
}

const tip = (spec, si, xi, value) => {
  const label = spec.series.length > 1 ? `${spec.series[si].label} · ` : ''
  return `${label}${spec.x[xi]}: ${withUnit(value, spec.unit)}`
}

const titleEl = (text) => `<title>${esc(text)}</title>`

function legend(spec) {
  if (spec.series.length < 2) return ''
  const keys = spec.series.map((s, i) =>
    `<span class="sd-chart-key"><span class="sd-chart-swatch sd-chart-s${i}"></span>${esc(s.label)}</span>`).join('')
  return `<div class="sd-chart-legend">${keys}</div>`
}

/* Every Nth label, so a dense axis thins out instead of overprinting itself. */
const labelStride = (n, maxLabels) => Math.ceil(n / maxLabels)

function verticalSvg(spec) {
  const { W, plotH, maxLabels } = SIZES[spec.size]
  const [min, max] = domain(spec.series)
  const tv = ticks(min, max)
  const lo = tv[0]
  const hi = tv[tv.length - 1]
  const tickText = tv.map((v) => withUnit(v, spec.unit))
  const left = 8 + Math.max(...tickText.map(textPx)) + (spec.yLabel ? 18 : 0)
  const plotW = W - left - RIGHT
  const n = spec.x.length
  const slot = plotW / n

  const stride = labelStride(n, maxLabels)
  const shown = spec.x.map((label, i) => ({ label, i })).filter(({ i }) => i % stride === 0)
  const longestLabelPx = shown.length ? Math.max(...shown.map(({ label }) => textPx(label))) : 0
  const rotate = longestLabelPx > slot
  const bottom = rotate
    ? Math.min(90, 26 + Math.round(Math.sin(35 * Math.PI / 180) * longestLabelPx))
    : 26
  const H = TOP + plotH + bottom

  const yOf = (v) => round2(TOP + plotH * (hi - v) / ((hi - lo) || 1))
  const baseline = yOf(0)
  const parts = []

  for (let i = 0; i < tv.length; i++) {
    const y = yOf(tv[i])
    parts.push(`<line class="sd-chart-grid" x1="${left}" y1="${y}" x2="${round2(left + plotW)}" y2="${y}"></line>`)
    parts.push(`<text class="sd-chart-tick" x="${left - 6}" y="${y}" dy=".35em" text-anchor="end">${esc(tickText[i])}</text>`)
  }
  parts.push(`<line class="sd-chart-axis" x1="${left}" y1="${baseline}" x2="${round2(left + plotW)}" y2="${baseline}"></line>`)

  if (spec.yLabel) {
    const cy = round2(TOP + plotH / 2)
    parts.push(`<text class="sd-chart-tick" x="12" y="${cy}" text-anchor="middle" transform="rotate(-90 12 ${cy})">${esc(spec.yLabel)}</text>`)
  }

  const labelY = TOP + plotH + 16
  for (const { label, i } of shown) {
    const cx = round2(left + i * slot + slot / 2)
    parts.push(rotate
      ? `<text class="sd-chart-label" x="${cx}" y="${labelY}" text-anchor="end" transform="rotate(-35 ${cx} ${labelY})">${esc(label)}</text>`
      : `<text class="sd-chart-label" x="${cx}" y="${labelY}" text-anchor="middle">${esc(label)}</text>`)
  }

  const s = spec.series.length
  if (spec.type === 'bar') {
    const groupW = slot * 0.72
    const barW = groupW / s
    for (let si = 0; si < s; si++) {
      for (let xi = 0; xi < spec.x.length; xi++) {
        const v = spec.series[si].values[xi]
        if (v === null) continue
        const x = round2(left + xi * slot + (slot - groupW) / 2 + si * barW)
        const w = round2(Math.max(1, barW - 2))
        const y = yOf(v)
        const h = round2(Math.abs(baseline - y))
        const r = Math.min(3, w / 2, h)
        const d = v >= 0 ? barPath(x, w, y, h, r) : barPathDown(x, w, baseline, h, r)
        parts.push(`<path class="sd-chart-bar sd-chart-s${si}" d="${d}">${titleEl(tip(spec, si, xi, v))}</path>`)
      }
    }
  } else {
    for (let si = 0; si < s; si++) {
      const pts = spec.series[si].values.map((v, xi) => (v === null ? null
        : { x: round2(left + xi * slot + slot / 2), y: yOf(v), v, xi }))
      let d = ''
      let pen = false
      for (const p of pts) {
        if (!p) { pen = false; continue }
        d += `${pen ? 'L' : 'M'}${p.x},${p.y}`
        pen = true
      }
      const dots = slot >= 10
      const pathTitle = !dots && spec.series.length > 1 ? titleEl(spec.series[si].label) : ''
      parts.push(`<path class="sd-chart-line sd-chart-s${si}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" d="${d}">${pathTitle}</path>`)
      if (dots) {
        for (const p of pts) {
          if (!p) continue
          parts.push(`<circle class="sd-chart-dot sd-chart-s${si}" cx="${p.x}" cy="${p.y}" r="3">${titleEl(tip(spec, si, p.xi, p.v))}</circle>`)
        }
      }
    }
  }
  return { W, H, body: parts.join('') }
}

function horizontalSvg(spec) {
  const { W, rowH } = SIZES[spec.size]
  const n = spec.x.length
  const [min, max] = domain(spec.series)
  const tv = ticks(min, max)
  const lo = tv[0]
  const hi = tv[tv.length - 1]

  const maxCatPx = 0.35 * W
  const cats = spec.x.map((label) => {
    if (textPx(label) <= maxCatPx) return { text: label, full: '' }
    const keep = Math.max(1, Math.floor(maxCatPx / CHAR_PX) - 1)
    return { text: `${label.slice(0, keep)}…`, full: label }
  })
  const left = Math.round(8 + Math.min(Math.max(...cats.map((c) => textPx(c.text))), maxCatPx))
  const plotW = W - left - RIGHT
  const plotBottom = TOP + n * rowH
  const H = plotBottom + 30

  const xOf = (v) => round2(left + plotW * (v - lo) / ((hi - lo) || 1))
  const baseline = xOf(0)
  const parts = []

  for (const t of tv) {
    const x = xOf(t)
    parts.push(`<line class="sd-chart-grid" x1="${x}" y1="${TOP}" x2="${x}" y2="${plotBottom}"></line>`)
    parts.push(`<text class="sd-chart-tick" x="${x}" y="${plotBottom + 16}" text-anchor="middle">${esc(withUnit(t, spec.unit))}</text>`)
  }
  parts.push(`<line class="sd-chart-axis" x1="${baseline}" y1="${TOP}" x2="${baseline}" y2="${plotBottom}"></line>`)

  for (let i = 0; i < n; i++) {
    const cy = round2(TOP + i * rowH + rowH / 2)
    const full = cats[i].full ? titleEl(cats[i].full) : ''
    parts.push(`<text class="sd-chart-label" x="${left - 6}" y="${cy}" dy=".35em" text-anchor="end">${esc(cats[i].text)}${full}</text>`)
  }

  const s = spec.series.length
  const band = rowH * 0.72
  const barH = band / s
  for (let si = 0; si < s; si++) {
    for (let xi = 0; xi < n; xi++) {
      const v = spec.series[si].values[xi]
      if (v === null) continue
      const y = round2(TOP + xi * rowH + (rowH - band) / 2 + si * barH)
      const h = round2(Math.max(1, barH - 2))
      const w = round2(Math.abs(xOf(v) - baseline))
      const r = Math.min(3, h / 2, w)
      const d = v >= 0 ? hbarPath(baseline, w, y, h, r) : hbarPathLeft(baseline, w, y, h, r)
      parts.push(`<path class="sd-chart-bar sd-chart-s${si}" d="${d}">${titleEl(tip(spec, si, xi, v))}</path>`)
    }
  }
  return { W, H, body: parts.join('') }
}

export function renderChart(spec, index, source = '') {
  const { W, H, body } = spec.type === 'hbar' ? horizontalSvg(spec) : verticalSvg(spec)
  const label = spec.title || `${spec.type === 'line' ? 'line' : 'bar'} chart`
  return [
    `<figure class="sd-chart" data-chart-index="${index}" data-chart-hash="${sourceHash(source)}">`,
    spec.title ? `<figcaption>${esc(spec.title)}</figcaption>` : '',
    `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="${esc(label)}">${body}</svg>`,
    legend(spec),
    '</figure>',
  ].filter(Boolean).join('')
}

function errorBlock(message, source, index) {
  return [
    `<div class="sd-diagram-error" data-chart-index="${index}">`,
    '<div class="sd-diagram-error-title">Chart did not render</div>',
    `<div>${esc(message)}</div>`,
    `<pre><code>${esc(source)}</code></pre>`,
    '</div>',
  ].join('')
}

/** Replaces every <pre class="sd-chart"> with its rendered figure. */
export function preRender(html) {
  try {
    let index = 0
    return String(html).replace(PRE, (whole, attrs, body) => {
      if (!hasClass(attrs, 'sd-chart')) return whole
      const slot = index++
      const source = decodeEntities(body).trim()
      try {
        return renderChart(validate(JSON.parse(source)), slot, source)
      } catch (err) {
        return errorBlock(err.message, source, slot)
      }
    })
  } catch {
    return html
  }
}
