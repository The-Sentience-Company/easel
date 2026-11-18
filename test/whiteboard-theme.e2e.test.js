// The frame's own chrome must follow the EASEL theme. It used to key off
// prefers-color-scheme, so an OS that disagreed with the easel won.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-wbtheme-'))
const PAGE = join(DATA_DIR, 'page.html')
const SLOW = { timeout: 180000 }

const api = makeApi(BASE)
let daemon
let key

const CONTRAST = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgb = (v) => { cx.clearRect(0,0,1,1); cx.fillStyle='#000'; cx.fillStyle=v; cx.fillRect(0,0,1,1);
    const d = cx.getImageData(0,0,1,1).data; return [d[0],d[1],d[2]]; };
  const lum = (c) => { const f = c.map((v)=>{const s=v/255; return s<=0.03928?s/12.92:((s+0.055)/1.055)**2.4;});
    return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2]; };
  // A banner only exists while loading/blank/stale/ended, so the element is
  // constructed rather than raced. The CSS and the theme on it are the real ones.
  let el = document.querySelector('.wb-banner');
  let made = null;
  if (!el) {
    made = document.createElement('div');
    made.className = 'wb-banner wb-ended';
    made.textContent = 'measurement';
    document.body.appendChild(made);
    el = made;
  }
  const s = getComputedStyle(el);
  const root = getComputedStyle(document.documentElement);
  const bg = rgb(s.backgroundColor);
  const fg = rgb(s.color);
  const ratio = (a,b) => { const x=lum(a), y=lum(b);
    return Math.round(((Math.max(x,y)+0.05)/(Math.min(x,y)+0.05))*100)/100; };
  if (made) made.remove();
  return {
    dataTheme: document.documentElement.getAttribute('data-theme'),
    colorScheme: root.colorScheme,
    bannerBg: bg, bannerFg: fg,
    contrast: bg && fg ? ratio(fg, bg) : null,
  };
})()`

before(async () => {
  writeFileSync(PAGE, '<p>intro</p><pre class="mermaid">graph TD\n  A[a] --> B[b]</pre>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  const opened = await api('POST', '/api/open', { file: PAGE, title: 'whiteboard theme' })
  key = opened.data.key
})
after(async () => { if (daemon) daemon.kill() })

async function frameStateForTheme(theme) {
  const puppeteer = (await import('puppeteer')).default
  // Forced OS light: if the frame still followed prefers-color-scheme, the dark
  // case could not pass, so this is what makes the assertion discriminating.
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--force-color-profile=srgb'] })
  try {
    const page = await browser.newPage()
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
    await page.setViewport({ width: 1400, height: 900 })
    await page.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await page.waitForSelector('.sf-wb-open', { timeout: 30000 })
    await page.evaluate(() => document.querySelector('.sf-wb-open').click())
    const frame = await page.waitForFrame((f) => f.url().includes('/whiteboard-frame'), { timeout: 30000 })
    await frame.waitForSelector('.wb-root', { timeout: 60000 })
    await new Promise((r) => setTimeout(r, 1500))
    return await frame.evaluate(CONTRAST)
  } finally {
    await browser.close()
  }
}

test('the frame adopts the easel theme, not the OS scheme', SLOW, async () => {
  const dark = await frameStateForTheme('dark')
  assert.equal(dark.dataTheme, 'dark', 'the easel theme never reached the frame root')
  assert.equal(dark.colorScheme, 'dark', 'color-scheme did not follow, so Canvas/CanvasText stay light')

  const light = await frameStateForTheme('light')
  assert.equal(light.dataTheme, 'light')
  assert.equal(light.colorScheme, 'light')
})

test('the frame banner is warm in dark and clears AA', SLOW, async () => {
  const dark = await frameStateForTheme('dark')
  assert.ok(dark.bannerBg, 'no banner rendered, so nothing was measured')
  const [r, g, b] = dark.bannerBg
  // The old value was #23293a — blue-dominant. Warm means red leads blue.
  assert.ok(r > b, `frame banner still reads cool: rgb(${dark.bannerBg})`)
  assert.ok(dark.contrast >= 4.5, `frame banner contrast ${dark.contrast} is below AA`)
})

test('the frame banner clears AA in light too', SLOW, async () => {
  const light = await frameStateForTheme('light')
  assert.ok(light.bannerBg, 'no banner rendered, so nothing was measured')
  assert.ok(light.bannerBg[0] >= light.bannerBg[2], `light banner reads cool: rgb(${light.bannerBg})`)
  assert.ok(light.contrast >= 4.5, `frame banner contrast ${light.contrast} is below AA`)
})
