/* Tabs: sibling [data-tab] panels become a bar the reader switches with, which
   must never hide what changed or what was annotated in a tab out of view. */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-tabs-'))

const api = makeApi(BASE)
let daemon
let browser

const SOURCE = join(DATA_DIR, 'tabs.json')
const board = (extra = '') => ({
  title: 'tabbed board',
  sections: [
    { heading: 'Overview', body: 'always visible intro' },
    { heading: 'Plan one', body: 'alpha body', tab: 'Alpha' },
    { heading: 'Plan two', body: 'alpha second body', tab: 'Alpha' },
    { heading: 'Beta work', body: `beta body${extra}`, tab: 'Beta' },
    { heading: 'Gamma work', body: 'gamma body', tab: 'Gamma' },
  ],
})

before(async () => {
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  browser = await (await import('puppeteer')).default.launch({ headless: 'new' })
})

after(async () => {
  await browser?.close()
  daemon?.kill()
})

const probe = (pg) => pg.evaluate(`(() => ({
  tabs: [...document.querySelectorAll('.sf-tab')].map((t) => t.querySelector('.sf-tab-label').textContent),
  selected: document.querySelector('.sf-tab[aria-selected="true"] .sf-tab-label')?.textContent,
  shown: [...document.querySelectorAll('[data-tab]')].filter((p) => p.offsetParent !== null).map((p) => p.dataset.tab),
  introShown: [...document.querySelectorAll('#sf-content h2')].find((h) => h.textContent.includes('Overview'))?.offsetParent != null,
  hash: location.hash,
}))()`)

const clickTab = (pg, label) =>
  pg.evaluate((l) => [...document.querySelectorAll('.sf-tab')].find((t) => t.textContent.includes(l)).click(), label)

describe('tabbed review board', () => {
  let key

  before(async () => {
    writeFileSync(SOURCE, JSON.stringify(board()))
    key = (await api('POST', '/api/open', { template: 'review', data: SOURCE })).data.key
  })

  test('one tab shows at a time, the intro above the bar always does, and the hash follows', async () => {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    await pg.waitForSelector('.sf-tabs')
    assert.deepEqual(await probe(pg), {
      tabs: ['Alpha', 'Beta', 'Gamma'], selected: 'Alpha', shown: ['Alpha'], introShown: true, hash: '#tab=Alpha',
    })

    await clickTab(pg, 'Beta')
    const after = await probe(pg)
    assert.deepEqual([after.selected, after.shown, after.hash], ['Beta', ['Beta'], '#tab=Beta'])

    await pg.focus('.sf-tab[aria-selected="true"]')
    await pg.keyboard.press('ArrowRight')
    assert.equal((await probe(pg)).selected, 'Gamma', 'arrow keys move along the bar')
    await pg.close()
  })

  test('the hash opens its tab on load', async () => {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}#tab=Gamma`, { waitUntil: 'networkidle0' })
    await pg.waitForSelector('.sf-tabs')
    assert.deepEqual((await probe(pg)).shown, ['Gamma'])
    await pg.close()
  })

  test('the bar and the next-tab button switch tabs and never open an annotation', async () => {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    await pg.waitForSelector('.sf-tabs')
    assert.equal(await pg.evaluate("document.body.classList.contains('sf-annotating')"), true)

    await pg.click('.sf-tabs')
    await clickTab(pg, 'Beta')
    await pg.evaluate("[...document.querySelectorAll('.sf-tab-next')].find((b) => b.offsetParent).click()")
    assert.equal((await probe(pg)).selected, 'Gamma', 'next goes to the following tab')
    assert.equal(await pg.evaluate("!!document.querySelector('.sf-popover')"), false, 'a tab control opened an annotation')
    await pg.close()
  })

  test('a hidden tab shows its changes and annotations, and a queue row opens it', async () => {
    writeFileSync(SOURCE, JSON.stringify(board(' plus a round-two sentence')))
    await api('POST', `/api/b/${key}/publish`, { note: 'r2' })

    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    await pg.waitForSelector('.sf-tabs')
    const clientId = await pg.evaluate("localStorage.getItem('sf-client-id')")
    const state = (await api('GET', `/api/b/${key}/state?clientId=${clientId}`)).data
    const sid = state.currentRound.html.match(/data-sid="([^"]+)"[^>]*>gamma body/)[1]
    await api('POST', `/api/b/${key}/feedback`, { clientId, round: 2, anchor: { sid }, comment: 'gamma note' })
    await pg.waitForSelector('.sf-tab-count')

    const badges = await pg.evaluate(`[...document.querySelectorAll('.sf-tab')].map((t) => ({
      label: t.querySelector('.sf-tab-label').textContent,
      diff: t.dataset.sfDiff ?? null,
      count: t.querySelector('.sf-tab-count')?.textContent ?? null,
    }))`)
    assert.deepEqual(badges, [
      { label: 'Alpha', diff: null, count: null },
      { label: 'Beta', diff: 'modified', count: null },
      { label: 'Gamma', diff: null, count: '1' },
    ])

    assert.equal((await probe(pg)).selected, 'Alpha')
    await pg.evaluate("document.querySelector('.sf-queue-toggle').click()")
    await pg.waitForSelector('.sf-queue-item')
    await pg.evaluate("document.querySelector('.sf-queue-item').click()")
    assert.equal((await probe(pg)).selected, 'Gamma', 'revealing an anchor in a hidden tab must open that tab')
    await pg.close()
  })

  test('the chosen tab survives a round switch', async () => {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    await pg.waitForSelector('.sf-tabs')
    await clickTab(pg, 'Beta')
    await pg.keyboard.press('q')
    await pg.waitForFunction("document.querySelector('.sf-round-pill.sf-round-active')?.dataset.round === '1'")
    assert.equal((await probe(pg)).selected, 'Beta')
    await pg.close()
  })
})
