// Whiteboard: per-diagram scenes seeded from sources stored with the round,
// durable across a daemon restart, and never dropped when the source moves on.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-wb-'))
const PAGE = join(DATA_DIR, 'page.html')
const SLOW = { timeout: 180000 }

const FIRST = 'graph TD\n  A[first] --> B[second]'
const BROKEN = 'graph TD\n  ((((not a diagram'
const THIRD = 'graph LR\n  X[third] --> Y[fourth]'

const page = (...sources) =>
  `<p>intro</p>${sources.map((s) => `<pre class="mermaid">${s}</pre>`).join('')}`

const scene = (label) => ({
  type: 'excalidraw',
  version: 2,
  elements: [
    {
      id: `el-${label}`,
      type: 'rectangle',
      x: 0, y: 0, width: 100, height: 50,
      strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 1, roughness: 1, opacity: 100, seed: 1, version: 1, versionNonce: 1,
      isDeleted: false, groupIds: [], frameId: null, roundness: null, boundElements: [],
      updated: 1, link: null, locked: false, angle: 0, strokeStyle: 'solid',
    },
  ],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
})

let daemon
let key

// /api/open reuses an open board for the same file, so a test that needs its
// own must bring its own page.
const ownBoard = async (name) => {
  const path = join(DATA_DIR, `${name}.html`)
  writeFileSync(path, page(FIRST, BROKEN, THIRD))
  const { data } = await api('POST', '/api/open', { file: path, title: name })
  return data.key
}

// Writes name the version they edited, so a test writer reads it first; a
// deliberately stale write passes its own baseVersion instead.
const put = async (k, index, body) => {
  const current = await api('GET', `/api/b/${k}/whiteboard/${index}`)
  return api('PUT', `/api/b/${k}/whiteboard/${index}`, {
    baseVersion: current.data.whiteboard?.version ?? 0,
    ...body,
  })
}

const api = makeApi(BASE)

const restart = async () => {
  daemon.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
}

before(async () => {
  writeFileSync(PAGE, page(FIRST, BROKEN, THIRD))
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  const { data } = await api('POST', '/api/open', { file: PAGE, title: 'whiteboard' })
  key = data.key
}, SLOW)

after(() => daemon?.kill('SIGTERM'))

test('each diagram seeds from its own stored source', SLOW, async () => {
  const first = await api('GET', `/api/b/${key}/whiteboard/0`)
  const third = await api('GET', `/api/b/${key}/whiteboard/2`)
  assert.equal(first.data.source, FIRST)
  assert.equal(third.data.source, THIRD)
  assert.notEqual(first.data.sourceHash, third.data.sourceHash)
})

// A diagram that fails to render still occupies its ordinal; if it did not, the
// whiteboard for the diagram after it would open the wrong source.
test('a diagram that fails to render does not shift its neighbours', SLOW, async () => {
  const { data } = await api('GET', `/api/b/${key}/state`)
  const stamped = [...data.currentRound.html.matchAll(/data-diagram-index="(\d+)"/g)].map((m) => m[1])
  assert.deepEqual(stamped, ['0', '1', '2'])
  const broken = await api('GET', `/api/b/${key}/whiteboard/1`)
  assert.equal(broken.data.source, BROKEN)
})

test('a saved scene survives a daemon restart', SLOW, async () => {
  await put(key, 0, { scene: scene('durable'), sourceHash: 'hash-a' })
  await restart()
  const { data } = await api('GET', `/api/b/${key}/whiteboard/0`)
  assert.equal(data.whiteboard.scene.elements[0].id, 'el-durable')
  assert.equal(data.whiteboard.sourceHash, 'hash-a')
})

// The failure class this whole feature exists to avoid: a drawing must never be
// deleted or silently re-seeded because the diagram under it changed.
test('a source change flags the scene stale and keeps it', SLOW, async () => {
  const before = await api('GET', `/api/b/${key}/whiteboard/0`)
  await put(key, 0, {
    scene: scene('kept'),
    sourceHash: before.data.sourceHash,
  })
  const fresh = await api('GET', `/api/b/${key}/whiteboard/0`)
  assert.equal(fresh.data.stale, false, 'matching hash must not read as stale')

  writeFileSync(PAGE, page('graph TD\n  A[changed] --> B[second]', BROKEN, THIRD))
  await new Promise((r) => setTimeout(r, 400))
  await api('POST', `/api/b/${key}/publish`, {})

  const after = await api('GET', `/api/b/${key}/whiteboard/0`)
  assert.equal(after.data.stale, true, 'a scene drawn against an older source must read stale')
  assert.equal(after.data.whiteboard.scene.elements[0].id, 'el-kept', 'the drawing must survive')
  assert.match(after.data.source, /changed/, 'the seed offered is the new source')
})

