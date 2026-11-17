// Images a board stores: pasted into a comment, or shown by a round from the
// publishing agent's disk. Both land in attachments/<key>/ under their content
// hash, so the same bytes are one file and a name never changes meaning.
//
// At render, every <img> whose src names a file on disk is copied in and its
// src becomes the /b/<key>/files/<name> route, so the round never depends on
// the agent's file still being there. Web, data: and daemon paths are left
// alone, and only a src with an image extension counts as a file. Comments,
// <script>, <style>, <template> and island bodies are not scanned: an island's
// frame loads only data: images, so an island embeds its images itself.

import { open, writeFile, mkdir, stat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

// One row per accepted format; the bytes decide, never the file name.
export const IMAGE_KINDS = [
  { ext: 'png', mime: 'image/png', test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
]
export const FILE_TYPES = Object.fromEntries(IMAGE_KINDS.map((k) => [k.ext, k.mime]))
export const FILE_NAME = new RegExp(`^[0-9a-f]{64}\\.(${IMAGE_KINDS.map((k) => k.ext).join('|')})$`)
const MAX_BYTES = 15 * 1024 * 1024

/** Writes bytes as attachments/<key>/<sha256>.<ext> once; returns the file name. */
export async function saveAttachment(attachmentsDir, key, bytes, ext) {
  const dir = join(attachmentsDir, key)
  await mkdir(dir, { recursive: true })
  const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`
  // An existing file already holds these bytes and may be open by a reader.
  await writeFile(join(dir, name), bytes, { flag: 'wx' }).catch((err) => {
    if (err.code !== 'EEXIST') throw err
  })
  return name
}

// \s before src, so data-src and other *-src attributes never match.
const IMG_SRC = /(<img\b[^>]*?\ssrc=)(["'])(.*?)\2/gi
// A scheme, a fragment, a protocol-relative host, or one of the daemon's own paths.
const NOT_LOCAL = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/|\/(?:b|assets|whiteboard-assets)\/)/i
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i
// Text a browser never loads an <img> from on the board page itself.
const SKIP = /<!--[\s\S]*?-->|<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi

/** [start, end) ranges of island bodies: a data-island div to its matching close. */
function islandRanges(html) {
  const ranges = []
  for (const m of html.matchAll(/<div\b[^>]*\sdata-island\b[^>]*>/gi)) {
    let depth = 1
    const tags = /<(\/?)div\b[^>]*>/gi
    tags.lastIndex = m.index + m[0].length
    let t
    while (depth && (t = tags.exec(html))) depth += t[1] ? -1 : 1
    ranges.push([m.index, t ? t.index + t[0].length : html.length])
  }
  return ranges
}

/** The <img src> matches a browser would load from the board page. */
function boardImages(html) {
  const skipped = [...islandRanges(html), ...[...html.matchAll(SKIP)].map((m) => [m.index, m.index + m[0].length])]
  return [...html.matchAll(IMG_SRC)].filter((m) => !skipped.some(([a, b]) => m.index >= a && m.index < b))
}

const unescapeAttr = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

function toPath(src, baseDir) {
  const p = unescapeAttr(src)
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1))
  return isAbsolute(p) ? p : resolve(baseDir, p)
}

// Every save of a source re-renders it; an unchanged file is not re-read or re-hashed.
const hosted = new Map() // `${key}\0${path}` -> { mtimeMs, size, name }

// Tagged so the render error is reported as a path problem, not a schema one.
const imageError = (message) => Object.assign(new Error(message), { imagePath: true })

async function hostOne(src, { key, baseDir, attachmentsDir }) {
  const path = toPath(src, baseDir)
  let info
  try {
    info = await stat(await realpath(path))
  } catch {
    throw imageError(`image not found: ${src} (looked for ${path})`)
  }
  // Only a regular file: a FIFO would block the read and /dev/zero never ends.
  if (!info.isFile()) throw imageError(`not an image: ${src} is not a file`)
  const cacheKey = `${key}\0${path}`
  const seen = hosted.get(cacheKey)
  if (seen && seen.mtimeMs === info.mtimeMs && seen.size === info.size &&
    (await stat(join(attachmentsDir, key, seen.name)).catch(() => null))) return seen.name
  if (info.size > MAX_BYTES) throw imageError(`image too large: ${src} is over ${MAX_BYTES / 2 ** 20} MB`)
  // Read at most the cap, so a file that grows after the stat can't get past it.
  const handle = await open(path, 'r')
  let bytes
  try {
    const buf = Buffer.alloc(MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    if (bytesRead > MAX_BYTES) throw imageError(`image too large: ${src} is over ${MAX_BYTES / 2 ** 20} MB`)
    bytes = buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const kind = IMAGE_KINDS.find((k) => k.test(bytes))
  if (!kind) throw imageError(`not an image: ${src} is not a png, jpeg, gif or webp file`)
  const name = await saveAttachment(attachmentsDir, key, bytes, kind.ext)
  hosted.set(cacheKey, { mtimeMs: info.mtimeMs, size: info.size, name })
  return name
}

/** Copies on-disk images into the board and rewrites their src; throws naming
 *  the path when a file is missing, too large, or not a png, jpeg, gif or webp. */
export async function hostLocalImages(html, opts) {
  const local = boardImages(html).filter((m) => {
    const src = m[3].trim()
    return src && !NOT_LOCAL.test(src) && IMAGE_EXT.test(src)
  })
  if (!local.length) return html
  const sources = [...new Set(local.map((m) => m[3].trim()))]
  const routes = new Map(await Promise.all(sources.map(async (src) =>
    [src, `/b/${opts.key}/files/${await hostOne(src, opts)}`])))
  // Rewrite only the matches found above, from the end so earlier offsets hold.
  let out = html
  for (const m of local.reverse()) {
    const [all, head, q, src] = m
    out = out.slice(0, m.index) + `${head}${q}${routes.get(src.trim())}${q}` + out.slice(m.index + all.length)
  }
  return out
}
