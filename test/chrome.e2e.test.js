/* Chrome behavior contracts under one shared daemon + browser: ended-board
   locking, removed content, round hotkeys, theme toggle, topbar, tuner. */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-chrome-'))

const api = makeApi(BASE)
let daemon
let browser

before(async () => {
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  browser = await (await import('puppeteer')).default.launch({ headless: 'new' })
})

after(async () => {
  await browser?.close()
  daemon?.kill()
})

const page = (name, html) => {
  const path = join(DATA_DIR, name)
  writeFileSync(path, html)
  return path
}

const open = async (path, title) => (await api('POST', '/api/open', { file: path, title })).data.key

/* The theme cluster and the gear live in the expanded bar, which only opens by
   default past 1500px — those tests need the room. */
const widePage = async () => {
  const pg = await browser.newPage()
  await pg.setViewport({ width: 1600, height: 700 })
  return pg
}

/* The chrome half of the ended invariant: a tab must not offer controls that
   the server will refuse. */
describe('ended board chrome', () => {
  const PAGE = page('ended.html', '<h1>ended chrome</h1><p>para one</p><div data-widget="approve" data-widget-id="w1"><div class="sd-widget-options"><button type="button" data-option="yes">yes</button></div></div>')

  const controls = () => ({
    annotate: document.querySelector('.sf-annotate-toggle')?.disabled,
    queueSend: document.querySelector('.sf-queue-send')?.disabled,
    chatInput: document.querySelector('.sf-chat-input')?.disabled,
    chatSubmit: document.querySelector('.sf-chat-submit')?.disabled,
    widgetOption: document.querySelector('#sf-content [data-widget] [data-option]')?.disabled,
    // The chrome hides with display, so `hidden` would read true either way.
    bannerShown: getComputedStyle(document.querySelector('.sf-ended-banner')).display !== 'none',
    status: document.querySelector('.sf-status-label')?.textContent,
  })

  const readControls = (pg) => pg.evaluate(controls)

  test('a tab opened while the board is live has working controls', async () => {
    const key = await open(PAGE, 'ended chrome')
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    const c = await readControls(pg)
    assert.equal(c.annotate, false)
    assert.equal(c.chatInput, false)
    assert.equal(c.widgetOption, false)
    assert.equal(c.bannerShown, false)
    await pg.close()
  })

  test('a FRESH tab on an already-ended board offers no write control', async () => {
    const key = await open(PAGE, 'ended chrome')
    await api('POST', `/api/b/${key}/end`, {})

    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    const c = await readControls(pg)
    assert.equal(c.status, 'ended', 'the status must not read live on an ended board')
    assert.equal(c.annotate, true)
    assert.equal(c.queueSend, true)
    assert.equal(c.chatInput, true)
    assert.equal(c.chatSubmit, true)
    assert.equal(c.widgetOption, true, 'a widget option must not be clickable')
    assert.equal(c.bannerShown, true)
    await pg.close()
  })

  test('a tab open BEFORE the end is disabled when the end arrives', async () => {
    const key = await open(PAGE, 'ended chrome')
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    assert.equal((await readControls(pg)).annotate, false)

    await api('POST', `/api/b/${key}/end`, {})
    await pg.waitForFunction(() => document.querySelector('.sf-annotate-toggle')?.disabled === true, { timeout: 5000 })

    const c = await readControls(pg)
    assert.equal(c.widgetOption, true)
    assert.equal(c.bannerShown, true)
    await pg.close()
  })
})

