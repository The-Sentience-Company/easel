/* Unit guards for render/diff.js — the per-line expansion, the bounded
   word-level pairing, and which <pre> blocks the transform is allowed to claim. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderDiffBody, preRender } from '../render/diff.js'
import { markdown } from '../templates/_html.js'

const body = (...lines) => renderDiffBody(lines.join('\n'))
const kinds = (html) => [...html.matchAll(/sd-diff-line sd-diff-(\w+)/g)].map((m) => m[1])
const texts = (html) => [...html.matchAll(/<span class="sd-diff-text">(.*?)<\/span>/g)].map((m) => m[1])

describe('a diff line is classified by its marker', () => {
  test('file headers are meta, not an added or removed line', () => {
    // --- and +++ both start with a diff marker character; order of the tests
    // in classify() is the only thing keeping them out of del/add.
    assert.deepEqual(kinds(body('--- a/x', '+++ b/x')), ['meta', 'meta'])
  })

  test('git preamble lines are meta', () => {
    assert.deepEqual(
      kinds(body('diff --git a/x b/x', 'index 1234..5678 100644', 'new file mode 100644')),
      ['meta', 'meta', 'meta'],
    )
  })

  test('hunk headers, additions, removals and context', () => {
    assert.deepEqual(kinds(body('@@ -1 +1 @@', '+added', '-removed', ' context', 'bare')),
      ['hunk', 'add', 'del', 'ctx', 'ctx'])
  })

  test('the marker is split off the text, so the text reads without it', () => {
    assert.deepEqual(texts(body('+added', '-removed', ' context')), ['added', 'removed', 'context'])
  })

  test('a trailing newline does not become a blank final line', () => {
    assert.equal(kinds(renderDiffBody('+one\n')).length, 1)
  })

  test('every line carries its ordinal, so an anchor survives a re-render', () => {
    const html = body('+a', '-b', ' c')
    assert.deepEqual([...html.matchAll(/data-diff-line="(\d+)"/g)].map((m) => m[1]), ['0', '1', '2'])
  })
})

describe('word-level emphasis stays inside an unambiguous pair', () => {
  const marks = (html) => [...html.matchAll(/<mark class="sd-diff-word">(.*?)<\/mark>/g)].map((m) => m[1])

  test('a lone -/+ pair marks only the words that changed', () => {
    const html = body(' ctx', '-the quick brown fox', '+the quick red fox')
    assert.deepEqual(marks(html), ['brown', 'red'])
  })

  test('equal runs of removals and additions pair by position', () => {
    // The shape an edited list makes: line 1 answers line 1, line 2 line 2.
    const html = body('-run one', '-run two', '+run three', '+run four')
    assert.deepEqual(marks(html), ['one', 'two', 'three', 'four'])
    assert.deepEqual(kinds(html), ['del', 'del', 'add', 'add'])
  })

  test('unequal runs get no word marks', () => {
    // Three out, two in: there is no correspondence to read, so the tint alone.
    const html = body('-a one', '-b two', '-c three', '+d four', '+e five')
    assert.deepEqual(marks(html), [])
    assert.deepEqual(kinds(html), ['del', 'del', 'del', 'add', 'add'])
  })

  test('a rewritten line marks whole rather than shredding into confetti', () => {
    // LCS finds the incidental shared words; past a few runs that reads as noise.
    const html = body(
      '-note. A rule Sam stated reads firm; an inferred pattern reads as a general preference.',
      '+note. The VERB carries it: a rule Sam stated uses a firm imperative; an inferred pattern uses a preference verb.',
    )
    assert.equal(marks(html).length, 2, 'one solid span a side')
  })

  test('one removal followed by several adds marks against the first add only', () => {
    // The amended-line-plus-new-line shape: the true delta is inside the first add.
    const html = body('-one two four', '+one two three four', '+a wholly new line')
    assert.deepEqual(marks(html), ['three'])
  })

  test('alternating single-line replacements each get their own marks', () => {
    const html = body('-a x c', '+a y c', '-p q one', '+p q two')
    assert.deepEqual(marks(html), ['x', 'y', 'one', 'two'])
  })

  test('a pair sharing no edge words is left to the line tint', () => {
    assert.deepEqual(marks(body('-alpha beta', '+gamma delta')), [])
  })

  test('a pair that only appends marks the appended tail', () => {
    assert.deepEqual(marks(body('-one two', '+one two three')), ['three'])
  })

  // "words." and "words" are one token each, so a sentence extended past its full
  // stop shares no trailing token and the mark slides left onto unchanged text.
  test('a sentence extended past its punctuation marks only what was added', () => {
    assert.deepEqual(marks(body('-this is words', '+this is words. more words')), ['. more words'])
  })

  test('punctuation added to an unchanged line is the only thing marked', () => {
    assert.deepEqual(marks(body('-it works', '+it works!')), ['!'])
  })

  test('a word inside punctuation is marked without its delimiters', () => {
    assert.deepEqual(marks(body('-see docs/api.md', '+see docs/usage.md')), ['api', 'usage'])
  })

  test('two edits on one line mark two spans, not the unchanged text between', () => {
    // A common prefix and suffix alone cannot see the island in the middle.
    assert.deepEqual(marks(body('-the quick brown fox jumps', '+the slow brown fox leaps')),
      ['quick', 'jumps', 'slow', 'leaps'])
  })

  test('changed values scattered through a line are each marked alone', () => {
    assert.deepEqual(marks(body('-timeout 30 retries 3', '+timeout 60 retries 5')),
      ['30', '3', '60', '5'])
  })

  test('adjacent changed words join through the space between them', () => {
    assert.deepEqual(marks(body('-run the old task', '+run a new task')), ['the old', 'a new'])
  })

  test('a line too long to align falls back to marking the whole middle', () => {
    // The LCS table is capped; past it the mark is the coarse span it always was.
    const long = (w) => Array.from({ length: 1200 }, (_, i) => (i === 600 ? w : `t${i}`)).join(' ')
    // Aligned it would be four marks: the swap and the tail word, per side.
    assert.equal(marks(body(`-${long('x')} end`, `+${long('y')} tail`)).length, 2)
  })

  test('an added line following a context line is not paired backwards', () => {
    assert.deepEqual(marks(body(' ctx', '+added alone')), [])
  })

  test('escaped markup is not split mid-entity', () => {
    // The brackets are shared, so only the tag name is marked — but a mark
    // boundary inside &lt; would emit a stray & or ; against a tag.
    const html = body('-a &lt;div&gt; b', '+a &lt;span&gt; b')
    assert.deepEqual(marks(html), ['div', 'span'])
    assert.doesNotMatch(html, /&[a-zA-Z#][^;<>\s]*<|>[a-zA-Z0-9]*;/, 'no entity may be split by a mark')
  })

  test('an entity is one token, so a changed one is marked whole', () => {
    assert.deepEqual(marks(body('-say &quot;hi&quot;', '+say &quot;bye&quot;')), ['hi', 'bye'])
  })
})

describe('preRender claims only the blocks it owns', () => {
  test('a pre.sd-diff is expanded', () => {
    assert.match(preRender('<pre class="sd-diff">+a</pre>'), /sd-diff-line sd-diff-add/)
  })

  test('a mermaid block and a plain pre are untouched', () => {
    const html = '<pre class="mermaid">graph TD;\n-a-->b</pre><pre><code>-not a diff</code></pre>'
    assert.equal(preRender(html), html)
  })

  test('a class merely containing the name is not a match', () => {
    const html = '<pre class="sd-different">-a</pre>'
    assert.equal(preRender(html), html)
  })

  test('another attribute mentioning the class does not claim the block', () => {
    // A title or data- value can legitimately talk about the class — e.g. docs
    // describing the feature. Only the real class attribute may match.
    for (const html of [
      `<pre data-label='class="sd-diff"'>-a</pre>`,
      '<pre title="use class=sd-diff here">-a</pre>',
    ]) assert.equal(preRender(html), html, html)
  })

  test('the class attribute is still found after other attributes', () => {
    assert.match(preRender('<pre id="x" title="a b" class="sd-diff">+a</pre>'), /sd-diff-add/)
  })

  test('an already-expanded block is not expanded twice', () => {
    const once = preRender('<pre class="sd-diff">+a</pre>')
    assert.equal(preRender(once), once)
  })

  test('the pre keeps its own attributes', () => {
    assert.match(preRender('<pre class="sd-diff" id="d">+a</pre>'), /<pre class="sd-diff" id="d">/)
  })
})

describe('a diff fence reaches the transform', () => {
  test('```diff becomes the pre the publish step expands', () => {
    const html = markdown('```diff\n-old\n+new\n```')
    assert.match(html, /<pre class="sd-diff">/)
    assert.match(preRender(html), /sd-diff-line sd-diff-del/)
  })

  test('other fences keep the plain code-block markup', () => {
    assert.match(markdown('```js\nconst a = 1\n```'), /<pre><code class="language-js">/)
  })

  test('fence content is escaped before the transform sees it', () => {
    assert.match(markdown('```diff\n-<script>\n```'), /&lt;script&gt;/)
  })
})
