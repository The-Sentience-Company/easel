import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { annotateAndDiff, contextForSid, excerptForSid } from '../daemon/differ.js'

const sidOf = (html, marker) => html.match(new RegExp(`data-sid="(s-[0-9a-f]+)"[^>]*>${marker}`))?.[1]

test('round 1 assigns data-sid to every block node, diff is null', () => {
  const { html, diff } = annotateAndDiff('<section><h2>T</h2><p>A</p></section>')
  assert.equal(diff, null)
  assert.equal((html.match(/data-sid=/g) || []).length, 3)
})

test('sids are unique even for identical sibling content', () => {
  const { html } = annotateAndDiff('<p>same</p><p>same</p>')
  const sids = [...html.matchAll(/data-sid="([^"]+)"/g)].map((m) => m[1])
  assert.equal(new Set(sids).size, 2)
})

test('unchanged nodes keep their sid across rounds', () => {
  const r1 = annotateAndDiff('<h1>Title</h1><p>Body</p>')
  const r2 = annotateAndDiff('<h1>Title</h1><p>Body</p>', r1.html)
  assert.equal(sidOf(r2.html, 'Title'), sidOf(r1.html, 'Title'))
  assert.deepEqual(r2.diff, { added: [], removed: [], removedDetail: [], modified: [], moved: [] })
})

test('modified node carries its sid forward and is classified modified', () => {
  const r1 = annotateAndDiff('<h1>Title</h1><p>Body</p>')
  const sid = sidOf(r1.html, 'Body')
  const r2 = annotateAndDiff('<h1>Title</h1><p>Body edited</p>', r1.html)
  assert.deepEqual(r2.diff.modified, [sid])
  assert.equal(sidOf(r2.html, 'Body edited'), sid)
})

test('removedDetail carries sid + excerpt for ghost rendering', () => {
  const r1 = annotateAndDiff('<p>keep</p><h2>vanishing heading text</h2>')
  const r2 = annotateAndDiff('<p>keep</p>', r1.html)
  assert.equal(r2.diff.removedDetail.length, 1)
  assert.equal(r2.diff.removedDetail[0].excerpt, 'vanishing heading text')
  assert.equal(r2.diff.removedDetail[0].sid, r2.diff.removed[0])
})

test('removedDetail anchors a removal after its surviving predecessor', () => {
  const r1 = annotateAndDiff('<p>first</p><p>doomed middle</p><p>last</p>')
  const anchor = sidOf(r1.html, 'first')
  const r2 = annotateAndDiff('<p>first</p><p>last</p>', r1.html)
  assert.equal(r2.diff.removedDetail[0].afterSid, anchor)
  assert.equal(r2.diff.removedDetail[0].withinSid, null)
})

test('a removal with nothing surviving before it anchors nowhere', () => {
  const r1 = annotateAndDiff('<p>doomed opener</p><p>keep</p>')
  const r2 = annotateAndDiff('<p>keep</p>', r1.html)
  assert.equal(r2.diff.removedDetail[0].afterSid, null)
  assert.equal(r2.diff.removedDetail[0].withinSid, null)
})

test('a block nested in an earlier sibling never becomes the anchor', () => {
  const r1 = annotateAndDiff('<section><div><p>keep</p></div><p>remove me</p></section>')
  const divSid = r1.html.match(/<div data-sid="([^"]+)"/)[1]
  const r2 = annotateAndDiff('<section><div><p>keep</p></div></section>', r1.html)
  const detail = r2.diff.removedDetail.find((d) => d.excerpt === 'remove me')
  assert.equal(detail.afterSid, divSid, 'anchor must be the sibling div, not the nested p')
})

test('style text is invisible to matching and excerpts', () => {
  const r1 = annotateAndDiff('<p>keep</p><div><style>#my-svg{fill:#333}</style><span>labelled diagram</span></div>')
  const r2 = annotateAndDiff('<p>keep</p>', r1.html)
  const detail = r2.diff.removedDetail.find((d) => d.excerpt.includes('labelled diagram'))
  assert.ok(detail, 'the diagram block must be reported by its visible text')
  assert.doesNotMatch(detail.excerpt, /my-svg|fill/)
})

