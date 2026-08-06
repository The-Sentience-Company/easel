// Regression tests for the merge-ready review fix-up round.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon, waitHealthy, makeApi, portFor } from './harness.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = portFor(import.meta.url)
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sf-fixups-'))
const PAGE = join(DATA_DIR, 'page.html')

let daemon

before(async () => {
  writeFileSync(PAGE, '<h1>Fixups</h1><p>plain para</p>')
  daemon = startDaemon(PORT, DATA_DIR)
  await waitHealthy(BASE)
})

after(() => daemon?.kill())

const api = makeApi(BASE)

let key

test('open rejects non-html file and non-json data with 400', async () => {
  const md = join(DATA_DIR, 'notes.md')
  writeFileSync(md, '# raw markdown')
  const mdOpen = await api('POST', '/api/open', { file: md })
  assert.equal(mdOpen.status, 400)
  assert.match(mdOpen.data.error, /\.html/)
  const badData = await api('POST', '/api/open', { template: 'review', data: '/tmp/data.yaml' })
  assert.equal(badData.status, 400)
  assert.match(badData.data.error, /\.json/)
})

test('round html is sanitized: script elements, on* attrs, javascript: URLs stripped', async () => {
  writeFileSync(
    PAGE,
    '<h1>Fixups</h1><p onclick="alert(1)">plain para</p>' +
      '<script>fetch("/api/open")</script>' +
      '<p><a href="javascript:alert(1)">bad</a> <a href="https://example.com">good</a></p>'
  )
  const { status, data } = await api('POST', '/api/open', { file: PAGE })
  assert.equal(status, 200)
  key = data.key
  const state = (await api('GET', `/api/b/${key}/state`)).data
  const html = state.currentRound.html
  assert.ok(!html.includes('<script'), 'script element survived')
  assert.ok(!html.includes('onclick'), 'on* attribute survived')
  assert.ok(!html.includes('javascript:'), 'javascript: URL survived')
  assert.ok(html.includes('https://example.com'), 'legit URL was stripped')
  assert.ok(html.includes('plain para'), 'content text lost')
})

test('malformed JSON body is 400, not 500', async () => {
  const res = await fetch(`${BASE}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  })
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /invalid JSON/)
})

test('oversized body is 413', async () => {
  const res = await fetch(`${BASE}/api/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'x'.repeat(2 * 1024 * 1024) }),
  })
  assert.equal(res.status, 413)
})

test('feedback and widget against a nonexistent round are 404, never stored', async () => {
  const fb = await api('POST', `/api/b/${key}/feedback`, {
    clientId: 'c1', round: 99, anchor: { sid: 's-x' }, comment: 'ghost round',
  })
  assert.equal(fb.status, 404)
  const w = await api('POST', `/api/b/${key}/widget`, {
    clientId: 'c1', round: 99, widgetId: 'w1', value: 'yes',
  })
  assert.equal(w.status, 404)
  const replay = await api('GET', `/api/b/${key}/feedback?since=0`)
  assert.equal(replay.data.items.length, 0)
})

test('non-numeric timeoutS blocks (falls back to default) instead of timing out instantly', async () => {
  const ctrl = new AbortController()
  const pending = fetch(`${BASE}/api/b/${key}/await`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'nan-agent', timeoutS: 'bogus' }),
    signal: ctrl.signal,
  }).catch(() => {})
  await new Promise((r) => setTimeout(r, 500))
  const state = (await api('GET', `/api/b/${key}/state`)).data
  assert.equal(state.agentWaiting, true, 'await returned instantly on NaN timeout')
  ctrl.abort()
  await pending
})

test('a <br/> label no longer draws an audit warning — the sketch path renders it', async () => {
  writeFileSync(PAGE, '<h1>Fixups</h1><pre class="mermaid">graph TD\nA[one<br/>two]-->B</pre>')
  const { data } = await api('POST', `/api/b/${key}/publish`, {})
  const types = data.audit.findings.map((f) => f.type)
  assert.ok(!types.includes('mermaid-br-literal'), `obsolete br warning fired: ${JSON.stringify(types)}`)
})