/* A round that deleted content still renders only the surviving content. */
describe('removed content', () => {
  const PAGE = join(DATA_DIR, 'removed.html')
  let key

  before(async () => {
    writeFileSync(PAGE, '<p>first paragraph</p><p>doomed middle paragraph</p><p>last paragraph</p>')
    key = await open(PAGE, 'removed content')
    writeFileSync(PAGE, '<p>first paragraph</p><p>last paragraph</p>')
    await api('POST', `/api/b/${key}/publish`, { note: 'round 2: middle removed' })
  })

  test('deleted content leaves no ghost, no toggle, and no x hotkey behind', async () => {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    const probe = () => pg.evaluate(`(() => ({
      ghosts: document.querySelectorAll('.sf-ghost-item').length,
      toggles: document.querySelectorAll('.sf-removed-toggle').length,
      onContent: document.querySelector('#sf-content').classList.contains('sf-show-removed'),
      body: document.querySelector('#sf-content').textContent.includes('doomed middle paragraph'),
    }))()`)

    assert.deepEqual(await probe(), { ghosts: 0, toggles: 0, onContent: false, body: false })
    // The differ still reports the removal; only the reader-side rendering is gone.
    const { diff } = (await api('GET', `/api/b/${key}/state?clientId=seed`)).data
    assert.equal(diff.removedDetail.length, 1)

    await pg.keyboard.press('x')
    assert.deepEqual(await probe(), { ghosts: 0, toggles: 0, onContent: false, body: false })
    await pg.close()
  })

  test('feedback stays with the round it was left on', async () => {
    const r1 = (await api('GET', `/api/b/${key}/state?clientId=seed&round=1`)).data
    const sid = r1.currentRound.html.match(/data-sid="([^"]+)"[^>]*>first paragraph/)[1]
    await api('POST', `/api/b/${key}/feedback`, { clientId: 'seed', round: 1, anchor: { sid }, comment: 'r1 note' })
    await api('POST', `/api/b/${key}/send`, { clientId: 'seed' })

    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    const rows = () => pg.evaluate("document.querySelectorAll('.sf-queue-item').length")
    assert.equal(await rows(), 0, 'the round-2 view must not list round-1 feedback')

    await pg.evaluate(`[...document.querySelectorAll('.sf-round-pill')].find((p) => p.dataset.round === '1').click()`)
    await pg.waitForFunction("document.querySelectorAll('.sf-queue-item').length === 1", { timeout: 5000 })
    await pg.close()
  })
})

/* A long-running board must not spend four lines of chrome on its pills. */
describe('many rounds collapse to one line', () => {
  const PAGE = join(DATA_DIR, 'many-rounds.html')
  let key

  before(async () => {
    writeFileSync(PAGE, '<p>body 1</p>')
    key = await open(PAGE, 'many rounds')
    for (let i = 2; i <= 40; i++) {
      writeFileSync(PAGE, `<p>body ${i}</p>`)
      await api('POST', `/api/b/${key}/publish`, { note: `round ${i}` })
    }
  })

  test('the pills scroll on one line until the reader expands them', async () => {
    const pg = await browser.newPage()
    // Wide enough to open expanded: the expand control belongs to the full bar.
    await pg.setViewport({ width: 1600, height: 800 })
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    await pg.waitForFunction("document.querySelectorAll('.sf-round-pill').length === 40", { timeout: 15000 })

    const strip = () => pg.evaluate(`(() => {
      const s = document.querySelector('.sf-round-strip')
      const pills = [...document.querySelectorAll('.sf-round-pill')]
      const expand = document.querySelector('.sf-rounds-expand')
      return {
        lines: new Set(pills.map((p) => Math.round(p.getBoundingClientRect().top))).size,
        overflows: s.scrollWidth > s.clientWidth + 1,
        expandLabel: expand && getComputedStyle(expand).display !== 'none' ? expand.textContent : null,
        // The active round must be reachable without the reader hunting for it.
        activeInView: (() => {
          const a = document.querySelector('.sf-round-active').getBoundingClientRect()
          const box = s.getBoundingClientRect()
          return a.left >= box.left - 1 && a.right <= box.right + 1
        })(),
      }
    })()`)

    let s = await strip()
    assert.equal(s.lines, 1, 'collapsed pills must occupy exactly one line')
    assert.equal(s.overflows, true, '40 pills at 1200px must overflow, else this test proves nothing')
    assert.equal(s.expandLabel, '[⌄] All 40')
    assert.equal(s.activeInView, true, 'the active pill must be scrolled into view')

    await pg.click('.sf-rounds-expand')
    s = await strip()
    assert.ok(s.lines > 1, 'expanding must wrap the pills across lines')
    assert.equal(s.expandLabel, '[⌃] One line')

    await pg.click('.sf-rounds-expand')
    s = await strip()
    assert.equal(s.lines, 1, 'collapsing must restore the single line')
    await pg.close()
  })

  test('a short board is not offered a collapse it does not need', async () => {
    const SHORT = page('short-rounds.html', '<p>one</p>')
    const k = await open(SHORT, 'short rounds')
    writeFileSync(SHORT, '<p>two</p>')
    await api('POST', `/api/b/${k}/publish`, { note: 'round 2' })

    const pg = await browser.newPage()
    await pg.setViewport({ width: 1200, height: 800 })
    await pg.goto(`${BASE}/b/${k}`, { waitUntil: 'networkidle0' })
    await pg.waitForFunction("document.querySelectorAll('.sf-round-pill').length === 2", { timeout: 15000 })
    const shown = await pg.evaluate(`(() => {
      const e = document.querySelector('.sf-rounds-expand')
      return e ? getComputedStyle(e).display !== 'none' : false
    })()`)
    assert.equal(shown, false, 'two pills fit, so no collapse control belongs on the bar')
    await pg.close()
  })
})

