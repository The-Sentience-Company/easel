/* Publish-time mermaid → hand-drawn excalidraw-look SVG, light + dark variants.
   convert() never throws; callers fall back to the plain mermaid path. */

import { createHash } from 'node:crypto'
import { access, readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '.gen', 'excalidraw-bundle.js')

// Excalidraw resolves its font files against a CDN fallback baked into the
// package, so the converter page serves them from disk and refuses the network.
function assetRoots() {
  const roots = []
  try {
    roots.push(dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw')))
  } catch {}
  roots.push(join(HERE, '.gen', 'whiteboard'))
  return roots
}

const CONTENT_TYPES = { woff2: 'font/woff2', js: 'text/javascript', css: 'text/css', json: 'application/json' }

// The drawing font. The converter never mounts the editor, so nothing else ever
// registers it and label widths would be measured against a system fallback.
const DRAWING_FONT = 'Excalifont'

/** Every subset, because the Latin metrics live in exactly one of them and which
    one is a build detail of the package. */
async function drawingFontFaces() {
  for (const root of assetRoots()) {
    const dir = join(root, 'fonts', DRAWING_FONT)
    let names
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.woff2'))
    } catch {
      continue
    }
    if (names.length === 0) continue
    const faces = []
    for (const name of names) {
      faces.push(`data:font/woff2;base64,${(await readFile(join(dir, name))).toString('base64')}`)
    }
    return faces
  }
  return []
}

async function readAsset(rel) {
  for (const root of assetRoots()) {
    try {
      return await readFile(join(root, rel))
    } catch (err) {
      // Absent here just means try the next root; unreadable means something an
      // operator needs to see rather than a silent fall to "no fonts".
      if (err.code !== 'ENOENT') throw err
    }
  }
  return null
}

/** An SVG naming a font it did not embed renders in whatever the reader
    substitutes, so treat a missing face as a failed conversion. */
