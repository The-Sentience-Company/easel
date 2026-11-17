// Images a board stores: pasted into a comment, or shown by a round from the
// publishing agent's disk. Both land in attachments/<key>/ under their content
// hash, so the same bytes are one file and a name never changes meaning.
//
// At render, every <img> whose src names a file on disk is copied in and its
// src becomes the /b/<key>/files/<name> route, so the round never depends on
// the agent's file still being there. Web, data: and daemon paths are left
// alone. An island's frame loads only data: images, so an island embeds its
// images itself rather than naming a file.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
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

const IMG_SRC = /(<img\b[^>]*?\bsrc=)(["'])(.*?)\2/gi
// A scheme, a fragment, a protocol-relative host, or one of the daemon's own paths.
const NOT_LOCAL = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/|\/(?:b|assets|whiteboard-assets)\/)/i

const unescapeAttr = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

function toPath(src, baseDir) {
  const p = unescapeAttr(src)
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1))
  return isAbsolute(p) ? p : resolve(baseDir, p)
}

// Every save of a source re-renders it; an unchanged file is not re-read or re-hashed.
const hosted = new Map() // `${key}\0${path}` -> { mtimeMs, size, name }

async function hostOne(src, { key, baseDir, attachmentsDir }) {
  const path = toPath(src, baseDir)
  let info
  try {
    info = await stat(path)
  } catch {
    throw new Error(`image not found: ${src} (looked for ${path})`)
  }
  const cacheKey = `${key}\0${path}`
  const seen = hosted.get(cacheKey)
  if (seen && seen.mtimeMs === info.mtimeMs && seen.size === info.size) return seen.name
  if (info.size > MAX_BYTES) throw new Error(`image too large: ${src} is over ${MAX_BYTES / 2 ** 20} MB`)
  const bytes = await readFile(path)
  const kind = IMAGE_KINDS.find((k) => k.test(bytes))
  if (!kind) throw new Error(`not an image: ${src} is not a png, jpeg, gif or webp file`)
  const name = await saveAttachment(attachmentsDir, key, bytes, kind.ext)
  hosted.set(cacheKey, { mtimeMs: info.mtimeMs, size: info.size, name })
  return name
}

/** Copies on-disk images into the board and rewrites their src; throws naming
 *  the path when a file is missing, too large, or not a png, jpeg, gif or webp. */
export async function hostLocalImages(html, opts) {
  const sources = new Set()
  for (const m of html.matchAll(IMG_SRC)) {
    const src = m[3].trim()
    if (src && !NOT_LOCAL.test(src)) sources.add(src)
  }
  if (!sources.size) return html
  const routes = new Map(await Promise.all([...sources].map(async (src) =>
    [src, `/b/${opts.key}/files/${await hostOne(src, opts)}`])))
  return html.replace(IMG_SRC, (all, head, q, src) => {
    const route = routes.get(src.trim())
    return route ? `${head}${q}${route}${q}` : all
  })
}
