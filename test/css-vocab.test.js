/* Every chrome class client.js applies must have a rule in easel.css.
   A documented-but-unstyled class ships as invisible or unstyled markup. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(HERE, '..', 'chrome', 'easel.css'), 'utf8')

// From the "Chrome DOM vocabulary" section of docs/api.md.
const CHROME_CLASSES = [
  'sf-queue', 'sf-queue-header', 'sf-chat', 'sf-chat-header', 'sf-chat-log',
  'sf-chat-msg', 'sf-chat-form', 'sf-chat-input', 'sf-open',
  'sf-diff-added', 'sf-diff-modified', 'sf-diff-moved', 'sf-diff-removed',
  'sf-ghost-item', 'sf-removed-toggle', 'sf-show-removed',
  'sf-wb-open', 'sf-wb-overlay', 'sf-wb-frame', 'sf-wb-error', 'sf-diagram-look',
  'sf-gate', 'sf-gate-card', 'sf-gate-title', 'sf-gate-copy', 'sf-gate-show',
  'sf-gate-banner', 'sf-gated', 'sf-end-session', 'sf-gate-stalled',
  'sf-theme-toggle', 'sf-width', 'sf-width-slider', 'sf-width-keys',
  'sf-theme-pick', 'sf-theme-pick-btn', 'sf-tuner-toggle',
  'sf-tuner', 'sf-tuner-title', 'sf-tuner-row', 'sf-tuner-color',
  'sf-tuner-select', 'sf-tuner-range', 'sf-tuner-actions', 'sf-tuner-send', 'sf-tuner-reset',
]

describe('easel.css covers the chrome vocabulary', () => {
  test('every chrome class has a rule', () => {
    const missing = CHROME_CLASSES.filter((cls) => !new RegExp(`\\.${cls}\\b`).test(css))
    assert.deepEqual(missing, [], `no rule for: ${missing.join(', ')}`)
  })
})

// The [hidden] override is proven by computed style in css.test.js, which
// arrives with 4911bf1 at the rebase — not duplicated statically here.
describe('markdown table alignment', () => {
  // A rule that merely exists is not enough — `.sd-tablewrap th` already sets
  // text-align, so the alignment classes have to out-specify it.
  for (const [cls, expected] of [['sd-align-left', 'left'], ['sd-align-center', 'center'], ['sd-align-right', 'right']]) {
    test(`.${cls} actually aligns ${expected}`, { timeout: 60000 }, async () => {
      const puppeteer = (await import('puppeteer')).default
      const browser = await puppeteer.launch({ headless: 'new' })
      const page = await browser.newPage()
      await page.setContent(
        `<!doctype html><html data-theme="light"><head><style>${css}</style></head>` +
        '<body class="sf-shell"><main id="sf-content"><div class="sd-tablewrap"><table>' +
        `<thead><tr><th class="${cls}" id="h">head</th></tr></thead>` +
        `<tbody><tr><td class="${cls}" id="d">cell</td></tr></tbody></table></div></main></body></html>`,
        { waitUntil: 'domcontentloaded' },
      )
      const got = await page.evaluate(`(() => ({
        th: getComputedStyle(document.getElementById('h')).textAlign,
        td: getComputedStyle(document.getElementById('d')).textAlign,
      }))()`)
      await browser.close()
      assert.equal(got.th, expected, `th kept ${got.th}`)
      assert.equal(got.td, expected, `td kept ${got.td}`)
    })
  }
})

describe('easel.css invariants', () => {
  test('themes key off data-theme on html, never a wrapper', () => {
    assert.match(css, /html\[data-theme="dark"\]/)
    assert.match(css, /html\[data-theme="light"\]/)
    assert.doesNotMatch(css, /^\s*div\[data-theme/m)
  })
})