/* Q/W step the viewed revision back/forward, without looping. */
describe('round hotkeys', () => {
  const PAGE = join(DATA_DIR, 'rounds.html')
  let key

  before(async () => {
    writeFileSync(PAGE, '<p>round one body</p>')
    key = await open(PAGE, 'round hotkeys')
    writeFileSync(PAGE, '<p>round two body</p>')
    await api('POST', `/api/b/${key}/publish`, { note: 'round 2' })
    writeFileSync(PAGE, '<p>round three body</p>')
    await api('POST', `/api/b/${key}/publish`, { note: 'round 3' })
  })

  const activePill = `document.querySelector('.sf-round-active')?.textContent ?? null`

  async function pressAndSettle(pg, keyName, expected) {
    await pg.keyboard.press(keyName)
    await pg.waitForFunction(`(${activePill}) === ${JSON.stringify(expected)}`, { timeout: 5000 })
    return pg.evaluate(activePill)
  }

  test('q steps back, w steps forward, neither loops past an end', async () => {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    assert.equal(await pg.evaluate(activePill), 'r3')

    assert.equal(await pressAndSettle(pg, 'q', 'r2'), 'r2')
    assert.equal(await pressAndSettle(pg, 'q', 'r1'), 'r1')
    await pg.keyboard.press('q')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await pg.evaluate(activePill), 'r1', 'q at the first round must not loop')

    assert.equal(await pressAndSettle(pg, 'w', 'r2'), 'r2')
    assert.equal(await pressAndSettle(pg, 'w', 'r3'), 'r3')
    await pg.keyboard.press('w')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await pg.evaluate(activePill), 'r3', 'w at the latest round must not loop')
    await pg.close()
  })

  test('q while typing in the chat field stays typing', async () => {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    await pg.keyboard.press('c')
    await pg.waitForSelector('.sf-chat.sf-open textarea, .sf-chat.sf-open input, .sf-chat.sf-open [contenteditable]', { timeout: 5000 })
    await pg.type('.sf-chat.sf-open textarea, .sf-chat.sf-open input', 'qw')
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await pg.evaluate(activePill), 'r3', 'typed q must not change the round')
    await pg.close()
  })
})

/* The theme toggle: auto follows the OS, an override wins over the OS, and the
   override survives a reload because the shell's inline script applies it. */