test('a round with no stored sources opens blank with a reason, not an error', SLOW, async () => {
  // Written with the daemon down: its WAL checkpoint on exit can undo the UPDATE.
  daemon.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 300))
  const Database = (await import('better-sqlite3')).default
  const db = new Database(join(DATA_DIR, 'easel.db'))
  db.prepare(`UPDATE rounds SET diagrams_json = NULL WHERE surface_key = ?`).run(key)
  db.prepare(`UPDATE surfaces SET wip_html = NULL, wip_diagrams_json = NULL WHERE key = ?`).run(key)
  db.close()
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)

  const { status, data } = await api('GET', `/api/b/${key}/whiteboard/0`)
  assert.equal(status, 200)
  assert.equal(data.source, null)
  assert.match(data.reason, /before diagram sources were stored/)
})

test('a channel token is single use and scoped to its board', SLOW, async () => {
  const res = await fetch(`${BASE}/whiteboard-frame?key=${key}&diagramIndex=0`)
  const token = (await res.text()).match(/__easelWhiteboardChannelToken=("[^"]+")/)[1]
  const parsed = JSON.parse(token)
  assert.equal((await api('POST', `/api/b/${key}/whiteboard-channel`, { token: parsed })).status, 200)
  assert.equal((await api('POST', `/api/b/${key}/whiteboard-channel`, { token: parsed })).status, 403)
})

test('the frame names every source explicitly and no external host', SLOW, async () => {
  const res = await fetch(`${BASE}/whiteboard-frame?key=${key}&diagramIndex=0`)
  const csp = res.headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/)
  assert.ok(!/esm\.sh|unpkg|jsdelivr/.test(csp), 'no CDN may appear in the policy')
  // Opaque-origin documents do not match 'self', so the origin is named.
  assert.match(csp, new RegExp(`font-src http://127\\.0\\.0\\.1:${PORT} data:`))
})

// Chrome-injected controls act — they must never double as annotation targets.
test('Whiteboard and look-toggle clicks do not open the annotation popover', SLOW, async () => {
  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await pg.waitForSelector('.sf-diagram-look', { timeout: 30000 })
    await pg.evaluate(() => document.querySelector('.sf-diagram-look').click())
    assert.equal(await pg.$('.sf-popover'), null, 'the look toggle opened the annotation popover')
    assert.equal(
      await pg.evaluate(() => document.documentElement.dataset.diagramLook),
      'sketch', 'the look toggle did not act',
    )
    await pg.evaluate(() => document.querySelector('.sf-wb-open').click())
    assert.equal(await pg.$('.sf-popover'), null, 'the Whiteboard button opened the annotation popover')
  } finally {
    await browser.close()
  }
})

// Closing must flush edits the autosave debounce has not written yet. Nothing
// below the browser exercises this: it lives in the postMessage handshake.
test('closing flushes edits the autosave debounce has not written', SLOW, async () => {
  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.sf-wb-open', { timeout: 30000 })

    const before = await api('GET', `/api/b/${key}/whiteboard/2`)
    const countBefore = before.data.whiteboard?.scene?.elements?.length ?? 0

    // Diagram 2 has no scene yet, so any element proves the flush wrote.
    await page.evaluate(() => document.querySelectorAll('.sf-wb-open')[2].click())
    const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
    await frame.waitForSelector('.excalidraw', { timeout: 60000 })
    await new Promise((r) => setTimeout(r, 2500))

    const box = await (await frame.$('.excalidraw')).boundingBox()
    // The tool hotkey goes to whatever holds focus, and the click that opened
    // the overlay left it in the parent document.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.press('r')
    await page.mouse.move(box.x + 260, box.y + 220)
    await page.mouse.down()
    await page.mouse.move(box.x + 460, box.y + 360, { steps: 12 })
    await page.mouse.up()

    // Inside the 800ms debounce: only the teardown flush can save this.
    await frame.evaluate(() => document.querySelector('.wb-close').click())
    await new Promise((r) => setTimeout(r, 4000))

    const after = await api('GET', `/api/b/${key}/whiteboard/2`)
    const countAfter = after.data.whiteboard?.scene?.elements?.length ?? 0
    assert.ok(countAfter > countBefore, `close did not flush the edit (${countBefore} -> ${countAfter})`)
  } finally {
    await browser.close()
  }
})

