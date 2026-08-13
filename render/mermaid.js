/* Publish-time mermaid rendering: <pre class="mermaid">source</pre> becomes an
   inline SVG. Never throws. See docs/templates/mermaid.md. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { esc } from '../templates/_html.js'
import { ganttThemeVariables, isGantt } from './mermaid-theme.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MMDC = join(HERE, '..', 'node_modules', '.bin', 'mmdc')

const DEFAULT_TIMEOUT_MS = 20000
const BLOCK = /<pre\b[^>]*\bclass\s*=\s*(?:"[^"]*\bmermaid\b[^"]*"|'[^']*\bmermaid\b[^']*')[^>]*>([\s\S]*?)<\/pre>/gi

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Diagram source sits HTML-escaped inside the <pre>; mmdc needs the literal
    text, or a label written as &lt;br/&gt; renders as visible markup. */
export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => NAMED[n])
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try { return String.fromCodePoint(n) } catch { return '' }
}

export const sourceHash = (source) => createHash('sha1').update(String(source)).digest('hex').slice(0, 12)

/** The whiteboard seeds from these, so they must carry the same ordinals
    preRender stamps onto the rendered diagrams — same regex, same input. */
export function extractMermaidSources(html) {
  if (typeof html !== 'string') return []
  return [...html.matchAll(BLOCK)].map((match, index) => {
    const source = decodeEntities(match[1]).trim()
    return { index, source, hash: sourceHash(source) }
  })
}

function errorBlock(message, source, index) {
  return [
    `<div class="sd-diagram-error" data-diagram-index="${index}">`,
    '<div class="sd-diagram-error-title">Diagram did not render</div>',
    `<div>${esc(message)}</div>`,
    `<pre><code>${esc(source)}</code></pre>`,
    '</div>',
  ].join('')
}

/** Strip the XML prolog and any DOCTYPE so the SVG can be inlined in HTML. */
function inlineable(svg) {
  const at = svg.indexOf('<svg')
  return at === -1 ? null : svg.slice(at).trim()
}

/** mermaid emits every SVG with id="my-svg" and scopes its <style> to that id,
    so two inlined diagrams fight: the last block repaints the earlier ones.
    Marker/gradient ids share the prefix (my-svg-arrowhead), so rename by
    prefix — renaming only the exact id strands url(#…) refs on old names. */
export function scopeSvgId(svg, suffix) {
  const id = svg.match(/<svg[^>]*\sid="([^"]+)"/)?.[1]
  if (!id) return svg
  const scoped = `${id}-${suffix}`
  return svg
    .replaceAll(`id="${id}`, `id="${scoped}`)
    .replaceAll(`#${id}`, `#${scoped}`)
}

function runMmdc(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(MMDC, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      resolve({ err, stderr: String(stderr || '') })
    })
  })
}