describe('theme toggle', () => {
  const PAGE = page('theme.html', '<h1>theme toggle</h1><p>body</p>')
  let key

  before(async () => { key = await open(PAGE, 'theme toggle') })

  async function openPage(osTheme) {
    const pg = await widePage()
    await pg.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: osTheme }])
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    return pg
  }

  const read = (pg) =>
    pg.evaluate(`(() => ({
      theme: document.documentElement.dataset.theme,
      label: document.querySelector('.sf-theme-toggle').textContent,
      stored: localStorage.getItem('sf-theme'),
    }))()`)

  const click = (pg) => pg.click('.sf-theme-toggle')

  test('the full cycle: auto follows the OS, light and dark override it, auto returns', async () => {
    const pg = await openPage('dark')
    assert.deepEqual(await read(pg), { theme: 'dark', label: '[T]heme: auto', stored: null })

    await click(pg) // auto -> light, against a dark OS: the override must win
    assert.deepEqual(await read(pg), { theme: 'light', label: '[T]heme: light', stored: 'light' })

    await click(pg)
    assert.deepEqual(await read(pg), { theme: 'dark', label: '[T]heme: dark', stored: 'dark' })

    await click(pg) // back to auto: storage cleared, OS rules again
    assert.deepEqual(await read(pg), { theme: 'dark', label: '[T]heme: auto', stored: null })
    await pg.close()
  })

  test('an override is applied on a fresh load, before the OS preference', async () => {
    const pg = await openPage('dark')
    await click(pg) // pin light
    await pg.reload({ waitUntil: 'networkidle0' })
    assert.deepEqual(await read(pg), { theme: 'light', label: '[T]heme: light', stored: 'light' })

    // Clean up the profile-wide localStorage for any test that follows.
    await click(pg)
    await click(pg)
    assert.equal((await read(pg)).stored, null)
    await pg.close()
  })

  test('the inline shell script alone applies the override (sessions index has no client.js)', async () => {
    const pg = await browser.newPage()
    await pg.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
    await pg.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await pg.evaluate('localStorage.setItem("sf-theme", "dark")')
    await pg.reload({ waitUntil: 'domcontentloaded' })
    assert.equal(await pg.evaluate('document.documentElement.dataset.theme'), 'dark')
    // The index paints with system colors, so the override must reach color-scheme
    // or the page stays visually light while claiming dark.
    const [r, g, b] = await pg.evaluate(
      'getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number)',
    )
    assert.ok(r + g + b < 240, `index background stayed light under a dark override: rgb(${r},${g},${b})`)
    await pg.evaluate('localStorage.removeItem("sf-theme")')
    await pg.close()
  })

  test('in auto, an OS theme change still lands live', async () => {
    const pg = await openPage('light')
    assert.equal((await read(pg)).theme, 'light')
    await pg.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
    // The change event lands on a later task, so poll rather than read once.
    await pg.waitForFunction('document.documentElement.dataset.theme === "dark"', { timeout: 5000 })
    await pg.close()
  })
})

/* Topbar hotkeys behind the labels, and a chrome that stays pinned. */
describe('topbar', () => {
  const PAGE = page('topbar.html', `<h1>topbar</h1>${'<p>filler paragraph</p>'.repeat(120)}`)
  let key

  before(async () => { key = await open(PAGE, 'topbar') })

  async function openPage() {
    const pg = await browser.newPage()
    await pg.setViewport({ width: 1100, height: 500 })
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    return pg
  }

  test('t cycles the theme and a toggles annotate mode', async () => {
    const pg = await openPage()
    const theme = () => pg.evaluate('document.documentElement.dataset.theme')
    // From auto on a light OS the first press pins light — same paint, new mode —
    // so the visible change lands on the second press.
    await pg.keyboard.press('t')
    assert.equal(await pg.evaluate("localStorage.getItem('sf-theme')"), 'light', 't did not pin a mode')
    await pg.keyboard.press('t')
    assert.equal(await theme(), 'dark', 'second t did not reach dark')

    const annotating = () => pg.evaluate("document.querySelector('.sf-annotate-toggle').classList.contains('sf-on')")
    const wasOn = await annotating()
    await pg.keyboard.press('a')
    assert.equal(await annotating(), !wasOn, 'a did not toggle annotate mode')

    // Reset the profile-wide theme override for any test that follows.
    await pg.evaluate("localStorage.removeItem('sf-theme')")
    await pg.close()
  })

  test('hotkeys stay inert while typing in a form field', async () => {
    const pg = await openPage()
    await pg.keyboard.press('c') // open chat, focus lands in its input
    await pg.waitForSelector('.sf-chat.sf-open')
    await pg.focus('.sf-chat-input')
    const before = await pg.evaluate('document.documentElement.dataset.theme')
    await pg.keyboard.type('t')
    assert.equal(await pg.evaluate('document.documentElement.dataset.theme'), before,
      'typing t in the chat input cycled the theme')
    await pg.evaluate("localStorage.removeItem('sf-theme')")
    await pg.close()
  })

  test('the chrome stays pinned to the viewport top under scroll', async () => {
    const pg = await openPage()
    await pg.evaluate('window.scrollTo(0, document.body.scrollHeight)')
    const got = await pg.evaluate(`(() => {
      const bar = document.querySelector('.sf-topbar').getBoundingClientRect()
      return { top: bar.top, scrolled: window.scrollY > 0 }
    })()`)
    assert.equal(got.scrolled, true, 'the page never scrolled — filler too short to exercise sticky')
    assert.equal(got.top, 0, `topbar drifted off-viewport: rect.top ${got.top}`)
    await pg.close()
  })
})

