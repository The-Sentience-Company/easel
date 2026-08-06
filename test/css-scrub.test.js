// The CSS scrubber's bars: every funciri-bearing SVG attribute is covered, a
// value that cannot be parsed fails closed, and real diagram CSS is untouched.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { annotateAndDiff } from '../daemon/differ.js'

const stored = (html) => annotateAndDiff(html).html
const LEAK = 'http://127.0.0.1:9911'

const inStyleEl = (decl) => `<svg width="1" height="1"><style>.q { ${decl} }</style></svg>`

describe('a quoted paren no longer smuggles a url past the scrubber', () => {
  for (const [label, decl] of [
    ['double-quoted )', `background-image: url("${LEAK}/a)b");`],
    ['single-quoted )', `background-image: url('${LEAK}/c)d');`],
    ['mismatched quotes', `background-image: url("${LEAK}/e');`],
  ]) {
    test(label, () => {
      assert.ok(!stored(inStyleEl(decl)).includes('127.0.0.1:9911'), `${label} survived storage`)
    })
  }
})

describe('every funciri-bearing presentation attribute is covered', () => {
  for (const attr of ['fill', 'stroke', 'filter', 'clip-path', 'mask', 'style']) {
    test(attr, () => {
      const value = attr === 'style' ? `fill:url("${LEAK}/x)y")` : `url("${LEAK}/x)y")`
      const html = `<svg width="1" height="1"><rect ${attr}='${value}'></rect></svg>`
      assert.ok(!stored(html).includes('127.0.0.1:9911'), `${attr} leaked`)
    })
  }
})

describe('fetch functions beyond url() are neutralised', () => {
  test('image-set in an in-SVG style element', () => {
    assert.ok(!stored(inStyleEl(`background-image: image-set("${LEAK}/h" 1x);`)).includes('9911'))
  })
  test('image-set in a style attribute — the old gate never even looked', () => {
    const html = `<svg width="1" height="1"><rect style='background-image: image-set("${LEAK}/i" 1x)'></rect></svg>`
    assert.ok(!stored(html).includes('9911'))
  })
  // The bar that separates a real fix from adding image-set to a list.
  test('an unrecognised function carrying a string fails closed', () => {
    assert.ok(!stored(inStyleEl(`background-image: cross-fade("${LEAK}/j" 50%);`)).includes('9911'))
  })
})

// Removing a span must not weld its neighbours into a token that was never
// written — the scrubber manufacturing a live url() is worse than missing one.
describe('a removed span cannot fuse the tokens around it', () => {
  for (const [label, value] of [
    ['a comment between u and rl', `u/**/rl(${LEAK}/synth)`],
    ['an @import between u and rl', `u@import x;rl(${LEAK}/synth)`],
    // Discriminates the separator itself: a relative target carries no string,
    // no url( and no //, so no function-level check can see the fused result.
    ['a fused same-origin fetch', 'u/**/rl(/stealme)'],
  ]) {
    test(label, () => {
      const out = stored(`<svg width="1" height="1"><rect fill='${value}'></rect></svg>`)
      assert.ok(!/\burl\(\s*[^#)]/.test(out), 'the scrubber synthesised a fetching url()')
      assert.ok(!out.includes('9911'))
    })
  }
})

// A CSS escape is invisible to a scanner but not to the browser's tokenizer,
// so `\75 rl(...)` would reach the page as a live url() the scan never saw.
describe('css escapes cannot reconstitute a url past the name check', () => {
  for (const [label, value] of [
    ['escaped ident rebuilding url(', '\\75 rl(\\2f\\2f evil.example/x)'],
    ['escaped protocol-relative target', 'url(\\2f\\2f evil.example/y)'],
    ['escape inside an unknown function', 'fn(\\2f\\2f evil.example/z)'],
  ]) {
    test(label, () => {
      const out = stored(`<svg width="1" height="1"><rect fill='${value}'></rect></svg>`)
      assert.ok(!out.includes('evil.example'), 'an escaped target survived storage')
    })
  }
})

// Scrubbing ran over every attribute, so a value that merely looked like CSS
// was rewritten or dropped. Only fetch-capable attributes are parsed now.
describe('attributes that cannot fetch are left alone', () => {
  test('an href keeping parens and slashes is untouched', () => {
    const html = '<svg width="1" height="1"><a href="https://example.com/?q=fn(a//b)"></a></svg>'
    assert.match(stored(html), /href="https:\/\/example\.com\/\?q=fn\(a\/\/b\)"/)
  })
  test('an unbalanced paren in a non-CSS attribute does not drop it', () => {
    const html = '<svg width="1" height="1"><a href="https://example.com/?q=word("></a></svg>'
    assert.ok(stored(html).includes('example.com'), 'the attribute was dropped')
  })
  test('aria and class survive a value shaped like a function', () => {
    const html = '<svg width="1" height="1"><rect aria-label="calc(a" class="x(y"></rect></svg>'
    const out = stored(html)
    assert.ok(out.includes('aria-label') && out.includes('class'), 'a harmless attribute was dropped')
  })
})

describe('what real diagrams emit still survives', () => {
  test('same-document fragment refs are untouched', () => {
    assert.match(stored('<svg width="1" height="1"><rect fill="url(#grad)"></rect></svg>'), /url\(#grad\)/)
  })
  test('the embedded woff2 face is untouched', () => {
    const face = `@font-face { font-family: Excalifont; src: url(data:font/woff2;base64,${'A'.repeat(80)}); }`
    assert.match(stored(`<svg width="1" height="1"><style>${face}</style></svg>`), /data:font\/woff2;base64,A{80}/)
  })
  test('a plain external url still becomes none', () => {
    assert.match(stored(`<svg width="1" height="1"><rect fill="url(${LEAK}/x)"></rect></svg>`), /fill="none"/)
  })
  test('@import is dropped', () => {
    assert.ok(!stored(inStyleEl(`x: y; } @import url("${LEAK}/k");`)).includes('9911'))
  })
})

// The scrubber now runs over EVERY svg attribute, so a scanner bug would
// silently corrupt geometry rather than merely miss a leak.
describe('scrubbing is a no-op on ordinary diagram markup', () => {
  const svg =
    '<svg width="10" height="10" viewBox="0 0 10 10" role="graphics-document" aria-roledescription="flowchart">' +
    '<g transform="translate(4.5, 2) rotate(45)"><path d="M0,0 L10,10 C1,2 3,4 5,6"></path>' +
    '<text font-family="Excalifont, \'Segoe UI\', sans-serif" aria-label="it\'s fine">x</text>' +
    '<rect fill="url(#g)" stroke="rgb(1, 2, 3)" style="opacity: calc(1 - 0.5)"></rect></g></svg>'

  test('geometry, transforms and apostrophes come through unchanged', () => {
    const out = stored(svg)
    for (const fragment of [
      'd="M0,0 L10,10 C1,2 3,4 5,6"',
      'transform="translate(4.5, 2) rotate(45)"',
      'viewBox="0 0 10 10"',
      'stroke="rgb(1, 2, 3)"',
      'calc(1 - 0.5)',
      'url(#g)',
    ]) {
      assert.ok(out.includes(fragment), `scrubber altered ${fragment}`)
    }
    assert.match(out, /aria-label="it['&]/, 'an apostrophe dropped the attribute')
  })
})
