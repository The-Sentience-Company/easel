/* Next pick: one top-bar button and the N and B keys walk the board's unanswered
   picks in page order, across its tabs. A queue board carries no such button. */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-nextpick-'))
const SLOW = { timeout: 120000 }

const api = makeApi(BASE)
let daemon
let browser

// Long enough that no two picks share a screen, so every jump has to scroll.
const filler = Array.from({ length: 60 }, (_, i) => `filler line ${i}`).join('\n\n')
const decision = (id) => ({
  id,
  question: `decide ${id}`,
  what: `what ${id} builds`,
  why_you: `why ${id} is yours`,
  options: [
    { value: 'yes', label: 'Yes', basis: 'ships it' },
    { value: 'no', label: 'No', basis: 'drops it' },
  ],
})
const board = (title) => ({
  title,
  about: 'the work',
  sections: [
    { heading: 'Overview', body: 'intro', decisions: [decision('top')] },
    { heading: 'Alpha work', body: filler, tab: 'Alpha', decisions: [decision('alpha')] },
    { heading: 'Beta work', body: filler, tab: 'Beta', decisions: [decision('beta')], votes: [{ id: 'beta-vote', type: 'approve', question: 'ship beta' }] },
  ],
  decisions: [decision('last')],
})

before(async () => {
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  browser = await (await import('puppeteer')).default.launch({ headless: 'new', args: ['--no-sandbox'] })
}, SLOW)

after(async () => {
  await browser?.close()
  daemon?.kill('SIGTERM')
})

async function openBoard(title, hash = '') {
  const source = join(DATA_DIR, `${title.replace(/\W+/g, '-')}.json`)
  writeFileSync(source, JSON.stringify(board(title)))
  const key = (await api('POST', '/api/open', { template: 'review', data: source })).data.key
  const page = await openPage(key, hash)
  return { key, page, source }
}

// The flash lasts 1.2s, which a busy machine can outlast, so each page keeps the last pick flashed.
async function newPage() {
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => {
    new MutationObserver((records) => {
      for (const { target } of records) {
        if (target.matches?.('[data-widget].sf-flash')) window.__flashed = target.dataset.widgetId
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] })
  })
  return page
}

async function openPage(key, hash = '') {
  const page = await newPage()
  await page.setViewport({ width: 1300, height: 800 })
  await page.goto(`${BASE}/b/${key}${hash}`, { waitUntil: 'networkidle0', timeout: 60000 })
  await page.waitForSelector('.sf-tabs')
  return page
}

const probe = (page) => page.evaluate(() => {
  const button = document.querySelector('.sf-next-pick')
  const flashed = window.__flashed ? document.querySelector(`[data-widget-id="${window.__flashed}"]`) : null
  const box = flashed?.getBoundingClientRect()
  return {
    label: button ? button.textContent : null,
    disabled: button ? button.disabled : null,
    flashed: flashed?.dataset.widgetId ?? null,
    onScreen: box ? box.top >= 0 && box.bottom <= window.innerHeight : null,
    tab: document.querySelector('.sf-tab[aria-selected="true"] .sf-tab-label')?.textContent,
  }
})

async function press(page, key) {
  await page.keyboard.press(key)
  const { flashed, onScreen, tab } = await probe(page)
  return { flashed, onScreen, tab }
}

const answer = (page, id) =>
  page.evaluate((widgetId) => document.querySelector(`[data-widget-id="${widgetId}"] [data-option]`).click(), id)
const waitLabel = (page, label) =>
  page.waitForFunction((want) => document.querySelector('.sf-next-pick')?.textContent === want, {}, label)

test('N walks the open picks in page order across tabs and wraps, and B walks back', SLOW, async () => {
  const { page } = await openBoard('walk the picks')
  await waitLabel(page, '[N]ext pick · 5 left')

  assert.deepEqual(await press(page, 'n'), { flashed: 'top', onScreen: true, tab: 'Alpha' })
  assert.deepEqual(await press(page, 'n'), { flashed: 'alpha', onScreen: true, tab: 'Alpha' })
  assert.deepEqual(await press(page, 'n'), { flashed: 'beta', onScreen: true, tab: 'Beta' }, 'the jump opens the tab the pick sits on')
  assert.deepEqual(await press(page, 'n'), { flashed: 'beta-vote', onScreen: true, tab: 'Beta' })
  assert.deepEqual(await press(page, 'n'), { flashed: 'last', onScreen: true, tab: 'Beta' })
  assert.deepEqual(await press(page, 'n'), { flashed: 'top', onScreen: true, tab: 'Beta' }, 'past the last pick it wraps to the top')

  assert.deepEqual(await press(page, 'b'), { flashed: 'last', onScreen: true, tab: 'Beta' }, 'back from the first pick wraps to the last')
  assert.deepEqual(await press(page, 'b'), { flashed: 'beta-vote', onScreen: true, tab: 'Beta' })

  await page.click('.sf-next-pick')
  assert.equal((await probe(page)).flashed, 'last', 'the button does what N does')
  await page.close()
})

