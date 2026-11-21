/* A local <img src> is copied into the board's attachment store at render, so a
   round keeps rendering after the original file moves or is deleted. */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFragment } from 'parse5'
import { isLocalSrc } from '../templates/_html.js'

export const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024

export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/** Served names are exactly what this module writes: a sha256 and a known extension. */
export const STORED_NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp|svg)$/

// Typed by content, not by the name the author gave the file.
function sniff(bytes, path) {
  const head = bytes.subarray(0, 12)
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
  if (/^GIF8[79]a/.test(head.toString('latin1', 0, 6))) return 'gif'
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (/\.svg$/i.test(path) && /<svg[\s>]/i.test(bytes.toString('utf8'))) return 'svg'
  return null
}

function toPath(src, baseDir) {
  const s = src.trim()
  if (/^file:/i.test(s)) return fileURLToPath(s)
  return resolve(baseDir, s)
}

async function readImage(src, baseDir) {
  let path = toPath(src, baseDir)
  let info = await stat(path).catch(() => null)
  // A markdown src cannot hold a space, so it arrives percent-encoded.
  if (!info && src.includes('%')) {
    try {
      const decoded = toPath(decodeURIComponent(src), baseDir)
      const alt = await stat(decoded).catch(() => null)
      if (alt) [path, info] = [decoded, alt]
    } catch {}
  }
  if (!info) throw new Error(`local image ${path} (from src "${src}") does not exist`)
  if (!info.isFile()) throw new Error(`local image ${path} is not a file`)
  if (info.size > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error(`local image ${path} is ${(info.size / 1048576).toFixed(1)} MB; the cap is ${MAX_LOCAL_IMAGE_BYTES / 1048576} MB per image`)
  }
  let bytes
  try {
    bytes = await readFile(path)
  } catch (err) {
    throw new Error(`local image ${path} could not be read (${err.code || err.message})`)
  }
  const ext = sniff(bytes, path)
  if (!ext) throw new Error(`local image ${path} is not a png, jpeg, gif, webp or svg image`)
  return { bytes, ext }
}

function imgSrcAttrs(html) {
  const found = []
  const walk = (node, inIsland) => {
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue
      const island = inIsland || child.attrs.some((a) => a.name === 'data-island')
      if (child.tagName === 'img' && child.namespaceURI === 'http://www.w3.org/1999/xhtml') {
        const attr = child.attrs.find((a) => a.name === 'src')
        const loc = child.sourceCodeLocation?.attrs?.src
        if (attr && loc && isLocalSrc(attr.value)) found.push({ value: attr.value, loc, island })
      }
      walk(child.content ?? child, island)
    }
  }
  walk(parseFragment(html, { sourceCodeLocationInfo: true }), false)
  return found
}

/** Host-page images point at the hash route; island images become data: URIs (opaque origin, no network).
    Throws naming the path on a missing, oversized or non-image file: a dropped image reads as an empty card. */
export async function bakeLocalImages(html, { baseDir, storeDir, urlPrefix }) {
  const refs = imgSrcAttrs(html)
  if (!refs.length) return html
  const cache = new Map()
  let out = html
  // Back to front, so earlier offsets stay valid as the string changes length.
  for (const ref of refs.reverse()) {
    let img = cache.get(ref.value)
    if (!img) {
      const { bytes, ext } = await readImage(ref.value, baseDir)
      const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`
      await mkdir(storeDir, { recursive: true })
      await writeFile(join(storeDir, name), bytes, { flag: 'wx' }).catch((err) => {
        if (err.code !== 'EEXIST') throw err
      })
      img = { name, ext, bytes }
      cache.set(ref.value, img)
    }
    const src = ref.island
      ? `data:${IMAGE_TYPES[img.ext]};base64,${img.bytes.toString('base64')}`
      : `${urlPrefix}${img.name}`
    out = out.slice(0, ref.loc.startOffset) + `src="${src}"` + out.slice(ref.loc.endOffset)
  }
  return out
}

export const sourceDir = (board) => dirname(resolve(board.file ?? board.data_file))
