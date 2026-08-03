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

  test('a run of several removals gets no word marks', () => {
    // -a -b +c +d has no unambiguous pairing; the line tint carries it alone.
    const html = body('-run one', '-run two', '+run three', '+run four')
    assert.deepEqual(marks(html), [])
    assert.deepEqual(kinds(html), ['del', 'del', 'add', 'add'])
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

  test('an added line following a context line is not paired backwards', () => {
    assert.deepEqual(marks(body(' ctx', '+added alone')), [])
  })

  test('escaped markup is not split mid-entity', () => {
    const html = body('-a &lt;div&gt; b', '+a &lt;span&gt; b')
    assert.deepEqual(marks(html), ['&lt;div&gt;', '&lt;span&gt;'])
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