// Two sends of one diagram must not share files: the first queued item would
// then show the second drawing — feedback pointing at content nobody sent.
test('each send snapshots its own scene files', SLOW, async () => {
  const { readFileSync } = await import('node:fs')
  const send = async (label) => {
    const current = await api('GET', `/api/b/${key}/whiteboard/0`)
    return api('POST', `/api/b/${key}/whiteboard/0/feedback`, {
      clientId: 'snapshot-client',
      scene: scene(label),
      note: label,
      summaryLines: [`note ${label}`],
      sourceHash: 'seed',
      baseVersion: current.data.whiteboard?.version ?? 0,
    })
  }

  const first = await send('first')
  const second = await send('second')
  const a = first.data.whiteboard
  const b = second.data.whiteboard
  assert.notEqual(a.scenePath, b.scenePath, 'a later send overwrote the earlier snapshot path')

  const kept = JSON.parse(readFileSync(a.scenePath, 'utf8'))
  assert.equal(kept.elements[0].id, 'el-first', 'the first item no longer points at what was sent')
})

// Opening loads the saved scene programmatically, which fires excalidraw's
// onChange; if that arms the autosave, a look becomes a write.
test('opening a whiteboard does not write to it', SLOW, async () => {
  const seeded = await api('GET', `/api/b/${key}/whiteboard/1`)
  await put(key, 1, { scene: scene('untouched'), sourceHash: seeded.data.sourceHash })
  const before = await api('GET', `/api/b/${key}/whiteboard/1`)

  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
    await page.evaluate(() => document.querySelectorAll('.sf-wb-open')[1].click())
    const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
    await frame.waitForSelector('.excalidraw', { timeout: 60000 })
    // Well past the 800ms debounce, with no user input at all.
    await new Promise((r) => setTimeout(r, 3000))

    const afterOpen = await api('GET', `/api/b/${key}/whiteboard/1`)
    assert.equal(afterOpen.data.whiteboard.updatedAt, before.data.whiteboard.updatedAt, 'an open must not write')

    // Measured separately: the teardown flush is its own unconditional write.
    await frame.evaluate(() => document.querySelector('.wb-close').click())
    await new Promise((r) => setTimeout(r, 3000))
    const afterClose = await api('GET', `/api/b/${key}/whiteboard/1`)
    assert.equal(afterClose.data.whiteboard.updatedAt, before.data.whiteboard.updatedAt, 'closing an untouched board must not write')
    assert.equal(afterClose.data.whiteboard.scene.elements[0].id, 'el-untouched')
  } finally {
    await browser.close()
  }
})

// A second writer stands in for a second tab: the open board must not flush its
// own stale scene over work it never saw.
test('closing a board nobody drew on does not clobber a newer scene', SLOW, async () => {
  await put(key, 1, { scene: scene('v1'), sourceHash: 'hash-v1' })

  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
    await page.evaluate(() => document.querySelectorAll('.sf-wb-open')[1].click())
    const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
    await frame.waitForSelector('.excalidraw', { timeout: 60000 })
    await new Promise((r) => setTimeout(r, 2500))

    await put(key, 1, { scene: scene('v2'), sourceHash: 'hash-v2' })

    await frame.evaluate(() => document.querySelector('.wb-close').click())
    await new Promise((r) => setTimeout(r, 3000))

    const { data } = await api('GET', `/api/b/${key}/whiteboard/1`)
    assert.equal(data.whiteboard.scene.elements[0].id, 'el-v2', 'the open board flushed over newer work')
  } finally {
    await browser.close()
  }
})

/* The server refuses these writes, so the frame must not offer a canvas and a
   Send button that look like they work. */
