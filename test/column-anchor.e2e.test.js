/* Column-header anchors echo down their column; body cells anchor individually. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-colanchor-'))
const PAGE = join(DATA_DIR, 'page.html')

const api = makeApi(BASE)
let daemon
let browser
let key

before(async () => {
  writeFileSync(PAGE,
    '<div class="sd-tablewrap"><table><thead><tr><th>case</th><th>status</th></tr></thead>' +
    '<tbody><tr><td>alpha</td><td>pass</td></tr><tr><td>beta</td><td>fail</td></tr></tbody></table></div>' +
    '<div class="sd-tablewrap"><table id="span"><thead><tr><th colspan="2">wide</th><th>tail</th></tr></thead>' +
    '<tbody><tr><td>w1</td><td>w2</td><td>t1</td></tr><tr><td colspan="3">spanning widget row</td></tr></tbody></table></div>' +
    '<div class="sd-tablewrap"><table id="rowhead"><tbody><tr><th>row label</th><td>value</td></tr></tbody></table></div>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  key = (await api('POST', '/api/open', { file: PAGE, title: 'column anchors' })).data.key
  browser = await (await import('puppeteer')).default.launch({ headless: 'new' })
})

after(async () => {
  await browser?.close()
  daemon?.kill()
})

test('an annotation on a th echoes down its column cells', async () => {
  const thSid = await api('GET', `/api/b/${key}/state`).then(({ data }) =>
    data.currentRound.html.match(/<th data-sid="([^"]+)"[^>]*>status/)?.[1])
  assert.ok(thSid, 'the status th must carry a sid')
  await api('POST', `/api/b/${key}/feedback`, { clientId: 'c1', round: 1, anchor: { sid: thSid }, comment: 'column note' })
  await api('POST', `/api/b/${key}/send`, { clientId: 'c1' })

  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  const got = await page.evaluate(`(() => {
    const th = document.querySelector('th.sf-annotated')
    const echoed = [...document.querySelectorAll('td.sf-annotated-col')].map((c) => c.textContent.trim())
    const firstCol = document.querySelector('tbody td')
    return { th: th?.textContent.replace(/^[A-Z]\\d/, '').trim() ?? null, echoed, firstColEchoed: firstCol?.classList.contains('sf-annotated-col') }
  })()`)
  assert.equal(got.th, 'status', 'the th itself must carry the annotated mark')
  assert.deepEqual(got.echoed, ['pass', 'fail'], 'both status cells must echo the column mark')
  assert.equal(got.firstColEchoed, false, 'the other column must stay unmarked')
  await page.close()
})

test('hovering a th highlights only the th; a body cell hovers the cell itself', async () => {
  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  await page.hover('thead th:nth-child(2)')
  let got = await page.evaluate(`[...document.querySelectorAll('.sf-hover')].map((n) => n.tagName)`)
  assert.deepEqual(got, ['TH'], `th hover must not spill into the column, got: ${got}`)

  await page.hover('tbody td')
  got = await page.evaluate(`[...document.querySelectorAll('.sf-hover')].map((n) => [n.tagName, n.textContent.trim()])`)
  assert.deepEqual(got, [['TD', 'alpha']], `a body cell must hover itself — row × column select, got: ${got}`)
  await page.close()
})

test('colspan headers map to logical columns; a spanning widget row stays out', async () => {
  const sid = async (re) => (await api('GET', `/api/b/${key}/state`)).data.currentRound.html.match(re)?.[1]
  const tailSid = await sid(/<th data-sid="([^"]+)"[^>]*>tail/)
  assert.ok(tailSid, 'the tail th must carry a sid')
  await api('POST', `/api/b/${key}/feedback`, { clientId: 'c2', round: 1, anchor: { sid: tailSid }, comment: 'tail col' })
  await api('POST', `/api/b/${key}/send`, { clientId: 'c2' })

  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  const echoed = () => page.evaluate(`[...document.querySelectorAll('#span td.sf-annotated-col')].map((n) => n.textContent.trim()).sort()`)
  assert.deepEqual(await echoed(), ['t1'], 'the tail header must echo only t1')

  const wideSid = await sid(/<th colspan="2" data-sid="([^"]+)"[^>]*>wide|<th data-sid="([^"]+)" colspan="2"[^>]*>wide/)
  const wide = wideSid || await sid(/<th[^>]*data-sid="([^"]+)"[^>]*>wide/)
  assert.ok(wide, 'the wide th must carry a sid')
  await api('POST', `/api/b/${key}/feedback`, { clientId: 'c3', round: 1, anchor: { sid: wide }, comment: 'wide cols' })
  await api('POST', `/api/b/${key}/send`, { clientId: 'c3' })
  await page.reload({ waitUntil: 'networkidle0' })
  assert.deepEqual(await echoed(), ['t1', 'w1', 'w2'], 'the wide header must add both its columns')
  await page.close()
})

test('a tbody row header hovers itself as a cell, never a column', async () => {
  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  await page.hover('#rowhead th')
  const got = await page.evaluate(`[...document.querySelectorAll('#rowhead .sf-hover')].map((n) => n.tagName)`)
  assert.deepEqual(got, ['TH'], `row-header hover must select the cell, got: ${got}`)
  const echoed = await page.evaluate(`document.querySelectorAll('#rowhead .sf-annotated-col').length`)
  assert.equal(echoed, 0, 'a tbody th must never echo a column')
  await page.close()
})

test('a saved cell anchor marks only its cell and hosts its own badge', async () => {
  const html = (await api('GET', `/api/b/${key}/state`)).data.currentRound.html
  const tdSid = html.match(/<td data-sid="([^"]+)"[^>]*>beta/)?.[1]
  assert.ok(tdSid, 'the beta td must carry a sid')
  await api('POST', `/api/b/${key}/feedback`, { clientId: 'c4', round: 1, anchor: { sid: tdSid }, comment: 'cell note' })
  await api('POST', `/api/b/${key}/send`, { clientId: 'c4' })

  const page = await browser.newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  const got = await page.evaluate(`(() => {
    const cell = [...document.querySelectorAll('td.sf-annotated')].map((n) => n.textContent.trim())
    return { cell, rowMarked: Boolean(document.querySelector('tr.sf-annotated')) }
  })()`)
  assert.ok(got.cell.some((t) => t.includes('beta')), `the beta cell must carry the mark, got: ${got.cell}`)
  assert.equal(got.rowMarked, false, 'the row must stay unmarked for a cell anchor')
  await page.close()
})