/* The collapsed chrome: every control the reader keeps lands on one line. */
describe('compact chrome', () => {
  const PAGE = join(DATA_DIR, 'compact.html')
  let key

  before(async () => {
    writeFileSync(PAGE, `<h1>compact</h1>${'<p>filler paragraph</p>'.repeat(120)}`)
    key = await open(PAGE, 'a board title long enough to need the ellipsis it gets')
    writeFileSync(PAGE, `<h1>compact r2</h1>${'<p>filler paragraph</p>'.repeat(120)}`)
    await api('POST', `/api/b/${key}/publish`, { note: 'round 2 — a note long enough to have taken its own line' })
  })

  // One row means every visible control straddles the bar's own midline;
  // heights differ, so comparing tops would flag a centred row as several.
  const rowSpan = `(() => {
    const bar = document.getElementById('sf-chrome').getBoundingClientRect()
    const mid = bar.top + bar.height / 2
    const offRow = [...document.querySelectorAll('#sf-chrome .sf-topbar > *, #sf-chrome .sf-rounds > *')]
      .map((n) => ({ n, r: n.getBoundingClientRect() }))
      // An idle agent slot is a real element with no box — it can sit on no row.
      .filter(({ n, r }) => n.offsetParent !== null && r.width > 0 && r.height > 0)
      .filter(({ r }) => r.top > mid || r.bottom < mid)
      .map(({ n }) => n.className)
    return { offRow, height: bar.height }
  })()`

  async function openNarrow() {
    const pg = await browser.newPage()
    await pg.setViewport({ width: 900, height: 600 })
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    await pg.waitForSelector('.sf-round-pill')
    return pg
  }

  test('a narrow viewport opens collapsed, on one row, and the toggle restores the full bar', async () => {
    const pg = await openNarrow()
    assert.equal(await pg.evaluate("document.getElementById('sf-chrome').classList.contains('sf-compact')"), true,
      'a 900px viewport did not open collapsed')
    const collapsed = await pg.evaluate(rowSpan)
    assert.deepEqual(collapsed.offRow, [], `controls sit off the single row: ${collapsed.offRow}`)
    assert.ok(collapsed.height < 56, `collapsed chrome is ${collapsed.height}px tall`)
    // The pills and the panel launchers are the point of collapsing — they survive it.
    for (const sel of ['.sf-round-pill', '.sf-annotate-toggle', '.sf-queue-toggle', '.sf-chat-toggle']) {
      assert.equal(await pg.evaluate(`document.querySelector('${sel}').offsetParent !== null`), true,
        `${sel} vanished from the collapsed bar`)
    }

    await pg.click('.sf-chrome-toggle')
    const expanded = await pg.evaluate(rowSpan)
    assert.ok(expanded.height > collapsed.height, 'the toggle did not expand the bar')
    assert.equal(await pg.evaluate("document.querySelector('.sf-theme-pick').offsetParent !== null"), true,
      'expanding did not bring back the theme picker')
    assert.equal(await pg.evaluate("localStorage.getItem('sf-chrome-compact')"), '0')

    // The choice, not the viewport, wins on the next load.
    const pg2 = await browser.newPage()
    await pg2.setViewport({ width: 900, height: 600 })
    await pg2.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    assert.equal(await pg2.evaluate("document.getElementById('sf-chrome').classList.contains('sf-compact')"), false,
      'the stored expanded choice did not survive a reload')
    await pg2.evaluate("localStorage.removeItem('sf-chrome-compact')")
    await pg2.close()
    await pg.close()
  })

  test('a wide viewport opens expanded, and a long title truncates rather than wrapping the bar', async () => {
    const pg = await browser.newPage()
    await pg.setViewport({ width: 1600, height: 600 })
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    assert.equal(await pg.evaluate("document.getElementById('sf-chrome').classList.contains('sf-compact')"), false)

    // The title's flex-basis is what keeps this one row: at auto it measures at
    // max-content and the last buttons get a second line the title could pay for.
    const rows = await pg.evaluate(`(() => {
      const kids = [...document.querySelectorAll('.sf-topbar > *')]
        .map((n) => n.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
      return new Set(kids.map((r) => Math.round(r.top + r.height / 2))).size
    })()`)
    assert.equal(rows, 1, `the expanded topbar wrapped to ${rows} rows at 1600px`)
    await pg.close()
  })
})

/* The ⚙ tuner popup. The tests share profile state deliberately —
   the saved edit persisting across pages is the contract. */
