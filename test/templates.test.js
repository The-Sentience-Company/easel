import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as review from '../templates/review.js'
import * as evalT from '../templates/eval.js'
import * as page from '../templates/page.js'
import * as answerKey from '../templates/answer-key.js'
import { esc, markdown, widget, TemplateError } from '../templates/_html.js'
import { buildPreview } from './preview.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const sample = async (n) => JSON.parse(await readFile(join(HERE, 'samples', `${n}.json`), 'utf8'))

const TEMPLATES = [review, evalT, page, answerKey]

describe('contract: every template', () => {
  test('renders sample data to body-inner HTML with no document tags', async () => {
    for (const t of TEMPLATES) {
      const html = t.render(await sample(t.name))
      assert.equal(typeof html, 'string')
      assert.ok(html.length > 0, `${t.name} produced empty output`)
      assert.doesNotMatch(html, /<\s*(html|head|body)\b/i, `${t.name} emitted a document tag`)
    }
  })

  // The daemon allowlist, the preview harness, and the screenshot sweep each
  // enumerate templates separately, so a new one lands registered in only some.
  test('is registered in the preview harness', async () => {
    for (const t of TEMPLATES) {
      const html = await buildPreview(t.name, await sample(t.name))
      assert.ok(html.includes('<html'), `${t.name} missing from the preview template map`)
    }
  })

  test('is registered in the daemon template allowlist', async () => {
    const server = await readFile(join(HERE, '..', 'daemon', 'server.js'), 'utf8')
    const line = server.match(/const TEMPLATES = new Set\(\[([^\]]*)\]\)/)
    assert.ok(line, 'could not find the daemon TEMPLATES allowlist')
    for (const t of TEMPLATES) {
      assert.ok(line[1].includes(`'${t.name}'`), `${t.name} missing from daemon/server.js TEMPLATES`)
    }
  })

  test('never emits sf- classes or data-sid', async () => {
    for (const t of TEMPLATES) {
      const html = t.render(await sample(t.name))
      assert.doesNotMatch(html, /class\s*=\s*("[^"]*|'[^']*)\bsf-/, `${t.name} emitted an sf- class`)
      assert.doesNotMatch(html, /\sdata-sid\s*=/, `${t.name} emitted data-sid`)
    }
  })

  test('throws a readable TemplateError on invalid data', () => {
    for (const t of TEMPLATES) {
      assert.throws(() => t.render(null), TemplateError, `${t.name} did not throw on null`)
      assert.throws(() => t.render([]), TemplateError, `${t.name} did not throw on an array`)
    }
  })
})

