#!/usr/bin/env node
/* Dev-only: viewport shots of the chrome fixture (fixed panels in place).
   node test/shoot-chrome.js <outDir> */

import puppeteer from 'puppeteer'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(process.argv[2] || join(HERE, 'shots'))
await mkdir(outDir, { recursive: true })

const browser = await puppeteer.launch({ headless: 'new' })

for (const theme of ['light', 'dark']) {
  for (const width of [800, 1400]) {
    const page = await browser.newPage()
    await page.setViewport({ width, height: 900, deviceScaleFactor: 2 })
    await page.goto(`file://${join(HERE, 'out', `chrome-review-${theme}.html`)}`, { waitUntil: 'networkidle0' })
    await page.screenshot({ path: join(outDir, `chrome-${theme}-${width}.png`) })
    console.log(`chrome-${theme}-${width}`)
    await page.close()
  }
}

await browser.close()