describe('tuner and family picker', () => {
  const PAGE = page('tuner.html', '<h1>tuner</h1><p>body text</p>')
  let key

  before(async () => { key = await open(PAGE, 'tuner') })

  test('popup opens via the gear or ?tuner=1; a color edit applies and survives reload', async () => {
    const pg = await widePage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    assert.equal(await pg.$('.sf-tuner.sf-open'), null, 'popup must start closed')
    await pg.click('.sf-tuner-toggle')
    assert.ok(await pg.$('.sf-tuner.sf-open'), 'gear must open the popup')
    await pg.click('.sf-tuner-toggle')
    assert.equal(await pg.$('.sf-tuner.sf-open'), null, 'gear must close it again')

    await pg.goto(`${BASE}/b/${key}?tuner=1`, { waitUntil: 'networkidle0' })
    assert.ok(await pg.$('.sf-tuner.sf-open'), '?tuner=1 must open the popup on load')

    await pg.evaluate(`(() => {
      const input = document.querySelector('.sf-tuner input[type=color]')
      input.value = '#112233'
      input.dispatchEvent(new Event('input'))
    })()`)
    const applied = () => pg.evaluate(`document.documentElement.style.getPropertyValue('--color-base-200')`)
    assert.equal(await applied(), '#112233', 'the edit must land on the html inline style')

    await pg.reload({ waitUntil: 'networkidle0' })
    assert.equal(await applied(), '#112233', 'the edit must persist across reload — with no ?tuner param')
    await pg.close()
  })

  test('save-as-default closes the popup and keeps the edit; reset clears it', async () => {
    const pg = await widePage()
    await pg.goto(`${BASE}/b/${key}?tuner=1`, { waitUntil: 'networkidle0' })
    await pg.click('.sf-tuner-send')
    assert.equal(await pg.$('.sf-tuner.sf-open'), null, 'save must close the popup')
    const applied = () => pg.evaluate(`document.documentElement.style.getPropertyValue('--color-base-200')`)
    assert.equal(await applied(), '#112233', 'saving must keep the override')

    await pg.click('.sf-tuner-toggle')
    await Promise.all([pg.waitForNavigation({ waitUntil: 'networkidle0' }), pg.click('.sf-tuner-reset')])
    assert.equal(await applied(), '', 'reset must clear the override')
    await pg.close()
  })

  test('the picker swaps families before and after reload; T still cycles modes within one', async () => {
    const pg = await widePage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    const theme = () => pg.evaluate(`document.documentElement.dataset.theme`)

    await pg.click('.sf-theme-pick-btn[data-family="lantern"]')
    assert.match(await theme(), /^lantern-(light|dark)$/, 'picking lantern must swap the family')

    await pg.reload({ waitUntil: 'networkidle0' })
    assert.match(await theme(), /^lantern-(light|dark)$/, 'the picked family must survive reload')

    await pg.click('.sf-theme-toggle')
    const t1 = await theme()
    await pg.click('.sf-theme-toggle')
    const t2 = await theme()
    assert.notEqual(t1, t2, 'mode cycle must flip modes')
    assert.match(t1, /^lantern-/, 'mode cycle must stay inside the picked family')
    assert.match(t2, /^lantern-/, 'mode cycle must stay inside the picked family')

    await pg.click('.sf-theme-pick-btn[data-family=""]')
    assert.match(await theme(), /^(light|dark)$/, 'default must drop the family suffix')
    await pg.close()
  })
})

