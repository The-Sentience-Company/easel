// Shared e2e harness: spawn a scratch daemon, wait for health, call its API.
import { spawn } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

export const REBUILD_CMD = 'node render/build-excalidraw.mjs'

/* The daemon serves render/.gen, not the sources, so editing a bundle input and
   running e2e without rebuilding tests the previous build. */
/* The builder is an input to everything it emits: changing which assets it copies
   stales every artifact without touching a single source file. */
const BUILDER = 'render/build-excalidraw.mjs'

export const BUNDLES = [
  { out: 'render/.gen/excalidraw-bundle.js', inputs: ['render/excalidraw-entry.js'] },
  {
    out: 'render/.gen/whiteboard/whiteboard.js',
    inputs: ['chrome/whiteboard-frame.js', 'chrome/whiteboard-protocol.js'],
  },
  { out: 'render/.gen/whiteboard/frame.css', inputs: ['chrome/whiteboard-frame.css'] },
].map((b) => ({ ...b, inputs: [...b.inputs, BUILDER] }))

const mtime = (p) => statSync(p).mtimeMs

/* An absent artifact is not staleness: the build skips wholesale where esbuild
   is not installed, and those installs have no whiteboard to test. */
export function staleBundles(root = ROOT, bundles = BUNDLES) {
  const stale = []
  for (const { out, inputs } of bundles) {
    const outPath = join(root, out)
    if (!existsSync(outPath)) continue
    const builtAt = mtime(outPath)
    for (const input of inputs) {
      const inPath = join(root, input)
      if (existsSync(inPath) && mtime(inPath) > builtAt) stale.push({ out, input })
    }
  }
  return stale
}

/** Throws naming the stale artifact and the command that fixes it. */
export function assertBundleFresh(root = ROOT, bundles = BUNDLES) {
  const stale = staleBundles(root, bundles)
  if (!stale.length) return true
  const lines = stale.map(({ out, input }) => `  ${out} is older than ${input}`)
  throw new Error(
    `stale bundle — e2e would test the previous build:\n${lines.join('\n')}\n` +
    `  rebuild with: ${REBUILD_CMD}`)
}

/* Hand-written per-file bands overlapped, so failures depended on the pids dealt. */
/* 40 wide, not 20: the spare room is what keeps two concurrent suite runs off
   each other's ports, since the offset within a band is still the pid. */
const BAND = 40
/* Above the daemon's own 43xx-44xx ports and clear of the 5000/5200/5432 range
   macOS and postgres occupy; still below the 49152 ephemeral floor. */
const FIRST_PORT = 9300

/** Every test file, sorted — position in this list is what owns a band. */
export function testFiles(dir = HERE) {
  return readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort()
}

/* Bands come from position in the sorted file list, so they cannot overlap by
   construction and a new test file gets its own band without being told. */
export function bandFor(file, files = testFiles()) {
  const i = files.indexOf(file)
  if (i === -1) throw new Error(`bandFor: ${file} is not a .test.js file in ${HERE}`)
  const start = FIRST_PORT + i * BAND
  return { file, start, end: start + BAND - 1 }
}

/** Throws naming both files on any overlap — a duplicate band must not flake. */
export function assertDisjoint(bands) {
  const sorted = [...bands].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (cur.start <= prev.end) {
      throw new Error(`port bands overlap: ${prev.file} [${prev.start}-${prev.end}] ` +
        `and ${cur.file} [${cur.start}-${cur.end}]`)
    }
  }
  return true
}

/* A file needing a second listener must take it from its OWN band; deriving one
   arithmetically (PORT + 100) lands in whichever file owns that range. */
const PORTS_PER_FILE = 4

/** A port this file owns; `index` picks among the several it may hold. */
export function portFor(metaUrl, index = 0) {
  if (!Number.isInteger(index) || index < 0 || index >= PORTS_PER_FILE) {
    throw new Error(`portFor: index must be 0..${PORTS_PER_FILE - 1}, got ${index}`)
  }
  const { start } = bandFor(basename(fileURLToPath(metaUrl)))
  return start + (process.pid % (BAND - PORTS_PER_FILE + 1)) + index
}

export function startDaemon(port, dataDir) {
  // Every e2e comes through here, so one stale bundle fails the whole suite with
  // the reason rather than as a handful of unrelated-looking assertion failures.
  assertBundleFresh()
  return spawn('node', [join(ROOT, 'daemon', 'server.js')], {
    env: { ...process.env, EASEL_PORT: String(port), EASEL_DATA_DIR: dataDir },
    stdio: 'ignore',
  })
}

export async function waitHealthy(base) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('daemon never became healthy')
}

export function makeApi(base) {
  return async function api(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, data: await res.json() }
  }
}
