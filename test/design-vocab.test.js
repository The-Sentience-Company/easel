/* Every sd-* class a template emits must have a rule in easel.css. Without
   this a template rename ships as unstyled markup and no test goes red. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CSS_PATH = join(HERE, '..', 'chrome', 'easel.css')
const TEMPLATE_DIR = join(HERE, '..', 'templates')
const css = readFileSync(CSS_PATH, 'utf8')

export function emittedDesignClasses(dir = TEMPLATE_DIR) {
  const found = new Map()
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(dir, file), 'utf8')
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      // Interpolations are conditional modifiers; the literal tokens around
      // them are what always ships, so only those can be asserted statically.
      for (const token of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
        if (token.startsWith('sd-')) {
          if (!found.has(token)) found.set(token, new Set())
          found.get(token).add(file)
        }
      }
    }
  }
  return found
}

const emitted = emittedDesignClasses()

describe('easel.css covers every sd-* class the templates emit', () => {
  test('the scan finds a non-trivial vocabulary', () => {
    // Guards the observation path: a broken regex would report zero classes
    // and every case below would pass by finding nothing to check.
    assert.ok(emitted.size >= 20, `scan found only ${emitted.size} sd-* classes`)
    assert.ok(emitted.has('sd-card'), 'scan missed sd-card, which templates certainly emit')
  })

  test('every emitted sd-* class has a rule', () => {
    const missing = [...emitted]
      .filter(([cls]) => !new RegExp(`\\.${cls}\\b`).test(css))
      .map(([cls, files]) => `${cls} (emitted by ${[...files].join(', ')})`)
    assert.deepEqual(missing, [], `no rule for: ${missing.join('; ')}`)
  })
})

describe('the two design-system additions templates rely on', () => {
  test('the eyebrow and its strict variant are both styled', () => {
    assert.match(css, /\.sd-eyebrow\b/)
    assert.match(css, /\.sd-eyebrow-strict\b/)
  })

  test('the stepper ships every state, not just the default node', () => {
    for (const cls of ['sd-stepper', 'sd-stepper-node', 'sd-stepper-mark', 'sd-stepper-done', 'sd-stepper-error', 'sd-stepper-current']) {
      assert.match(css, new RegExp(`\\.${cls}\\b`), `no rule for .${cls}`)
    }
  })
})