test('an ended board opens the whiteboard read-only and closes cleanly', SLOW, async () => {
  const endedKey = await ownBoard('ended-whiteboard')
  await put(endedKey, 1, { scene: scene('kept'), sourceHash: 'hash-kept' })
  assert.equal((await api('POST', `/api/b/${endedKey}/end`, {})).status, 200)

  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(`${BASE}/b/${endedKey}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
    await page.evaluate(() => document.querySelectorAll('.sf-wb-open')[1].click())
    const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
    await frame.waitForSelector('.excalidraw', { timeout: 60000 })
    await frame.waitForSelector('.wb-ended', { timeout: 30000 })

    const state = await frame.evaluate(() => ({
      send: document.querySelector('.wb-send').disabled,
      note: document.querySelector('.wb-note').disabled,
      viewMode: Boolean(document.querySelector('.excalidraw--view-mode')),
      banner: document.querySelector('.wb-ended').textContent,
    }))
    assert.equal(state.send, true, 'Send must not be offered on an ended board')
    assert.equal(state.note, true)
    assert.equal(state.viewMode, true, 'the canvas must be read-only, not merely unsaveable')
    assert.match(state.banner, /ended/)

    // A close that cannot flush would strand the reviewer on "close again to retry".
    await frame.evaluate(() => document.querySelector('.wb-close').click())
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.sf-wb-overlay')).display === 'none',
      { timeout: 15000 },
    )

    const after = await api('GET', `/api/b/${endedKey}/whiteboard/1`)
    assert.equal(after.data.whiteboard.scene.elements[0].id, 'el-kept', 'the stored scene must be untouched')
  } finally {
    await browser.close()
  }
})

/* Edits the debounce never wrote are lost when the end lands — the server
   refuses them — but the close must complete, not loop on "close again". */
test('an end arriving mid-edit does not trap the board open', SLOW, async () => {
  const midKey = await ownBoard('ended-mid-edit')

  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(`${BASE}/b/${midKey}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
    await page.evaluate(() => document.querySelectorAll('.sf-wb-open')[2].click())
    const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
    await frame.waitForSelector('.excalidraw', { timeout: 60000 })
    await new Promise((r) => setTimeout(r, 2500))

    const box = await (await frame.$('.excalidraw')).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.press('r')
    await page.mouse.move(box.x + 260, box.y + 220)
    await page.mouse.down()
    await page.mouse.move(box.x + 460, box.y + 360, { steps: 12 })
    await page.mouse.up()
    // Inside the 800ms debounce, so the edit is still unwritten when this lands.
    await api('POST', `/api/b/${midKey}/end`, {})

    await frame.waitForSelector('.wb-ended', { timeout: 15000 })
    const stored = await api('GET', `/api/b/${midKey}/whiteboard/2`)
    assert.equal(
      stored.data.whiteboard?.scene?.elements?.length ?? 0,
      0,
      'the autosave beat the end — this run proves nothing about a dirty board',
    )

    await frame.evaluate(() => document.querySelector('.wb-close').click())
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.sf-wb-overlay')).display === 'none',
      { timeout: 15000 },
    )
  } finally {
    await browser.close()
  }
})

test('a write names the version it edited, and an accepted write advances it', SLOW, async () => {
  const k = await ownBoard('versions')
  assert.equal((await api('GET', `/api/b/${k}/whiteboard/0`)).data.whiteboard, null)

  const first = await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: scene('v1'), baseVersion: 0 })
  assert.equal(first.data.whiteboard.version, 1)
  const second = await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: scene('v2'), baseVersion: 1 })
  assert.equal(second.data.whiteboard.version, 2)
  assert.equal((await api('GET', `/api/b/${k}/whiteboard/0`)).data.whiteboard.version, 2)
})

test('a write that does not name a base version is refused', SLOW, async () => {
  const k = await ownBoard('no-base')
  const put = await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: scene('x') })
  assert.equal(put.status, 400)
  const send = await api('POST', `/api/b/${k}/whiteboard/0/feedback`, { clientId: 'c1', scene: scene('x') })
  assert.equal(send.status, 400)
})

/* Last-writer-wins was the whole defect: the second editor's save has to be
   refused rather than silently merged over the first's. */
test('two tabs that both edited: the later write is refused, not merged', SLOW, async () => {
  const k = await ownBoard('two-tabs')
  await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: scene('shared'), baseVersion: 0 })

  const tabA = await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: scene('tab-a'), baseVersion: 1 })
  assert.equal(tabA.status, 200)
  const tabB = await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: scene('tab-b'), baseVersion: 1 })
  assert.equal(tabB.status, 409)
  assert.equal(tabB.data.code, 'whiteboard_conflict')
  assert.equal(tabB.data.whiteboard.version, 2, 'the conflict reports what is stored now')

  const stored = await api('GET', `/api/b/${k}/whiteboard/0`)
  assert.equal(stored.data.whiteboard.scene.elements[0].id, 'el-tab-a', 'the earlier write must survive')
})

