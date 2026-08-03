#!/usr/bin/env node
/* Dev-only: screenshot the generated previews at the review widths.
   node test/shoot.js <outDir> */

import puppeteer from 'puppeteer'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WIDTHS = [800, 1400]
const TEMPLATES = ['review', 'eval', 'answer-key', 'page']
const THEMES = ['light', 'dark']

const outDir = resolve(process.argv[2] || join(HERE, 'shots'))
await mkdir(outDir, { recursive: true })

const browser = await puppeteer.launch({ headless: 'new' })
const results = []

for (const t of TEMPLATES) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const page = await browser.newPage()
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 2 })
      const src = join(HERE, 'out', `${t}-${theme}.html`)
      await page.goto(`file://${src}`, { waitUntil: 'networkidle0' })

      // Open every collapse so nothing is measured while hidden.
      await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true }))

      const overflow = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }))

      // Chrome panels are position:fixed; a fullPage shot would park them
      // mid-document over the content, so those are captured viewport-only.
      const hasChrome = await page.evaluate(() => !!document.getElementById('sf-chrome'))
      const file = join(outDir, `${t}-${theme}-${width}.png`)
      await page.screenshot({ path: file, fullPage: !hasChrome })
      results.push({ t, theme, width, ...overflow, horizontalOverflow: overflow.scrollW > overflow.clientW })
      await page.close()
    }
  }
}

await browser.close()

for (const r of results) {
  const flag = r.horizontalOverflow ? `OVERFLOW scrollW=${r.scrollW} clientW=${r.clientW}` : 'no-overflow'
  console.log(`${r.t}-${r.theme}-${r.width}  ${flag}`)
}
const bad = results.filter((r) => r.horizontalOverflow)
console.log(`\n${results.length} shots, ${bad.length} with horizontal overflow`)
process.exit(bad.length ? 1 : 0)
