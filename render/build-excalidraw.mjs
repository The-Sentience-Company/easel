// Builds the converter bundle (headless chromium) and the whiteboard frame bundle.
// Either may skip on a build-deps-less install; each degrades on its own.
import { cp, mkdir, readdir, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const GEN = join(HERE, '.gen')
const CONVERTER_OUT = join(GEN, 'excalidraw-bundle.js')
const WHITEBOARD_DIR = join(GEN, 'whiteboard')

let build
try {
  ;({ build } = await import('esbuild'))
} catch {
  console.log('skipping excalidraw bundles: esbuild not installed (diagrams render via mermaid, no whiteboard)')
  process.exit(0)
}

const SHARED = {
  bundle: true,
  format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
  logLevel: 'warning',
}

async function buildConverter() {
  await mkdir(GEN, { recursive: true })
  await build({ ...SHARED, entryPoints: [join(HERE, 'excalidraw-entry.js')], outfile: CONVERTER_OUT })
  console.log(`built ${CONVERTER_OUT}`)
}

/** Vendors the whole asset tree so no runtime font/worker lookup has a reason to
    reach excalidraw's esm.sh fallback; the frame's CSP makes reaching it impossible. */
async function buildWhiteboard() {
  const prod = dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw'))

  await mkdir(WHITEBOARD_DIR, { recursive: true })
  await build({
    ...SHARED,
    entryPoints: [join(HERE, '..', 'chrome', 'whiteboard-frame.js')],
    outfile: join(WHITEBOARD_DIR, 'whiteboard.js'),
  })
  await copyFile(join(prod, 'index.css'), join(WHITEBOARD_DIR, 'whiteboard.css'))
  await copyFile(join(HERE, '..', 'chrome', 'whiteboard-frame.css'), join(WHITEBOARD_DIR, 'frame.css'))
  // Layout must mirror dist/prod: EXCALIDRAW_ASSET_PATH resolves fonts/ and the
  // subset chunks relative to the same root the frame's own files are served from.
  await cp(join(prod, 'fonts'), join(WHITEBOARD_DIR, 'fonts'), { recursive: true })
  for (const entry of await readdir(prod)) {
    if (entry.endsWith('.chunk.js')) await copyFile(join(prod, entry), join(WHITEBOARD_DIR, entry))
  }
  console.log(`built ${WHITEBOARD_DIR}`)
}

for (const [what, run] of [['converter', buildConverter], ['whiteboard', buildWhiteboard]]) {
  try {
    await run()
  } catch (err) {
    console.log(`skipping excalidraw ${what} bundle: ${String(err?.message || err).split('\n')[0]}`)
  }
}