describe('escaping', () => {
  test('escapes the five HTML-significant characters', () => {
    assert.equal(esc(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;')
  })

  test('user data cannot break out into a live element', () => {
    const html = review.render({
      title: '</h1><script>alert(1)</script>',
      sections: [{ heading: '"><img src=x onerror=alert(1)>', body: 'ok' }],
    })
    // The payload may appear as escaped text; what must not exist is a real tag.
    assert.doesNotMatch(html, /<script\b/)
    assert.doesNotMatch(html, /<img\b/)
    assert.match(html, /&lt;script&gt;/)
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  })

  test('markdown rejects javascript: and data: links', () => {
    const out = markdown('[x](javascript:alert(1)) [y](data:text/html,hi) [ok](https://example.com)')
    assert.doesNotMatch(out, /href="javascript:/)
    assert.doesNotMatch(out, /href="data:/)
    assert.match(out, /href="https:\/\/example\.com"/)
  })
})

describe('markdown tables', () => {
  const TABLE = [
    '| Attempt | Base delay | Cumulative |',
    '|---|---:|:---:|',
    '| 1 | 0s | 0s |',
    '| 2 | **1s** | `2s` |',
  ].join('\n')

  test('renders a real table, not a paragraph of pipes', () => {
    const out = markdown(TABLE)
    assert.match(out, /<table>/)
    assert.equal((out.match(/<tr>/g) || []).length, 3, 'header + 2 body rows')
    assert.equal((out.match(/<th\b/g) || []).length, 3)
    assert.doesNotMatch(out, /<p>\s*\|/, 'fell back to pipe soup')
    assert.doesNotMatch(out, /\|/, 'a literal pipe leaked into the output')
  })

  test('ships inside the horizontal scroll wrapper', () => {
    assert.match(markdown(TABLE), /<div class="sd-tablewrap"><table>/)
  })

  test('carries alignment as a class, because publish strips style attributes', () => {
    const out = markdown(TABLE)
    assert.doesNotMatch(out, /style\s*=/, 'alignment via style would be sanitized away at publish')
    assert.match(out, /<th class="sd-align-right">Base delay<\/th>/)
    assert.match(out, /<th class="sd-align-center">Cumulative<\/th>/)
    assert.match(out, /<th>Attempt<\/th>/, 'an unaligned column must stay unclassed')
    assert.match(out, /<td class="sd-align-right">0s<\/td>/)
  })

  test('every alignment marker maps to its own class', () => {
    const out = markdown('| a | b | c | d |\n| :--- | ---: | :---: | --- |\n| 1 | 2 | 3 | 4 |')
    assert.match(out, /<th class="sd-align-left">a<\/th>/)
    assert.match(out, /<th class="sd-align-right">b<\/th>/)
    assert.match(out, /<th class="sd-align-center">c<\/th>/)
    assert.match(out, /<th>d<\/th>/)
  })

  test('renders inline formatting inside cells', () => {
    const out = markdown(TABLE)
    assert.match(out, /<td[^>]*><strong>1s<\/strong><\/td>/)
    assert.match(out, /<td[^>]*><code>2s<\/code><\/td>/)
  })

  test('escapes cell content — a table is not an HTML escape hatch', () => {
    for (const src of [
      '| h |\n|---|\n| <img src=x onerror=alert(1)> |',
      '| <img src=x onerror=alert(1)> |\n|---|\n| body |',
    ]) {
      const out = markdown(src)
      assert.doesNotMatch(out, /<img\b/, `live element survived in: ${src}`)
      assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/)
    }
  })

  test('accepts rows without leading or trailing pipes', () => {
    const out = markdown('a | b\n--- | ---\n1 | 2')
    assert.match(out, /<th>a<\/th><th>b<\/th>/)
    assert.match(out, /<td>1<\/td><td>2<\/td>/)
  })

  test('an escaped pipe is content, not a column break', () => {
    const out = markdown('| h |\n|---|\n| a \\| b |')
    assert.equal((out.match(/<td/g) || []).length, 1, 'split on an escaped pipe')
    assert.match(out, /<td>a \| b<\/td>/)
  })

  test('an escaped pipe ending the last cell survives', () => {
    // With no trailing delimiter, the final `\|` is content — stripping it
    // leaves a stray backslash where the pipe should be.
    assert.match(markdown('| h | i |\n|---|---|\n| a | ends \\| |'), /<td>ends \|<\/td>/)
    assert.match(markdown('| h | i |\n|---|---|\n| a | ends \\|'), /<td>ends \|<\/td>/)
  })

  /* A single hyphen is a valid GFM delimiter — verified against `marked`, which
     renders `-|-` as a table. Requiring three would drop valid tables. */
  test('separator cells accept one hyphen, matching GFM', () => {
    for (const sep of ['-|-', '--|--', '---|---', ':-|-:']) {
      assert.match(markdown(`a | b\n${sep}\n1 | 2`), /<table>/, `rejected separator: ${sep}`)
    }
  })

  test('a short row is padded to the header width, never dropped', () => {
    const out = markdown('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 |')
    assert.equal((out.match(/<tr>/g) || []).length, 3, 'a short row was dropped')
    assert.match(out, /<tr><td>1<\/td><td><\/td><td><\/td><\/tr>/)
  })

  /* Surplus cells in a long row are dropped silently. That is GFM behaviour —
     `marked` does the same — so it is pinned, not fixed. */
  test('a long row is truncated to the header width', () => {
    const out = markdown('| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 | SURPLUS |')
    assert.doesNotMatch(out, /SURPLUS/)
    assert.equal((out.match(/<td/g) || []).length, 3)
  })

  test('pipes without a separator row stay prose', () => {
    const out = markdown('this | that | other')
    assert.match(out, /<p>/)
    assert.doesNotMatch(out, /<table>/)
  })

  test('a table ends at a blank line and prose after it still renders', () => {
    const out = markdown('| h |\n|---|\n| 1 |\n\nAfter the table.')
    assert.match(out, /<\/table><\/div>\s*<p>After the table\.<\/p>/)
  })
})

describe('markdown', () => {
  // Child with a hard deadline: a non-advancing loop is a sync spin, so an
  // in-process assertion would wedge the runner instead of going red.
  const renderInChild = (src) =>
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { markdown } from ${JSON.stringify(new URL('../templates/_html.js', import.meta.url).href)}
       process.stdout.write(markdown(${JSON.stringify(src)}))`,
    ], { encoding: 'utf8', timeout: 5000 })

  test('an info-string fence terminates and is parsed as a fence', () => {
    const out = renderInChild('```js title="example"\nconst a = 1\n```')
    assert.match(out, /<pre><code class="language-js">/)
    assert.doesNotMatch(out, /<p>/, 'the fence line leaked into a paragraph')
  })

  // Deep-review finding 0's exact repro shape.
  test('a ```ts {1,3} fence terminates and is parsed as a fence', () => {
    const out = renderInChild('```ts {1,3}\nconst a = 1\n```')
    assert.match(out, /<pre><code class="language-ts">/)
    assert.doesNotMatch(out, /<p>/)
  })

  test('an unterminated info-string fence still terminates', () => {
    assert.match(renderInChild('```ts {1,3}'), /<pre><code class="language-ts">/)
  })

  test('a brace-list with no language does not become a bogus language class', () => {
    const out = renderInChild('``` {1,3}\nb\n```')
    assert.match(out, /<pre><code>/)
    assert.doesNotMatch(out, /language-/)
  })

  test('a mermaid fence with an info string still renders as pre.mermaid', () => {
    assert.match(renderInChild('```mermaid theme=dark\nflowchart LR\n  A --> B\n```'), /<pre class="mermaid">/)
  })

  test('prose after an unparsed fence line still terminates', () => {
    assert.match(renderInChild('~~~\nweird\n~~~\ntail'), /tail/)
  })

  test('a mermaid fence becomes a pre.mermaid element with escaped source', () => {
    const out = markdown('```mermaid\nflowchart LR\n  A[a<br/>b] --> B\n```')
    assert.match(out, /<pre class="mermaid">/)
    assert.match(out, /&lt;br\/&gt;/, 'source must stay escaped until publish-time render')
  })

  test('a plain fence becomes pre > code, not pre.mermaid', () => {
    const out = markdown('```js\nconst a = 1 < 2\n```')
    assert.match(out, /<pre><code class="language-js">/)
    assert.doesNotMatch(out, /class="mermaid"/)
    assert.match(out, /1 &lt; 2/)
  })
})

describe('widgets', () => {
  test('emits the declarative protocol a2 binds against', () => {
    const html = widget({ type: 'vote', id: 'w1', prompt: 'Ship?', options: ['yes', 'no'] })
    assert.match(html, /data-widget="vote"/)
    assert.match(html, /data-widget-id="w1"/)
    assert.match(html, /data-option="yes"/)
    assert.match(html, /data-option="no"/)
  })

  test('options are native buttons — the annotation layer swallows non-native clicks', () => {
    const html = widget({ type: 'vote', id: 'w1', prompt: 'Ship?', options: ['yes'] })
    assert.match(html, /<button type="button" data-option="yes">/)
  })

  test('rejects an unknown widget type and empty options', () => {
    assert.throws(() => widget({ type: 'slider', id: 'w', prompt: 'p', options: ['a'] }), TemplateError)
    assert.throws(() => widget({ type: 'vote', id: 'w', prompt: 'p', options: [] }), TemplateError)
  })
})

describe('review', () => {
  test('renders decisions and votes as widgets', async () => {
    const html = review.render(await sample('review'))
    assert.match(html, /data-widget="decision"/)
    assert.match(html, /data-widget-id="budget-location"/)
    assert.match(html, /data-widget="approve"/)
  })

  test('rejects duplicate widget ids across decisions and votes', () => {
    assert.throws(() => review.render({
      title: 't',
      decisions: [{ id: 'dup', question: 'q', options: ['a'] }],
      votes: [{ id: 'dup', question: 'q', options: ['a'] }],
    }), TemplateError)
  })

  test('requires at least one of sections, decisions, or votes', () => {
    assert.throws(() => review.render({ title: 'empty' }), TemplateError)
  })
})

describe('eval', () => {
  const dossier = (over = {}) => ({
    title: 't',
    cases: [
      { id: 'a', name: 'a first', notes: 'body one' },
      { id: 'b', name: 'b second', notes: 'body two' },
    ],
    ...over,
  })
  const compare = (over = {}) => ({
    title: 't',
    blindKey: { a: 0, b: 1 },
    cases: [
      { id: 'a', candidates: ['left text', 'right text'] },
      { id: 'b', candidates: ['one', 'two'] },
    ],
    ...over,
  })
  const matrix = (over = {}) => ({
    title: 't',
    cases: [{
      id: 'ahmet',
      items: [
        { label: 'Job', note: 'B drops the title', candidates: { B: 'Works at Sentience.', C: 'Works as an Engineer at Sentience.' } },
        { label: 'Habits', candidates: { B: 'Drinks alcohol.', C: 'Drinks alcohol.' } },
      ],
    }],
    ...over,
  })

  test('run metadata is one prose line, not a row of badges', async () => {
    const html = evalT.render(await sample('eval'))
    assert.match(html, /<span class="sd-muted">dataset<\/span> <strong>frozen-2026-07-28<\/strong>/)
    assert.doesNotMatch(html, /class="sd-badge">dataset/)
  })

  test('the case heading shows the id once when the name repeats it', async () => {
    const html = evalT.render(await sample('eval'))
    assert.match(html, /<span class="sd-mono">pref-001<\/span> Explicit dietary preference/)
    assert.doesNotMatch(html, /pref-001<\/span> pref-001/)
  })

  test('cases summary table appears only when a status or score exists', () => {
    assert.doesNotMatch(evalT.render(dossier()), /<h2>Cases<\/h2>/)
    const withStatus = dossier()
    withStatus.cases[0].status = 'fail'
    assert.match(evalT.render(withStatus), /<h2>Cases<\/h2>/)
  })

  test('dossier mode: notes in a card, one verdict widget per case', () => {
    const html = evalT.render(dossier())
    assert.match(html, /<div class="sd-card"><p>body one<\/p><\/div>/)
    assert.equal([...html.matchAll(/data-widget="rating"/g)].length, 2)
    assert.match(html, /data-widget-id="verdict-a"/)
    assert.match(html, /data-option="pass"/)
    assert.match(html, /data-option="needs-work"/)
  })

  test('dossier mode folds only pass cases, and only above the threshold', () => {
    const big = (status) => ({
      title: 't',
      cases: Array.from({ length: 16 }, (_, i) => ({ id: `c${i}`, status, notes: 'x' })),
    })
    assert.equal([...evalT.render(big('pass')).matchAll(/<details class="sd-collapse">/g)].length, 16)
    assert.doesNotMatch(evalT.render(big('fail')), /<details/)
    const small = dossier()
    small.cases[0].status = 'pass'
    assert.doesNotMatch(evalT.render(small), /<details/)
  })

  test('compare mode: two labeled columns, order follows the blind key', () => {
    const html = evalT.render(compare())
    assert.match(html, /<div class="sd-eyebrow">output 1<\/div><p>left text<\/p>/)
    assert.match(html, /<div class="sd-eyebrow">output 2<\/div><p>right text<\/p>/)
    // b's key is 1: candidates[1] renders as output 1.
    assert.match(html, /<div class="sd-eyebrow">output 1<\/div><p>two<\/p>/)
    assert.match(html, /data-widget-id="cmp-a"/)
    assert.match(html, /data-option="output-1"/)
  })

  test('compare mode never renders which run is which', () => {
    const html = evalT.render(compare())
    assert.doesNotMatch(html, /blindKey/i)
    assert.doesNotMatch(html, /data-option="0"/)
  })

  test('compare mode requires a 0-or-1 blind key entry per case', () => {
    assert.throws(() => evalT.render(compare({ blindKey: undefined })), /requires blindKey/)
    assert.throws(() => evalT.render(compare({ blindKey: { a: 0 } })), /blindKey\["b"\]/)
    assert.throws(() => evalT.render(compare({ blindKey: { a: 2, b: 0 } })), /blindKey\["a"\]/)
  })

  test('compare mode requires exactly two candidates', () => {
    const data = compare()
    data.cases[0].candidates = ['only one']
    assert.throws(() => evalT.render(data), /exactly 2/)
  })

  test('matrix mode: item rows with a plain best? row, never sd-pick-row', () => {
    const html = evalT.render(matrix())
    assert.match(html, /<th class="sd-align-left">item<\/th><th class="sd-align-left">B<\/th>/)
    assert.match(html, /<tr><td class="sd-muted">best\?<\/td><td colspan="2">/)
    assert.doesNotMatch(html, /sd-pick-row/)
    assert.match(html, /data-widget-id="best-ahmet-0"/)
    assert.match(html, /data-widget-id="overall-ahmet"/)
    assert.match(html, />B best</)
    assert.match(html, /data-option="all-bad"/)
  })

  test('matrix mode emphasizes diverging tokens and leaves common ground plain', () => {
    const html = evalT.render(matrix())
    assert.match(html, /<strong>Engineer<\/strong>/)
    assert.doesNotMatch(html, /<strong>Drinks<\/strong>/, 'identical rows must not emphasize')
    assert.match(html, /<td>Drinks alcohol\.<\/td>/)
  })

  test('matrix emphasis matches emails whole — interior @ and dots survive', () => {
    const out = evalT.emphasize('mail a@b.com end.', ['mail a@b.com end,'])
    assert.doesNotMatch(out, /<strong>/, 'edge punctuation must not fake a divergence')
  })

  test('matrix mode rejects items whose candidate keys differ from the case', () => {
    const data = matrix()
    data.cases[0].items[1].candidates = { B: 'x', D: 'y' }
    assert.throws(() => evalT.render(data), /do not match/)
  })

  test('a case carrying two shape fields is rejected, not silently picked', () => {
    assert.throws(() => evalT.render({
      title: 't',
      cases: [{ id: 'a', notes: 'x', candidates: ['1', '2'] }],
    }), /notes and candidates/)
  })

  test('the id strips from the name only at a word boundary', () => {
    const html = evalT.render({ title: 't', cases: [{ id: 'a', name: 'alpha result', notes: 'x' }] })
    assert.match(html, /<span class="sd-mono">a<\/span> alpha result/)
  })

  test('matrix items may order the same candidate keys differently', () => {
    const data = matrix()
    data.cases[0].items[1].candidates = { C: 'Drinks alcohol.', B: 'Drinks alcohol.' }
    const html = evalT.render(data)
    // Columns render in the first item's order regardless.
    assert.match(html, /<th class="sd-align-left">B<\/th><th class="sd-align-left">C<\/th>/)
  })

  test('mixed case shapes are rejected with a readable error', () => {
    assert.throws(() => evalT.render({
      title: 't',
      blindKey: { b: 0 },
      cases: [{ id: 'a', notes: 'x' }, { id: 'b', candidates: ['1', '2'] }],
    }), /mixed case shapes/)
    assert.throws(() => evalT.render({ title: 't', cases: [{ id: 'a' }] }), /none of notes, candidates, or items/)
  })

  test('rejects empty cases and duplicate case ids', () => {
    assert.throws(() => evalT.render({ title: 't', cases: [] }), TemplateError)
    assert.throws(() => evalT.render({
      title: 't',
      cases: [{ id: 'a', notes: 'x' }, { id: 'a', notes: 'y' }],
    }), TemplateError)
  })
})

describe('page', () => {
  test('passes hand-authored HTML through unchanged', () => {
    const html = '<h1>Hi</h1><p>body</p>'
    assert.equal(page.render({ html }), html)
  })

  test('rejects document tags, data-sid, and sf- classes', () => {
    assert.throws(() => page.render({ html: '<body>x</body>' }), TemplateError)
    assert.throws(() => page.render({ html: '<div data-sid="3">x</div>' }), TemplateError)
    assert.throws(() => page.render({ html: '<div class="sf-queue">x</div>' }), TemplateError)
  })

  test('rejects sf- classes in every legal attribute syntax', () => {
    for (const html of [
      '<div class=sf-queue>x</div>',
      "<div class='sf-queue'>x</div>",
      '<div class = sf-queue>x</div>',
      '<div class="sd-card sf-toast">x</div>',
    ]) {
      assert.throws(() => page.render({ html }), TemplateError, `accepted: ${html}`)
    }
  })

  test('does not over-reject legitimate content', () => {
    for (const html of [
      '<div class=sd-card>x</div>',
      '<div class="sd-card sd-tablewrap">x</div>',
      '<p>the sf- prefix is reserved</p>',
      '<div data-surface="sf-ish">x</div>',
    ]) {
      assert.equal(page.render({ html }), html, `wrongly rejected: ${html}`)
    }
  })

  test('rejects a non-string or empty html field', () => {
    assert.throws(() => page.render({ html: 42 }), TemplateError)
    assert.throws(() => page.render({ html: '   ' }), TemplateError)
  })
})

describe('answer-key', () => {
  const base = () => sample('answer-key')

  test('renders teach content before any cell content', async () => {
    const html = answerKey.render(await base())
    const teachAt = html.indexOf('How this eval works')
    const firstCellAt = html.indexOf('Dana Whitfield')
    assert.ok(teachAt >= 0 && firstCellAt >= 0)
    assert.ok(teachAt < firstCellAt, 'teach block must precede the first cell')
  })

  test('groups cells by category and emits one verdict widget per category', async () => {
    const html = answerKey.render(await base())
    const verdicts = [...html.matchAll(/data-widget-id="(verdict-[a-z0-9-]+)"/g)].map((m) => m[1])
    assert.equal(verdicts.length, 2)
    assert.match(verdicts[0], /^verdict-comms-pref-/)
    assert.match(verdicts[1], /^verdict-location-tz-/)
    assert.equal([...html.matchAll(/data-widget-id="cell-[a-z0-9-]+"/g)].length, 3)
  })

  test('punctuation-distinct names get distinct widget ids', async () => {
    const data = await base()
    data.category_labels['C++'] = 'C plus plus'
    data.category_labels['C#'] = 'C sharp'
    const cell = (category) => ({ category, person: 'Same Person', positives: [{ content: 'x' }] })
    data.cells = [cell('C++'), cell('C#')]
    const ids = [...answerKey.render(data).matchAll(/data-widget-id="(cell-[a-z0-9-]+)"/g)].map((m) => m[1])
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1], 'C++ and C# must not collapse to one id')
  })

  test('non-Latin names still produce usable, distinct widget ids', async () => {
    const data = await base()
    data.category_labels.comms_pref = 'Communication preferences'
    data.cells = [
      { category: 'comms_pref', person: '田中太郎', positives: [{ content: 'x' }] },
      { category: 'comms_pref', person: 'Ольга Иванова', positives: [{ content: 'y' }] },
    ]
    const ids = [...answerKey.render(data).matchAll(/data-widget-id="(cell-[a-z0-9-]+)"/g)].map((m) => m[1])
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
    for (const id of ids) assert.match(id, /^cell-comms-pref-[a-z0-9]+$/)
  })

  test('optional fields may be null, the JSON way to say absent', async () => {
    const data = await base()
    data.status_badges = null
    data.how_to_test = null
    const html = answerKey.render(data)
    assert.ok(html.includes('Communication preferences'))
  })

  test('markdown prose is never wrapped in a p — that nests invalidly', async () => {
    const html = answerKey.render(await base())
    assert.doesNotMatch(html, /<p[^>]*>\s*<p>/)
  })

  test('a category with no plain-language label throws', async () => {
    const data = await base()
    delete data.category_labels.comms_pref
    assert.throws(() => answerKey.render(data), (err) => {
      assert.ok(err instanceof TemplateError)
      assert.match(err.message, /comms_pref/)
      assert.match(err.message, /category_labels/)
      return true
    })
  })

  test('a negative reason with no description throws', async () => {
    const data = await base()
    delete data.reasons.unstated.desc
    assert.throws(() => answerKey.render(data), (err) => {
      assert.ok(err instanceof TemplateError)
      assert.match(err.message, /reasons\["unstated"\]\.desc/)
      return true
    })
  })

  test('a negative naming a reason absent from the map throws', async () => {
    const data = await base()
    data.cells[0].negatives[1].reason = 'invented_reason'
    assert.throws(() => answerKey.render(data), (err) => {
      assert.ok(err instanceof TemplateError)
      assert.match(err.message, /invented_reason/)
      return true
    })
  })

  test('unresolved evidence is labelled, never rendered as a bare pointer', async () => {
    const html = answerKey.render(await base())
    assert.match(html, /evrow messages:9902/)
    assert.match(html, /evidence text was not resolved/)
  })

  test('a cell with neither positives nor negatives throws', async () => {
    const data = await base()
    data.cells[1].positives = []
    data.cells[1].negatives = []
    assert.throws(() => answerKey.render(data), TemplateError)
  })

  test('emits no form controls — the publish sanitizer drops them', async () => {
    assert.doesNotMatch(answerKey.render(await base()), /<\s*(input|textarea|select)\b/i)
  })
})
