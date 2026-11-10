// A config.json theme is what a fresh browser gets; the picker still overrides it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-default-theme-'))
const api = makeApi(BASE)
let daemon
let browser
let key

before(async () => {
  writeFileSync(join(DATA_DIR, 'config.json'), JSON.stringify({ theme: { family: 'cursor', mode: 'dark' } }))
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
  browser = await (await import('puppeteer')).default.launch({ headless: 'new' })
  const file = join(DATA_DIR, 'doc.html')
  writeFileSync(file, '<h1>Theme</h1><p>body</p>')
  key = (await api('POST', '/api/open', { file, title: 'theme' })).data.key
})

after(async () => {
  await browser?.close()
  daemon?.kill()
})

test('a fresh browser gets the configured theme; picking Default sticks across reload', async () => {
  const pg = await browser.newPage()
  await pg.setViewport({ width: 1600, height: 700 })
  await pg.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }])
  await pg.goto(`${BASE}/b/${key}`, { waitUntil: 'networkidle0' })
  const theme = () => pg.evaluate(`document.documentElement.dataset.theme`)
  assert.equal(await theme(), 'cursor-dark', 'the configured family and mode must apply with nothing stored')

  await pg.click('.sf-theme-pick-btn[data-family=""]')
  assert.equal(await theme(), 'dark', 'picking Default must drop the family')
  await pg.reload({ waitUntil: 'networkidle0' })
  assert.equal(await theme(), 'dark', 'an explicit Default pick must not fall back to the configured family')
  await pg.close()
})