// Send never went through the save path, so it was the way round the guard.
test('the send path is refused on a stale base and queues nothing', SLOW, async () => {
  const k = await ownBoard('stale-send')
  await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: scene('current'), baseVersion: 0 })
  await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: scene('newer'), baseVersion: 1 })

  const sent = await api('POST', `/api/b/${k}/whiteboard/0/feedback`, {
    clientId: 'c1', scene: scene('stale'), baseVersion: 1,
  })
  assert.equal(sent.status, 409)
  assert.equal(sent.data.code, 'whiteboard_conflict')

  const items = (await api('GET', `/api/b/${k}/feedback?since=0`)).data.items
  assert.ok(items.every((i) => i.kind !== 'whiteboard'), 'a refused send must queue nothing')
  const stored = await api('GET', `/api/b/${k}/whiteboard/0`)
  assert.equal(stored.data.whiteboard.scene.elements[0].id, 'el-newer')
})

// The row does not exist, so there is no stored version for the base to match.
test('a base above the stored version cannot create a scene', SLOW, async () => {
  const k = await ownBoard('phantom-base')
  const res = await api('PUT', `/api/b/${k}/whiteboard/0`, { scene: scene('phantom'), baseVersion: 3 })
  assert.equal(res.status, 409)
  assert.equal((await api('GET', `/api/b/${k}/whiteboard/0`)).data.whiteboard, null)
})

/* The reviewer's canvas is not replaced and the close is not a retry loop: they
   are told, Send is withdrawn, and the close button says what it will cost. */
test('a conflicted board says so, keeps the drawing, and still closes', SLOW, async () => {
  const k = await ownBoard('conflict-ui')

  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    let puts = 0
    page.on('request', (r) => {
      if (r.method() === 'PUT' && r.url().includes(`/whiteboard/2`)) puts++
    })
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(`${BASE}/b/${k}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
    await page.evaluate(() => document.querySelectorAll('.sf-wb-open')[2].click())
    const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
    await frame.waitForSelector('.excalidraw', { timeout: 60000 })
    await new Promise((r) => setTimeout(r, 2500))

    // A second writer moves the stored scene on while this board holds version 0.
    await api('PUT', `/api/b/${k}/whiteboard/2`, { scene: scene('elsewhere'), baseVersion: 0 })

    const box = await (await frame.$('.excalidraw')).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.press('r')
    await page.mouse.move(box.x + 260, box.y + 220)
    await page.mouse.down()
    await page.mouse.move(box.x + 460, box.y + 360, { steps: 12 })
    await page.mouse.up()

    await frame.waitForSelector('.wb-conflict', { timeout: 20000 })
    const state = await frame.evaluate(() => ({
      send: document.querySelector('.wb-send').disabled,
      close: document.querySelector('.wb-close').textContent,
      elements: document.querySelectorAll('.excalidraw canvas').length,
    }))
    assert.equal(state.send, true, 'Send must be withdrawn once the save can no longer land')
    assert.match(state.close, /without saving/, 'the close must say what it costs')
    assert.ok(state.elements > 0, 'the canvas must still be there')

    // Every later edit would post the whole scene to a server that will always
    // refuse it, so the board stops trying once it knows.
    const after = puts
    await page.mouse.move(box.x + 500, box.y + 400)
    await page.mouse.down()
    await page.mouse.move(box.x + 700, box.y + 520, { steps: 10 })
    await page.mouse.up()
    await new Promise((r) => setTimeout(r, 2500))
    assert.equal(puts, after, 'a conflicted board must stop retrying a save that cannot land')

    await frame.evaluate(() => document.querySelector('.wb-close').click())
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.sf-wb-overlay')).display === 'none',
      { timeout: 15000 },
    )

    const stored = await api('GET', `/api/b/${k}/whiteboard/2`)
    assert.equal(stored.data.whiteboard.scene.elements[0].id, 'el-elsewhere', 'the other writer must not be clobbered')
    assert.equal(stored.data.whiteboard.version, 1, 'a conflicted board writes nothing')
  } finally {
    await browser.close()
  }
})

/* A tab must never conflict with itself — that would tell the reviewer someone
   else saved when nobody did. */
test('a second write queued behind this tab\'s own save is not a conflict', SLOW, async () => {
  const k = await ownBoard('self-conflict')

  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(`${BASE}/b/${k}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
    await page.evaluate(() => document.querySelectorAll('.sf-wb-open')[2].click())
    const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
    await frame.waitForSelector('.excalidraw', { timeout: 60000 })
    await new Promise((r) => setTimeout(r, 2500))

    // Hold the first PUT open so the close flush is queued behind it — the exact
    // window in which a base stamped at post time goes stale.
    let release
    const held = new Promise((r) => { release = r })
    let conflicts = 0
    page.on('response', (r) => {
      if (r.url().includes('/whiteboard/2') && r.status() === 409) conflicts++
    })
    await page.setRequestInterception(true)
    let seen = 0
    page.on('request', async (r) => {
      if (r.method() === 'PUT' && r.url().includes('/whiteboard/2') && ++seen === 1) {
        await held
      }
      if (!r.isInterceptResolutionHandled()) r.continue()
    })

    const box = await (await frame.$('.excalidraw')).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.press('r')
    await page.mouse.move(box.x + 260, box.y + 220)
    await page.mouse.down()
    await page.mouse.move(box.x + 460, box.y + 360, { steps: 12 })
    await page.mouse.up()
    // Past the debounce, so the autosave is out and waiting on the hold.
    await new Promise((r) => setTimeout(r, 1200))

    await page.mouse.move(box.x + 520, box.y + 240)
    await page.mouse.down()
    await page.mouse.move(box.x + 700, box.y + 400, { steps: 10 })
    await page.mouse.up()
    await frame.evaluate(() => document.querySelector('.wb-close').click())
    await new Promise((r) => setTimeout(r, 300))
    release()

    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.sf-wb-overlay')).display === 'none',
      { timeout: 20000 },
    )
    assert.equal(conflicts, 0, 'a tab must not conflict with its own earlier write')

    const stored = await api('GET', `/api/b/${k}/whiteboard/2`)
    assert.ok(stored.data.whiteboard, 'the drawing must have been saved')
    assert.ok(stored.data.whiteboard.version >= 2, 'both writes must have landed')
  } finally {
    await browser.close()
  }
})