test('a removal leading its surviving container anchors within it', () => {
  const r1 = annotateAndDiff('<section><p>doomed lead</p><p>kept tail</p></section>')
  const container = r1.html.match(/<section data-sid="([^"]+)"/)[1]
  const r2 = annotateAndDiff('<section><p>kept tail</p></section>', r1.html)
  assert.equal(r2.diff.removedDetail[0].withinSid, container)
  assert.equal(r2.diff.removedDetail[0].afterSid, null)
})

test('added and removed classify correctly', () => {
  const r1 = annotateAndDiff('<p>keep</p><ul><li>gone</li></ul>')
  const removedSid = sidOf(r1.html, 'gone')
  const listSid = r1.html.match(/<ul data-sid="([^"]+)"/)[1]
  const r2 = annotateAndDiff('<p>keep</p><h2>fresh</h2>', r1.html)
  assert.equal(r2.diff.added.length, 1)
  assert.ok(r2.diff.removed.includes(removedSid))
  assert.ok(r2.diff.removed.includes(listSid))
})

test('pure reorder classifies as moved, not modified', () => {
  const r1 = annotateAndDiff('<p>one</p><p>two</p><p>three</p>')
  const r2 = annotateAndDiff('<p>three</p><p>one</p><p>two</p>', r1.html)
  assert.equal(r2.diff.moved.length, 1)
  assert.deepEqual(r2.diff.modified, [])
  assert.deepEqual(r2.diff.added, [])
  assert.deepEqual(r2.diff.removed, [])
})

test('modified is leaf-most: wrapper of an edited paragraph is not flagged', () => {
  const r1 = annotateAndDiff('<section><p>alpha</p><p>beta</p></section>')
  const alphaSid = sidOf(r1.html, 'alpha')
  const r2 = annotateAndDiff('<section><p>alpha edited</p><p>beta</p></section>', r1.html)
  assert.deepEqual(r2.diff.modified, [alphaSid])
})

test('attribute-only change counts as modified', () => {
  const r1 = annotateAndDiff('<p>stable text</p>')
  const sid = sidOf(r1.html, 'stable text')
  const r2 = annotateAndDiff('<p class="highlight">stable text</p>', r1.html)
  assert.deepEqual(r2.diff.modified, [sid])
})

test('remove one paragraph + add an unrelated one reports removed and added, not modified', () => {
  const r1 = annotateAndDiff(
    '<p>intro stays put</p><p>We should raise the retry budget to five attempts for the payment webhook.</p>'
  )
  const removedSid = sidOf(r1.html, 'We should raise')
  const r2 = annotateAndDiff(
    '<p>intro stays put</p><p>Postgres autovacuum should run nightly on the events table.</p>',
    r1.html
  )
  const newSid = sidOf(r2.html, 'Postgres autovacuum')
  assert.deepEqual(r2.diff.removed, [removedSid])
  assert.equal(r2.diff.removedDetail[0].sid, removedSid)
  assert.match(r2.diff.removedDetail[0].excerpt, /retry budget/)
  assert.deepEqual(r2.diff.added, [newSid])
  assert.deepEqual(r2.diff.modified, [])
  assert.notEqual(newSid, removedSid)
  assert.equal(excerptForSid(r2.html, removedSid), null)
})

test('a light edit still pairs: sid carries and classifies modified', () => {
  const r1 = annotateAndDiff('<p>The retry budget should be five attempts for the payment webhook.</p>')
  const sid = sidOf(r1.html, 'The retry budget')
  const r2 = annotateAndDiff('<p>The retry budget should be three attempts for the payment webhook.</p>', r1.html)
  assert.deepEqual(r2.diff.modified, [sid])
  assert.equal(sidOf(r2.html, 'The retry budget'), sid)
})

test('a one-word typo fix keeps its sid via char-level similarity', () => {
  const r1 = annotateAndDiff('<h2>Recieve</h2><p>body</p>')
  const sid = sidOf(r1.html, 'Recieve')
  const r2 = annotateAndDiff('<h2>Receive</h2><p>body</p>', r1.html)
  assert.deepEqual(r2.diff.modified, [sid])
  assert.equal(sidOf(r2.html, 'Receive'), sid)
})

