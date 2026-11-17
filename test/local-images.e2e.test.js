/* A board may name an image by local path: publish copies it into the board's
   attachment store and the round renders it, even after the original is gone. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-localimg-data-'))
const SRC_DIR = mkdtempSync(join(tmpdir(), 'sf-localimg-src-'))

// Two distinct 1x1 PNGs, so a swapped rewrite cannot pass.
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="teal"/></svg>')
const sha = (b) => createHash('sha256').update(b).digest('hex')

const api = makeApi(BASE)
let daemon

before(async () => {
  mkdirSync(join(SRC_DIR, 'shots'))
  writeFileSync(join(SRC_DIR, 'abs.png'), RED)
  writeFileSync(join(SRC_DIR, 'shots', 'rel.png'), BLUE)
  writeFileSync(join(SRC_DIR, 'icon.svg'), SVG)
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
})

after(() => daemon?.kill())

async function openFile(name, body) {
  const file = join(SRC_DIR, name)
  writeFileSync(file, body)
  return api('POST', '/api/open', { file, title: name })
}

const roundHtml = async (key) => (await api('GET', `/api/b/${key}/state`)).data.currentRound.html

async function fetchBytes(path) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) }
}

test('absolute and relative paths are rewritten to the board image route and serve the file bytes', async () => {
  const opened = await openFile(
    'paths.html',
    `<h1>shots</h1><p><img src="${join(SRC_DIR, 'abs.png')}" alt="a"></p><p><img src="shots/rel.png" alt="b"></p>`
  )
  assert.equal(opened.status, 200, JSON.stringify(opened.data))
  const { key } = opened.data
  const html = await roundHtml(key)
  const absUrl = `/b/${key}/img/${sha(RED)}.png`
  const relUrl = `/b/${key}/img/${sha(BLUE)}.png`
  assert.ok(html.includes(`src="${absUrl}"`), html)
  assert.ok(html.includes(`src="${relUrl}"`), html)
  assert.ok(!html.includes(SRC_DIR), 'no source path may survive into the round')

  const abs = await fetchBytes(absUrl)
  assert.equal(abs.status, 200)
  assert.equal(abs.headers.get('content-type'), 'image/png')
  assert.deepEqual(abs.bytes, RED)
  assert.deepEqual((await fetchBytes(relUrl)).bytes, BLUE)
})

test('a published round keeps rendering after the original file is deleted', async () => {
  const gone = join(SRC_DIR, 'gone.png')
  writeFileSync(gone, BLUE)
  const { data } = await openFile('gone.html', `<h1>gone</h1><p><img src="${pathToFileURL(gone).href}"></p>`)
  rmSync(gone)
  const res = await fetchBytes(`/b/${data.key}/img/${sha(BLUE)}.png`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.bytes, BLUE)
})

test('an image inside an island is inlined as a data: uri; the island stays network-free', async () => {
  const { data } = await openFile(
    'island.html',
    '<h1>island</h1><div data-island data-island-title="shots"><img src="abs.png"></div>'
  )
  const res = await fetch(`${BASE}/island-frame?key=${data.key}&index=0&round=1`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-security-policy'), /img-src data:;/)
  const body = await res.text()
  assert.ok(body.includes(`src="data:image/png;base64,${RED.toString('base64')}"`), body)
  assert.ok(!body.includes('/img/'), 'an island must not point at a network url')
})

test('markdown boards and gallery template srcs take local paths too', async () => {
  const md = await openFile('doc.md', '# md\n\n![red|40](abs.png)\n')
  assert.equal(md.status, 200, JSON.stringify(md.data))
  assert.ok((await roundHtml(md.data.key)).includes(`/b/${md.data.key}/img/${sha(RED)}.png`))

  const dataFile = join(SRC_DIR, 'gallery.json')
  writeFileSync(dataFile, JSON.stringify({
    title: 'local gallery',
    candidates: [{ label: 'red', src: 'abs.png' }, { label: 'blue', src: join(SRC_DIR, 'shots', 'rel.png') }],
  }))
  const g = await api('POST', '/api/open', { template: 'gallery', data: dataFile })
  assert.equal(g.status, 200, JSON.stringify(g.data))
  const html = await roundHtml(g.data.key)
  assert.ok(html.includes(`/b/${g.data.key}/img/${sha(RED)}.png`), html)
  assert.ok(html.includes(`/b/${g.data.key}/img/${sha(BLUE)}.png`), html)
})

test('a real browser paints both the host image and the island image', async () => {
  const { data } = await openFile(
    'browser.html',
    '<h1>b</h1><p><img id="host" src="abs.png"></p><div data-island data-island-title="i"><img id="inner" src="shots/rel.png"></div>'
  )
  const browser = await (await import('puppeteer')).default.launch({ headless: 'new' })
  try {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${data.key}`, { waitUntil: 'networkidle0' })
    await pg.waitForFunction(() => document.querySelector('#sf-content img')?.complete)
    assert.equal(await pg.$eval('#sf-content img', (i) => i.naturalWidth), 1)
    await pg.waitForSelector('iframe')
    const frame = await (await pg.$('iframe')).contentFrame()
    await frame.waitForFunction(() => document.querySelector('img')?.complete)
    assert.equal(await frame.$eval('img', (i) => i.naturalWidth), 1)
  } finally {
    await browser.close()
  }
})

test('a missing file fails the publish and names the path', async () => {
  const file = join(SRC_DIR, 'missing.html')
  const opened = await openFile('missing.html', '<h1>m</h1><p>fine</p>')
  writeFileSync(file, '<h1>m</h1><p><img src="nope/collapsed-0.png"></p>')
  const res = await api('POST', `/api/b/${opened.data.key}/publish`, {})
  assert.equal(res.status, 422)
  assert.ok(res.data.error.includes(join(SRC_DIR, 'nope', 'collapsed-0.png')), res.data.error)

  const fresh = await openFile('missing-open.html', `<p><img src="${join(SRC_DIR, 'absent.png')}"></p>`)
  assert.equal(fresh.status, 422)
  assert.ok(fresh.data.error.includes(join(SRC_DIR, 'absent.png')), fresh.data.error)
})

test('a non-image file or one over the size cap fails the publish', async () => {
  writeFileSync(join(SRC_DIR, 'fake.png'), 'not an image')
  const fake = await openFile('fake.html', '<p><img src="fake.png"></p>')
  assert.equal(fake.status, 422)
  assert.match(fake.data.error, /fake\.png is not a png, jpeg, gif, webp or svg image/)

  writeFileSync(join(SRC_DIR, 'huge.png'), Buffer.concat([RED, Buffer.alloc(10 * 1024 * 1024)]))
  const huge = await openFile('huge.html', '<p><img src="huge.png"></p>')
  assert.equal(huge.status, 422)
  assert.match(huge.data.error, /huge\.png is 10\.0 MB; the cap is 10 MB per image/)
})

test('an svg is served sandboxed so opening it directly runs no script on the daemon origin', async () => {
  const { data } = await openFile('svg.html', '<p><img src="icon.svg"></p>')
  const res = await fetchBytes(`/b/${data.key}/img/${sha(SVG)}.svg`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/svg+xml')
  assert.match(res.headers.get('content-security-policy'), /\bsandbox\b/)
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
})

test('the image route serves only stored hashes: traversal and unknown names are 404', async () => {
  const { data } = await openFile('trav.html', '<p><img src="abs.png"></p>')
  const key = data.key
  writeFileSync(join(DATA_DIR, 'secret.png'), RED)
  // Present in the board's own store but not named by hash: still not servable.
  writeFileSync(join(DATA_DIR, 'attachments', key, 'planted.png'), RED)
  writeFileSync(join(DATA_DIR, 'attachments', key, `${sha(RED)}.html`), '<script>x</script>')
  for (const path of [
    `/b/${key}/img/planted.png`,
    `/b/${key}/img/..%2F..%2Fsecret.png`,
    `/b/${key}/img/..%2F..%2Fconfig.json`,
    `/b/${key}/img/%2E%2E%2F%2E%2E%2Fsecret.png`,
    `/b/${key}/img/${'0'.repeat(64)}.png`,
    `/b/${key}/img/${sha(RED)}.html`,
    `/b/..%2F${key}/img/${sha(RED)}.png`,
    `/b/nosuchkey/img/${sha(RED)}.png`,
  ]) {
    const res = await fetchBytes(path)
    assert.equal(res.status, 404, path)
  }
})