async function renderOne(source, { timeoutMs, theme }) {
  let dir
  try {
    dir = await mkdtemp(join(tmpdir(), 'easel-mmd-'))
    const input = join(dir, 'd.mmd')
    const output = join(dir, 'd.svg')
    await writeFile(input, source, 'utf8')

    const args = ['-i', input, '-o', output, '-b', 'transparent']
    if (theme) args.push('-t', theme)
    // Gantt only, so no other diagram type leaves the stock palette.
    if (isGantt(source)) {
      const conf = join(dir, 'c.json')
      await writeFile(conf, JSON.stringify({ themeVariables: ganttThemeVariables(theme) }), 'utf8')
      args.push('-c', conf)
    }
    const { err, stderr } = await runMmdc(args, timeoutMs)

    if (err) {
      const reason = err.killed ? `timed out after ${timeoutMs}ms` : firstLine(stderr) || err.message
      return { ok: false, message: reason }
    }

    const svg = inlineable(await readFile(output, 'utf8'))
    if (!svg) return { ok: false, message: 'renderer produced no SVG' }
    return { ok: true, svg }
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'unknown render failure' }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function firstLine(text) {
  const line = String(text).split('\n').map((l) => l.trim()).filter(Boolean)[0]
  return line ? line.slice(0, 200) : ''
}

/** Convertible: both looks baked (mermaid default, sketch behind the toggle); unconvertible: plain mermaid; else error block. */
export async function preRender(html, options = {}) {
  if (typeof html !== 'string' || html === '') return html === '' ? '' : String(html ?? '')

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const theme = options.theme || null

  const blocks = [...html.matchAll(BLOCK)]
  if (blocks.length === 0) return html

  let converter = null
  // An explicit theme asks for that one mermaid theme; the sketch look has no
  // equivalent, so it keeps the plain single-variant path.
  if (options.excalidraw !== false && !theme) {
    try {
      const mod = await import('./excalidraw.js')
      converter = await mod.createConverter({ timeoutMs })
    } catch {
      converter = null // no bundle / no chromium — every block takes the plain path
    }
  }

  const rendered = []
  try {
    for (const match of blocks) {
      // Ordinal of the block, not of the successful renders: the whiteboard
      // keys scenes on it, so a failed diagram must not shift its neighbours.
      const slot = rendered.length
      const source = decodeEntities(match[1]).trim()
      // Wrapper carries the SOURCE hash: baked SVG is not byte-stable (sketch-path
      // jitter), so change detection reads this attribute, never the svg markup.
      const at = ` data-diagram-index="${slot}" data-diagram-hash="${sourceHash(source)}"`
      if (source === '') {
        rendered.push(errorBlock('empty diagram source', '', slot))
        continue
      }
      const excal = converter ? await converter.convert(source) : null
      if (excal?.ok) {
        // Mermaid pair is the default-visible look; sketch sits behind the toggle.
        const mLight = await renderOne(source, { timeoutMs, theme: 'default' })
        const mDark = mLight.ok ? await renderOne(source, { timeoutMs, theme: 'dark' }) : mLight
        rendered.push(mLight.ok && mDark.ok
          ? `<div class="sd-diagram sd-diagram-dual"${at}>` +
            `<span class="sd-svg-light">${scopeSvgId(mLight.svg, `${slot}l`)}</span>` +
            `<span class="sd-svg-dark">${scopeSvgId(mDark.svg, `${slot}d`)}</span>` +
            `<span class="sd-svg-sketch-light">${excal.light}</span>` +
            `<span class="sd-svg-sketch-dark">${excal.dark}</span></div>`
          : `<div class="sd-diagram sd-diagram-sketch"${at}><span class="sd-svg-light">${excal.light}</span>` +
            `<span class="sd-svg-dark">${excal.dark}</span></div>`)
        continue
      }
      if (theme) {
        const one = await renderOne(source, { timeoutMs, theme })
        rendered.push(one.ok
          ? `<div class="sd-diagram"${at}>${scopeSvgId(one.svg, slot)}</div>`
          : errorBlock(one.message, source, slot))
        continue
      }
      // Bare <text> labels (pie, gantt) bake their fill and no CSS reaches them,
      // so the fallback bakes a variant per theme like the sketch path does.
      const light = await renderOne(source, { timeoutMs, theme: 'default' })
      if (!light.ok) {
        rendered.push(errorBlock(light.message, source, slot))
        continue
      }
      const dark = await renderOne(source, { timeoutMs, theme: 'dark' })
      rendered.push(dark.ok
        ? `<div class="sd-diagram sd-diagram-themed"${at}>` +
          `<span class="sd-svg-light">${scopeSvgId(light.svg, `${slot}l`)}</span>` +
          `<span class="sd-svg-dark">${scopeSvgId(dark.svg, `${slot}d`)}</span></div>`
        : `<div class="sd-diagram"${at}>${scopeSvgId(light.svg, slot)}</div>`)
    }
  } finally {
    if (converter) await converter.close()
  }

  let out = ''
  let cursor = 0
  blocks.forEach((match, i) => {
    out += html.slice(cursor, match.index) + rendered[i]
    cursor = match.index + match[0].length
  })
  return out + html.slice(cursor)
}