test('a punctuation-only change to a one-word node keeps its sid', () => {
  const r1 = annotateAndDiff('<h2>Hello</h2><p>body</p>')
  const sid = sidOf(r1.html, 'Hello')
  const r2 = annotateAndDiff('<h2>Hello!</h2><p>body</p>', r1.html)
  assert.deepEqual(r2.diff.modified, [sid])
})

test('the strongest similarity claim wins the sid, regardless of document order', () => {
  const r1 = annotateAndDiff('<p>alpha beta gamma delta epsilon</p>')
  const sid = sidOf(r1.html, 'alpha beta gamma')
  const r2 = annotateAndDiff(
    '<p>alpha beta zeta eta theta iota</p><p>alpha beta gamma delta epsilon kappa</p>',
    r1.html
  )
  assert.equal(sidOf(r2.html, 'alpha beta gamma delta epsilon kappa'), sid)
  assert.deepEqual(r2.diff.modified, [sid])
  assert.equal(r2.diff.added.length, 1)
  assert.notEqual(r2.diff.added[0], sid)
})

test('excerptForSid finds node text, clips, and returns null for unknown sid', () => {
  const { html } = annotateAndDiff(`<p>${'x'.repeat(300)}</p>`)
  const sid = html.match(/data-sid="([^"]+)"/)[1]
  assert.equal(excerptForSid(html, sid).length, 200)
  assert.equal(excerptForSid(html, 's-doesnotexist'), null)
})

test('contextForSid: nearest preceding heading and dup ordinal', () => {
  const { html } = annotateAndDiff(
    '<h2>aleks — dump 1</h2><table><thead><tr><th>final page entry</th></tr></thead></table>' +
    '<h2>ben — dump 2</h2><table><thead><tr><th>final page entry</th></tr></thead></table>'
  )
  const sids = [...html.matchAll(/data-sid="([^"]+)"[^>]*>final page entry/g)].map((m) => m[1])
  assert.equal(sids.length, 2)
  assert.deepEqual(contextForSid(html, sids[0]), { heading: 'aleks — dump 1', nth: 1, of: 2 })
  assert.deepEqual(contextForSid(html, sids[1]), { heading: 'ben — dump 2', nth: 2, of: 2 })
})

test('contextForSid: enclosing card title; a heading is not its own context', () => {
  const { html } = annotateAndDiff(
    '<h1>Page</h1><div class="sd-card"><div class="sd-card-title">Fix 1</div><p>body</p></div>'
  )
  const bodySid = html.match(/data-sid="([^"]+)"[^>]*>body/)[1]
  assert.deepEqual(contextForSid(html, bodySid), { heading: 'Page', card: 'Fix 1' })
  const h1Sid = html.match(/data-sid="([^"]+)"[^>]*>Page/)[1]
  assert.equal(contextForSid(html, h1Sid), null)
})

test('contextForSid: unique unheaded node has no context; unknown sid is null', () => {
  const { html } = annotateAndDiff('<p>alone</p>')
  const sid = html.match(/data-sid="([^"]+)"/)[1]
  assert.equal(contextForSid(html, sid), null)
  assert.equal(contextForSid(html, 's-doesnotexist'), null)
})

test('a round-1 annotation sid re-anchors on round 2 after edits around it', () => {
  const r1 = annotateAndDiff('<p>intro</p><p>target paragraph</p><p>outro</p>')
  const sid = sidOf(r1.html, 'target paragraph')
  const r2 = annotateAndDiff('<h1>new heading</h1><p>target paragraph</p>', r1.html)
  assert.equal(excerptForSid(r2.html, sid), 'target paragraph')
})

// A raw NUL byte makes git classify the file binary, so a diff-based review or
// bot silently sees zero lines. The composite diff key uses \0 as its escape.
test('no source file contains a raw NUL byte', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const scan = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) scan(full)
      else if (ent.name.endsWith('.js') || ent.name.endsWith('.md')) {
        assert.ok(!readFileSync(full).includes(0), `NUL byte in ${full}`)
      }
    }
  }
  scan(root)
})

test('protocol-relative //host URLs are dropped; fragments and relative paths kept', () => {
  const { html } = annotateAndDiff('<p>x</p><a href="//evil.com/steal">a</a><a href="/local">b</a><a href="#frag">c</a>')
  assert.ok(!html.includes('//evil.com'), 'protocol-relative URL survived')
  assert.ok(html.includes('href="/local"') && html.includes('href="#frag"'), 'safe URL dropped')
})

