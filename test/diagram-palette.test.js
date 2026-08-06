/* The skeleton fixups both the converter and the whiteboard frame apply. */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeSkeleton } from '../render/diagram-palette.js'

test('an unstyled diagram gets filled shapes, and only shapes', () => {
  const out = normalizeSkeleton([
    { type: 'rectangle' },
    { type: 'diamond' },
    { type: 'ellipse' },
    { type: 'arrow' },
    { type: 'line' },
  ])
  assert.ok(out[0].backgroundColor, 'a node must not stay colourless')
  assert.notEqual(out[1].backgroundColor, out[0].backgroundColor, 'a decision reads apart from a node')
  assert.equal(out[2].backgroundColor, out[0].backgroundColor)
  assert.equal(out[3].backgroundColor, undefined, 'connectors keep the default stroke')
  assert.equal(out[4].backgroundColor, undefined)
})

test('a diagram that declared any colour is left entirely alone', () => {
  const out = normalizeSkeleton([{ type: 'rectangle', backgroundColor: '#fdd' }, { type: 'rectangle' }])
  assert.equal(out[0].backgroundColor, '#fdd')
  assert.equal(out[1].backgroundColor, undefined, 'half-painting invents a meaning the author did not write')
})

test('a <br/> label becomes a real line break', () => {
  const out = normalizeSkeleton([{ type: 'text', text: 'first<br/>second' }, { type: 'rectangle', label: { text: 'a<BR>b' } }])
  assert.equal(out[0].text, 'first\nsecond')
  assert.equal(out[1].label.text, 'a\nb')
})