test('shell page puts #sf-chrome before #sf-content so the sticky topbar tops the page', async () => {
  const page = await (await fetch(`${BASE}/b/${key}`)).text()
  assert.ok(page.indexOf('id="sf-chrome"') < page.indexOf('id="sf-content"'))
})

test('an unknown board key of any shape returns "no board", not "no route"', async () => {
  const { status, data } = await api('GET', '/api/b/nosuchkey/status')
  assert.equal(status, 404)
  assert.match(data.error, /no board/)
})

// Allowlist sanitizer. Every assertion reads SERVED BYTES (/state) — what is in
// storage, not the rendered DOM.

let sanitizeCase = 0
async function servedBytes(html) {
  // Unique file per call: /api/open is idempotent by path, so a shared file
  // would return the first board instead of re-reading.
  const file = join(DATA_DIR, `san-${sanitizeCase++}.html`)
  writeFileSync(file, html)
  const { data } = await api('POST', '/api/open', { file })
  return (await api('GET', `/api/b/${data.key}/state`)).data.currentRound.html
}

test('allowlist drops the whole vector family a4 named plus the ones they could not test', async () => {
  const cases = {
    'iframe srcdoc': '<iframe srcdoc="<script>parent.__x=1</script>"></iframe>',
    'svg use onload': '<svg><use href="#a" onload="alert(1)"></use></svg>',
    'svg href javascript': '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
    'mathml maction': '<math><maction actiontype="statusline" xlink:href="javascript:alert(1)">x</maction></math>',
    'object data': '<object data="javascript:alert(1)"></object>',
    'embed src': '<embed src="javascript:alert(1)">',
    'form action': '<form action="javascript:alert(1)"><button type="submit">go</button></form>',
    'style url import': '<style>@import url("//evil/x")</style>',
    'inline style url': '<div style="background:url(//evil/y)">z</div>',
    'base href': '<base href="//evil/">',
    'meta refresh': '<meta http-equiv="refresh" content="0;url=//evil">',
  }
  for (const [name, payload] of Object.entries(cases)) {
    const out = await servedBytes(`<p>keep</p>${payload}`)
    assert.ok(out.includes('keep'), `${name}: dropped legit sibling content`)
    assert.ok(!/<script|srcdoc|<iframe|<object|<embed|<form\b|<base|<meta|<style|<math|<maction/i.test(out), `${name}: banned element survived — ${out}`)
    assert.ok(!/\son\w+=/i.test(out), `${name}: on* attribute survived — ${out}`)
    assert.ok(!/javascript:/i.test(out), `${name}: javascript: URL survived — ${out}`)
    assert.ok(!/\sstyle=/i.test(out), `${name}: inline style survived — ${out}`)
  }
})

test('allowlist preserves ordinary markup, sd- classes, widgets, and rendered mermaid SVG', async () => {
  const out = await servedBytes(
    '<section class="sd-card"><h2>Title</h2>' +
      '<p>Text <a href="https://x.test">link</a> <strong>bold</strong> <code>c</code></p>' +
      '<ul><li>one</li></ul>' +
      '<figure><img src="/img/a.png" alt="a"><figcaption>cap</figcaption></figure>' +
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td colspan="2">cell</td></tr></tbody></table>' +
      '<details open><summary>more</summary><p>body</p></details>' +
      '<div data-widget="vote" data-widget-id="w1"><button type="button" data-option="yes">Yes</button></div>' +
      // First takes the excalidraw path; state diagrams are unsupported there,
      // so the second falls back to mermaid — one page covers both renderers.
      '<pre class="mermaid">graph TD\nA[Start]-->B[End]</pre>' +
      '<pre class="mermaid">stateDiagram-v2\n[*] --> Working\nWorking --> [*]</pre>'
  )
  for (const t of [
    'sd-card', '<h2', 'href="https://x.test"', '<strong>', '<code>', '<li', 'one</li>',
    'src="/img/a.png"', 'alt="a"', '<figcaption', 'colspan="2"', '<details open', '<summary',
    'data-widget="vote"', 'data-option="yes"', 'type="button"',
    '<svg', '<path', 'transform=',
    'marker-end', '<foreignObject',
    '<text', 'url(data:font/woff2;base64,',
  ]) {
    assert.ok(out.includes(t), `over-drop: allowlist removed ${t}`)
  }
})