/* A wide <pre> can be read as prose instead of scrolled sideways. */
describe('code wrap toggle', () => {
  const LONG = 'x'.repeat(400)
  const PAGE = join(DATA_DIR, 'wrap.html')
  let key

  before(async () => {
    writeFileSync(PAGE, `<pre><code>${LONG}\nshort last line</code></pre>` +
      `<pre>short</pre><pre class="sd-diff">+${LONG}</pre>`)
    key = await open(PAGE, 'code wrap')
  })

  const fits = (pg) => pg.evaluate(`(() => {
    const n = document.querySelector('#sf-content pre')
    return n.scrollWidth <= n.clientWidth + 1
  })()`)
  const chips = (pg) => pg.evaluate(
    `[...document.querySelectorAll('.sf-wrap-toggle')].map((b) => b.textContent)`)

  // The preference is per-origin, so a tab inherits whatever the last test left.
  const unwrapped = async () => {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    await pg.evaluate("localStorage.removeItem('sf-wrap-code')")
    await pg.reload({ waitUntil: 'networkidle0' })
    return pg
  }

  test('only an overflowing block gets a chip, and it wraps the block', async () => {
    const pg = await unwrapped()

    assert.deepEqual(await chips(pg), ['Wrap'], 'the short pre and the diff must stay clean')
    assert.equal(await fits(pg), false, 'the long pre must overflow before the toggle')

    await pg.click('.sf-wrap-toggle')
    assert.equal(await fits(pg), true, 'wrap on must remove the sideways scroll')
    assert.deepEqual(await chips(pg), ['No wrap'], 'the label names the state a click returns to')

    await pg.click('.sf-wrap-toggle')
    assert.equal(await fits(pg), false, 'the chip must turn wrap back off')
    await pg.close()
  })

  test('the preference survives a re-render, which wipes the chips', async () => {
    const pg = await unwrapped()
    await pg.click('.sf-wrap-toggle')

    // The re-render needs a real edit: an unchanged publish is a no-op round.
    // A plain para keeps the one overflowing pre the only chip on the page.
    writeFileSync(PAGE, `<pre><code>${LONG}\nshort last line</code></pre>` +
      `<pre>short</pre><pre class="sd-diff">+${LONG}</pre><p>round two</p>`)
    await api('POST', `/api/b/${key}/publish`, { note: 'round 2' })
    await pg.waitForFunction("document.querySelectorAll('.sf-round-pill').length === 2", { timeout: 5000 })

    assert.deepEqual(await chips(pg), ['No wrap'], 'the chip must come back reading its stored state')
    assert.equal(await fits(pg), true, 'wrap must still apply after the re-render')
    await pg.close()
  })

  test('one mark per line box that continues below, and none once wrap is off', async () => {
    const pg = await unwrapped()
    const marks = () => pg.evaluate("document.querySelectorAll('.sf-wrap-mark').length")

    assert.equal(await marks(), 0, 'an unwrapped block has no continuations to mark')
    await pg.click('.sf-wrap-toggle')

    // Measured off the rendered height, not off the marks — the chip's own label
    // is a text node inside the pre, and counting it invents a mark on the last line.
    const expected = await pg.evaluate(`(() => {
      const pre = document.querySelector('#sf-content pre')
      const code = pre.querySelector('code')
      const boxes = Math.round(code.getBoundingClientRect().height / parseFloat(getComputedStyle(pre).lineHeight))
      return boxes - code.textContent.split('\\n').length
    })()`)
    assert.ok(expected > 0, 'the fixture must actually wrap')
    assert.equal(await marks(), expected, 'a mark belongs on every line box but each logical line\'s last')

    await pg.click('.sf-wrap-toggle')
    assert.equal(await marks(), 0, 'turning wrap off must clear the marks')
    await pg.close()
  })
})

/* A widget's prompt is prose the reader may disagree with; only the option
   buttons are the vote. */
describe('annotating inside a widget', () => {
  const PAGE = page('widget-annotate.html', '<h1>widget annotate</h1><div data-widget="vote" data-widget-id="w1"><div class="sd-widget-prompt">what should it read from?</div><div class="sd-widget-options"><button type="button" data-option="a">option a</button></div></div>')
  let key

  before(async () => { key = await open(PAGE, 'widget annotate') })

  test('the prompt opens a popover; the option votes instead', async () => {
    const pg = await browser.newPage()
    await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
    if (!(await pg.evaluate("document.querySelector('.sf-annotate-toggle').classList.contains('sf-on')"))) {
      await pg.click('.sf-annotate-toggle')
    }

    await pg.click('#sf-content .sd-widget-prompt')
    const excerpt = await pg.evaluate("document.querySelector('.sf-popover-excerpt')?.textContent")
    assert.match(excerpt || '', /what should it read from/, 'the widget prompt did not open a popover')
    await pg.keyboard.press('Escape')

    await pg.click('#sf-content [data-option]')
    assert.equal(await pg.evaluate("!!document.querySelector('.sf-popover')"), false, 'an option click must vote, not annotate')
    assert.equal(
      await pg.evaluate("document.querySelector('#sf-content [data-widget]').classList.contains('sf-recorded')"),
      true, 'the option click did not record a vote')
    await pg.close()
  })
})