export function fontsEmbedded(svg) {
  if (!/Excalifont/i.test(String(svg))) return true
  return /url\(\s*data:font\/woff2;base64,[A-Za-z0-9+/=]{100,}/.test(String(svg))
}

const PAGE_JOB = async (source, dark) => {
  try {
    const { elements, files } = await window.__excal.parseMermaidToExcalidraw(source)
    // Unsupported diagram types come back as a rasterised <image> embed rather
    // than shapes; the plain mermaid path renders those better, so report it.
    if (elements.some((el) => el.type === 'image')) return { unsupported: true }
    // Excalidraw text has no markup, so a <br/> label arrives literal; the node
    // is already sized for the extra line. Mirrored in chrome/whiteboard-frame.js.
    const br = /<br\s*\/?>/gi
    for (const el of elements) {
      if (typeof el.text === 'string') el.text = el.text.replace(br, '\n')
      if (typeof el.label?.text === 'string') el.label.text = el.label.text.replace(br, '\n')
    }
    const converted = window.__excal.convertToExcalidrawElements(elements)
    const svg = await window.__excal.exportToSvg({
      elements: converted,
      files: files ?? {},
      appState: { exportBackground: false, exportWithDarkMode: dark },
    })
    return { svg: svg.outerHTML }
  } catch (e) {
    return { error: String(e && e.message ? e.message : e).slice(0, 300) }
  }
}

/** Every diagram ships its own Excalifont subset; a shared family name would
    let the last-inlined subset shadow the others' glyphs. */
export function scopeFontFamily(svg, source) {
  const scoped = 'Excalifont-' + createHash('sha1').update(source).digest('hex').slice(0, 8)
  return svg.replaceAll('Excalifont', scoped)
}

// Scene elements come from the editor already converted, so this skips the
// skeleton step the mermaid path needs.
const SCENE_JOB = async (scene, dark) => {
  try {
    const svg = await window.__excal.exportToSvg({
      elements: Array.isArray(scene?.elements) ? scene.elements : [],
      files: scene?.files ?? {},
      appState: { exportBackground: false, exportWithDarkMode: dark },
    })
    return { svg: svg.outerHTML }
  } catch (e) {
    return { error: String(e && e.message ? e.message : e).slice(0, 300) }
  }
}

export async function createConverter({ timeoutMs = 20000, launchArgs = [] } = {}) {
  await access(BUNDLE) // absent on a checkout that never ran npm install
  const { default: puppeteer } = await import('puppeteer')
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', ...launchArgs] })
  let page
  try {
    page = await browser.newPage()
    await page.setRequestInterception(true)
    page.on('request', async (req) => {
      const url = req.url()
      if (!/^https?:/i.test(url)) return req.continue().catch(() => {})
      const rel = url.match(/\/dist\/prod\/(.+)$/)?.[1]
      const body = rel ? await readAsset(rel) : null
      if (!body) return req.abort().catch(() => {})
      const type = CONTENT_TYPES[url.split('.').pop().toLowerCase()] || 'application/octet-stream'
      // The converter page is about:blank, so its origin is opaque and the
      // font fetch is cross-origin even though it never leaves the process.
      req
        .respond({ status: 200, contentType: type, headers: { 'access-control-allow-origin': '*' }, body })
        .catch(() => {})
    })
    await page.setContent('<!doctype html><html><body></body></html>')
    await page.addScriptTag({ path: BUNDLE })
    // Before any conversion: excalidraw sizes a label by measuring it, and the
    // export paints the real face, so an unregistered font clips every label.
    await page.evaluate(
      async (family, sources) => {
        for (const src of sources) {
          const face = new FontFace(family, `url(${src})`)
          try {
            document.fonts.add(await face.load())
          } catch {}
        }
        await document.fonts.ready
      },
      DRAWING_FONT,
      await drawingFontFaces()
    )
  } catch (err) {
    // The caller only ever sees a null converter, so nothing else would reap this.
    await browser.close().catch(() => {})
    throw err
  }

  return {
    /** → { ok, light, dark } | { ok: false, unsupported?, message? } */
    async convert(source) {
      try {
        const run = (dark) =>
          Promise.race([
            page.evaluate(PAGE_JOB, source, dark),
            new Promise((resolve) =>
              setTimeout(() => resolve({ error: `conversion timed out after ${timeoutMs}ms` }), timeoutMs)),
          ])
        const light = await run(false)
        if (light.unsupported) return { ok: false, unsupported: true }
        if (light.error) return { ok: false, message: light.error }
        // Label markup mermaid honours (<br/>) has no excalidraw equivalent and
        // would render as visible source text.
        if (/&lt;\s*br/i.test(light.svg)) return { ok: false, unsupported: true }
        const dark = await run(true)
        if (dark.unsupported || dark.error) return { ok: false, message: dark.error || 'dark variant failed' }
        if (!fontsEmbedded(light.svg) || !fontsEmbedded(dark.svg)) {
          return { ok: false, message: 'font assets unavailable — refusing to claim the sketch look' }
        }
        return {
          ok: true,
          light: scopeFontFamily(light.svg, source),
          dark: scopeFontFamily(dark.svg, source),
        }
      } catch (e) {
        return { ok: false, message: e && e.message ? e.message : 'conversion failed' }
      }
    },
    /** → { ok, svg } | { ok: false, message } */
    async sceneToSvg(scene, { dark = false } = {}) {
      try {
        const out = await Promise.race([
          page.evaluate(SCENE_JOB, scene, dark),
          new Promise((resolve) =>
            setTimeout(() => resolve({ error: `scene export timed out after ${timeoutMs}ms` }), timeoutMs)),
        ])
        if (out.error) return { ok: false, message: out.error }
        if (!fontsEmbedded(out.svg)) return { ok: false, message: 'font assets unavailable — scene not exported' }
        return { ok: true, svg: out.svg }
      } catch (e) {
        return { ok: false, message: e && e.message ? e.message : 'scene export failed' }
      }
    },
    async close() {
      await browser.close().catch(() => {})
    },
  }
}