test('attacker-supplied data-sid on any element is stripped (module owns sid assignment)', () => {
  const { html } = annotateAndDiff('<p>real</p><span data-sid="s-evil">injected</span>')
  assert.ok(!html.includes('s-evil'), 'injected data-sid survived')
  assert.equal(excerptForSid(html, 's-evil'), null)
})

test('CSS url() fetch vectors are scrubbed from SVG style attrs and <style>, #fragments kept', () => {
  const { html } = annotateAndDiff(
    '<svg style="background:url(/api/steal)"><rect fill="url(#grad)"></rect>' +
      '<style>@import url(//evil);.x{background:url(/api/x)}</style></svg>'
  )
  assert.ok(!html.includes('url(/api/steal)') && !html.includes('url(/api/x)'), 'CSS url() fetch survived')
  assert.ok(!/@import/i.test(html), '@import survived')
  assert.ok(html.includes('url(#grad)'), 'same-document fragment paint was scrubbed')
})

test('a wholly-new subtree reports its outermost container in added, not just leaves', () => {
  const r1 = annotateAndDiff('<p>keep</p>')
  const r2 = annotateAndDiff('<p>keep</p><section><h2>New</h2><p>body</p></section>', r1.html)
  const sectionSid = r2.html.match(/<section data-sid="([^"]+)"/)[1]
  assert.deepEqual(r2.diff.added, [sectionSid])
})

// A node with nothing to see paints at zero height but still accepts
// annotations, so the reviewer gets a badged queue row and no page marker.
describe('a node with nothing visible carries no sid', () => {
  const sidTags = (html) => [...annotateAndDiff(html).html.matchAll(/<(\w+)[^>]*data-sid=/g)].map((m) => m[1])

  test('empty and whitespace-only blocks are skipped', () => {
    for (const body of ['<div></div>', '<div>   </div>', '<div>\n\t </div>', '<p> </p>', '<div><span>  </span></div>']) {
      assert.deepEqual(sidTags(`<p>anchor</p>${body}`), ['p'], `got a sid for: ${body}`)
    }
  })

  test('blocks holding only an embed keep their sid — textless is not invisible', () => {
    for (const body of [
      '<div><img src="/a.png" alt=""></div>',
      '<div><svg viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg></div>',
      '<div><hr></div>',
    ]) {
      assert.deepEqual(sidTags(`<p>anchor</p>${body}`), ['p', 'div'], `lost the sid for: ${body}`)
    }
  })

  test('an ancestor of visible content still gets a sid', () => {
    assert.deepEqual(sidTags('<section><p>real</p></section>'), ['section', 'p'])
  })

  // These carry their own border/background/shadow, so an empty one still
  // occupies the page. Measured in a rendered page, not assumed.
  test('empty blocks the design system still paints keep their sid', () => {
    for (const [body, tag] of [
      ['<div class="sd-card"></div>', 'div'],
      ['<div class="sd-tablewrap"></div>', 'div'],
      ['<div class="sd-metric"></div>', 'div'],
      ['<div class="sd-badge"></div>', 'div'],
      ['<div class="sd-tag"></div>', 'div'],
      ['<div class="sd-flag"></div>', 'div'],
      ['<div class="sd-entry"></div>', 'div'],
      ['<div class="sd-focus"></div>', 'div'],
      ['<blockquote></blockquote>', 'blockquote'],
      ['<pre></pre>', 'pre'],
    ]) {
      assert.deepEqual(sidTags(`<p>anchor</p>${body}`), ['p', tag], `lost the sid for: ${body}`)
    }
  })

  test('a painted class on one of several class names still counts', () => {
    assert.deepEqual(sidTags('<p>anchor</p><div class="sd-col sd-card"></div>'), ['p', 'div'])
  })

  test('layout-only wrappers stay unannotatable when empty', () => {
    // sd-stepper-node is here rather than above because it was measured: an
    // empty node draws no mark and collapses to zero height.
    for (const body of ['<div class="sd-row"></div>', '<div class="sd-col"></div>', '<div class="sd-grid"></div>', '<div class="sd-section"></div>', '<div class="sd-stepper-node"></div>']) {
      assert.deepEqual(sidTags(`<p>anchor</p>${body}`), ['p'], `got a sid for: ${body}`)
    }
  })

  test('a phantom node cannot be annotated at all — excerptForSid finds nothing', () => {
    const { html } = annotateAndDiff('<p>real</p><div class="sd-muted">   </div>')
    assert.doesNotMatch(html, /<div[^>]*data-sid/)
  })

  test('a block emptied between rounds loses its sid rather than going phantom', () => {
    const r1 = annotateAndDiff('<p>anchor</p><div>had content</div>')
    assert.match(r1.html, /<div data-sid/)
    const r2 = annotateAndDiff('<p>anchor</p><div>   </div>', r1.html)
    assert.doesNotMatch(r2.html, /<div[^>]*data-sid/)
  })
})