// Send writes the scene too, so it has to take its turn in the same queue.
test('sending while this tab\'s own autosave is in flight still queues', SLOW, async () => {
  const k = await ownBoard('send-during-save')

  const puppeteer = (await import('puppeteer')).default
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(`${BASE}/b/${k}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
    await page.evaluate(() => document.querySelectorAll('.sf-wb-open')[2].click())
    const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
    await frame.waitForSelector('.excalidraw', { timeout: 60000 })
    await new Promise((r) => setTimeout(r, 2500))

    let release
    const held = new Promise((r) => { release = r })
    let conflicts = 0
    let queued = 0
    page.on('response', (r) => {
      if (r.url().includes('/whiteboard/2') && r.status() === 409) conflicts++
      if (r.url().includes('/whiteboard/2/feedback') && r.status() === 200) queued++
    })
    await page.setRequestInterception(true)
    let seen = 0
    page.on('request', async (r) => {
      if (r.method() === 'PUT' && r.url().includes('/whiteboard/2') && ++seen === 1) await held
      if (!r.isInterceptResolutionHandled()) r.continue()
    })

    const box = await (await frame.$('.excalidraw')).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.press('r')
    await page.mouse.move(box.x + 260, box.y + 220)
    await page.mouse.down()
    await page.mouse.move(box.x + 460, box.y + 360, { steps: 12 })
    await page.mouse.up()
    await new Promise((r) => setTimeout(r, 1200))

    await frame.evaluate(() => document.querySelector('.wb-send').click())
    await new Promise((r) => setTimeout(r, 300))
    release()

    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.sf-wb-overlay')).display === 'none',
      { timeout: 20000 },
    )
    assert.equal(conflicts, 0, 'a send must not conflict with this tab\'s own autosave')

    assert.equal(queued, 1, 'the send must have been accepted')
    const stored = await api('GET', `/api/b/${k}/whiteboard/2`)
    assert.ok(stored.data.whiteboard.version >= 2, 'both the autosave and the send must have landed')
  } finally {
    await browser.close()
  }
})

test('asset paths cannot escape the bundle directory', SLOW, async () => {
  const res = await fetch(`${BASE}/whiteboard-assets/..%2f..%2f..%2fdaemon%2fserver.js`)
  assert.equal(res.status, 403)
})