test('next starts from where the reader is, not from the top', SLOW, async () => {
  const { page } = await openBoard('from where you are')
  await waitLabel(page, '[N]ext pick · 5 left')
  await page.evaluate(() => [...document.querySelectorAll('.sf-tab')].find((t) => t.textContent.includes('Beta')).click())
  // The Beta decision's top is off the top of the screen; the Beta vote is still below.
  await page.evaluate(() => window.scrollTo(0, document.querySelector('[data-widget-id="beta"]').getBoundingClientRect().top + window.scrollY))

  assert.equal((await press(page, 'n')).flashed, 'beta-vote', 'the picks above the reader come only after a wrap')
  await page.evaluate(() => window.scrollTo(0, 0))
  assert.deepEqual(await press(page, 'b'), { flashed: 'alpha', onScreen: true, tab: 'Alpha' }, 'with Beta open, the tab left of it is behind the reader')
  await page.close()
})

test('a clicked pick stops counting, and the button greys out once none is open', SLOW, async () => {
  const { page } = await openBoard('answering picks')
  await waitLabel(page, '[N]ext pick · 5 left')

  await answer(page, 'top')
  await waitLabel(page, '[N]ext pick · 4 left')
  assert.equal((await press(page, 'n')).flashed, 'alpha', 'a pick clicked and not yet sent is skipped')

  for (const id of ['alpha', 'beta', 'beta-vote']) await answer(page, id)
  await waitLabel(page, '[N]ext pick · 1 left')
  await answer(page, 'last')
  await waitLabel(page, 'No open picks here')
  assert.equal((await probe(page)).disabled, true)
  await page.close()
})

test('a pick answered on an earlier round stays answered on the next one', SLOW, async () => {
  const { key, page, source } = await openBoard('earlier rounds')
  await waitLabel(page, '[N]ext pick · 5 left')
  await answer(page, 'alpha')
  await waitLabel(page, '[N]ext pick · 4 left')
  const clientId = await page.evaluate(() => localStorage.getItem('sf-client-id'))
  await api('POST', `/api/b/${key}/send`, { clientId })
  await page.close()

  const next = board('earlier rounds')
  next.sections[0].body = 'intro, reworded for round two'
  writeFileSync(source, JSON.stringify(next))
  await api('POST', `/api/b/${key}/publish`, { note: 'r2' })

  const round2 = await openPage(key)
  await waitLabel(round2, '[N]ext pick · 4 left')
  await round2.close()
})

test('a jump opens the folded block its pick sits in', SLOW, async () => {
  const file = join(DATA_DIR, 'folded.html')
  const pick = (id) => `<div data-widget="rating" data-widget-id="${id}"><div class="sd-widget-options"><button type="button" data-option="pass">pass</button></div></div>`
  writeFileSync(file, [
    '<h1>folded picks</h1>',
    `<section class="sd-section"><h2>Collapsed by the reader</h2><p>body</p>${pick('in-section')}</section>`,
    `<details><summary>a folded case</summary>${pick('in-details')}</details>`,
  ].join('\n'))
  const key = (await api('POST', '/api/open', { file, title: 'folded picks' })).data.key
  const page = await newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0', timeout: 60000 })
  await waitLabel(page, '[N]ext pick · 2 left')
  await page.evaluate(() => document.querySelector('.sd-section .sf-sec-toggle').click())
  assert.equal(await page.evaluate(() => document.querySelector('[data-widget-id="in-section"]').offsetParent), null, 'the section must start collapsed')

  assert.deepEqual(await press(page, 'n'), { flashed: 'in-section', onScreen: true, tab: undefined })
  assert.deepEqual(await press(page, 'n'), { flashed: 'in-details', onScreen: true, tab: undefined })
  assert.equal(await page.evaluate(() => document.querySelector('details').open), true)
  await page.close()
})

test('N typed into a comment box is a letter, not a jump', SLOW, async () => {
  const { page } = await openBoard('typing n')
  await waitLabel(page, '[N]ext pick · 5 left')
  await page.click('#sf-content h2')
  await page.waitForSelector('.sf-popover-text')
  await page.keyboard.type('nb')
  assert.equal(await page.evaluate(() => document.querySelector('.sf-popover-text').value), 'nb')
  assert.equal((await probe(page)).flashed, null)
  await page.close()
})

test('a #pick=<id> link opens the tab that pick sits on and flashes it', SLOW, async () => {
  const { key, page } = await openBoard('linked pick')
  await page.close()
  const linked = await openPage(key, '#pick=beta-vote')
  await linked.waitForFunction(() => window.__flashed === 'beta-vote')
  assert.deepEqual(await press(linked, 'Shift'), { flashed: 'beta-vote', onScreen: true, tab: 'Beta' })

  await linked.evaluate(() => { location.hash = '#pick=top' })
  await linked.waitForFunction(() => window.__flashed === 'top')
  await linked.close()
})

test('a queue board has no Next pick button, and N does nothing there', SLOW, async () => {
  const source = join(DATA_DIR, 'queue.json')
  writeFileSync(source, JSON.stringify({
    campaign: 'picks',
    entries: [{ id: 'ask-1', pane: 'a1', kind: 'decision', question: 'ship it', body: 'the brief', filed_at: '2026-01-01T00:00:00Z', status: 'open' }],
    open_prs: [{ number: 7, url: 'https://example.com/pr/7', title: 'a pull request' }],
  }))
  const key = (await api('POST', '/api/open', { template: 'queue', data: source })).data.key
  const page = await newPage()
  await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0', timeout: 60000 })
  await page.waitForSelector('[data-widget-id="ask-1"]')

  assert.equal(await page.evaluate(() => document.querySelector('.sf-next-pick').offsetParent), null, 'the button must not show')
  assert.equal((await press(page, 'n')).flashed, null)
  await page.close()
})