describe('table cells', () => {
  const TABLE = '<table><thead><tr><th>case</th><th>status</th></tr></thead><tbody><tr><td>a</td><td>ok</td></tr></tbody></table>'

  test('header and body cells each get a sid — row × column select', () => {
    const { html } = annotateAndDiff(TABLE)
    assert.match(html, /<th data-sid=/)
    assert.match(html, /<td data-sid=/)
  })

  test('an empty body cell still paints, so it keeps a sid', () => {
    const { html } = annotateAndDiff('<table><tbody><tr><td>a</td><td> </td></tr></tbody></table>')
    assert.equal((html.match(/<td data-sid=/g) || []).length, 2)
  })

  test('a cell edit classifies to the cell, not the whole row', () => {
    const CASES = '<table><tbody><tr><td>alpha case</td><td>score 0.12</td></tr></tbody></table>'
    const r1 = annotateAndDiff(CASES)
    const r2 = annotateAndDiff(CASES.replace('score 0.12', 'score 0.50'), r1.html)
    assert.equal(r2.diff.modified.length, 1)
    assert.match(r2.html, new RegExp(`<td data-sid="${r2.diff.modified[0]}">score 0.50`))
  })

  test('a round baked before cell anchors upgrades with a clean diff', () => {
    const r1 = annotateAndDiff(TABLE)
    const stripped = r1.html.replace(/<(th|td) data-sid="[^"]*"/g, '<$1')
    const r2 = annotateAndDiff(TABLE, stripped)
    assert.deepEqual(r2.diff, { added: [], removed: [], removedDetail: [], modified: [], moved: [] })
  })
})

describe('diagrams diff as one unit', () => {
  // The baked shape: theme-variant spans, each an svg whose labels are
  // foreignObject divs — block tags, but internal to the diagram.
  const themed = (labels) =>
    '<div class="sd-diagram sd-diagram-themed">' +
    ['sd-svg-light', 'sd-svg-dark'].map((v) =>
      `<span class="${v}"><svg><foreignObject>` +
      labels.map((l) => `<div><span>${l}</span></div>`).join('') +
      '</foreignObject></svg></span>').join('') +
    '</div>'
  const sketch = '<div class="sd-diagram sd-diagram-sketch"><span class="sd-svg-light"><svg><path d="M0 0"/></svg></span><span class="sd-svg-dark"><svg><path d="M0 0"/></svg></span></div>'

  test('no block inside a diagram gets a sid', () => {
    const { html } = annotateAndDiff(`<p>anchor</p>${themed(['no flags', 'flagged pairs'])}`)
    const inner = html.slice(html.indexOf('<svg'))
    assert.doesNotMatch(inner, /data-sid/, 'a diagram-internal node took a sid')
  })

  test('a replaced diagram ghosts once as (diagram), never as its labels', () => {
    const r1 = annotateAndDiff(`<p>anchor</p>${themed(['no flags', 'flagged pairs', 'invalid output'])}`)
    const r2 = annotateAndDiff(`<p>anchor</p>${sketch}`, r1.html)
    assert.equal(r2.diff.removedDetail.length, 1)
    assert.equal(r2.diff.removedDetail[0].excerpt, '(diagram)')
  })

  test('an unchanged diagram diffs clean across rounds', () => {
    const page = `<p>anchor</p>${themed(['stable label'])}`
    const r1 = annotateAndDiff(page)
    const r2 = annotateAndDiff(page, r1.html)
    assert.deepEqual(r2.diff, { added: [], removed: [], removedDetail: [], modified: [], moved: [] })
  })
})
