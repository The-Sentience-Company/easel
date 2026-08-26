#!/usr/bin/env node
/* Dev-only preview harness — renders a template from sample JSON without the daemon.
   node test/preview.js <review|eval|answer-key|page|queue> <data.json> [--out f] [--theme dark] [--mermaid] [--chrome] */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const TEMPLATES = { review: 'review.js', eval: 'eval.js', 'answer-key': 'answer-key.js', page: 'page.js', queue: 'queue.js', rulings: 'rulings.js', compare: 'compare.js', gallery: 'gallery.js', replay: 'replay.js' }

/* client.js applies sf-recorded at runtime; templates never emit it.
   Simulated here so that CSS is reviewable before the daemon exists. */
function simulateRecorded(body) {
  let done = false
  return body.replace(/<div data-widget="([^"]*)" data-widget-id="([^"]*)">/, (m, type, id) => {
    if (done) return m
    done = true
    return `<div data-widget="${type}" data-widget-id="${id}" class="sf-recorded">`
  }).replace(/(<div class="sd-widget-options">[\s\S]*?<\/div>)/, (m) =>
    done ? m.replace('<button type="button"', '<button type="button" aria-pressed="true"') : m)
}

export async function buildPreview(templateName, data, { theme = 'light', mermaid = false, chrome = false, recorded = false } = {}) {
  const file = TEMPLATES[templateName]
  if (!file) throw new Error(`unknown template "${templateName}" — one of ${Object.keys(TEMPLATES).join(', ')}`)

  const mod = await import(join(ROOT, 'templates', file))
  let body = mod.render(data)

  if (mermaid) {
    const { preRender } = await import(join(ROOT, 'render', 'mermaid.js'))
    body = await preRender(body, { theme: theme === 'dark' ? 'dark' : 'default' })
  }

  if (recorded) body = simulateRecorded(body)
  // sf-annotated is runtime-applied like sf-recorded; simulated so marker CSS is reviewable.
  if (chrome) body = simulateAnnotated(body)

  const css = await readFile(join(ROOT, 'chrome', 'easel.css'), 'utf8')
  const title = (data && data.title) || templateName

  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)} — easel preview</title>
<style>
${css}
</style>
</head>
<body class="sf-shell">
${chrome ? chromeFixture(title) : ''}
<main id="sf-content">
${body}
</main>
</body>
</html>
`
}

function simulateAnnotated(body) {
  return body.replace('<p>', '<p class="sf-annotated" data-marker-hue="0"><button class="sf-marker">A1</button>')
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

/* Static markup mirroring client.js's structure, so chrome CSS is reviewable
   before the daemon exists. Inert — no behavior, no SSE. */
function chromeFixture(title) {
  return `<div id="sf-chrome">
  <div class="sf-topbar">
    <a class="sf-brand" href="/">easel</a>
    <div class="sf-title">${escapeText(title)}</div>
    <div class="sf-wip-marker">unpublished changes</div>
    <div class="sf-agent sf-agent-waiting">agent waiting<button class="sf-cancel-wait">cancel</button></div>
    <div class="sf-status"><span class="sf-status-dot sf-connected"></span>connected</div>
    <button class="sf-annotate-toggle sf-on">Annotate</button>
    <button class="sf-send-now">Send 2</button>
    <button class="sf-queue-toggle">[F]eedback <span class="sf-queue-count">2</span></button>
    <button class="sf-chat-toggle">[C]hat</button>
    <button class="sf-chrome-toggle sf-on"></button>
  </div>
  <div class="sf-rounds">
    <div class="sf-round-strip">
      <span class="sf-round-keys">[Q]·[W]</span>
      <button class="sf-round-pill" data-round="1">r1</button>
      <button class="sf-round-pill sf-round-current sf-round-active" data-round="2">r2</button>
    </div>
    <button class="sf-rounds-expand">[⌄] All 2</button>
    <div class="sf-diff-legend">
      <span class="sf-legend-added">added</span>
      <span class="sf-legend-removed">removed</span>
      <span class="sf-legend-modified">modified</span>
      <span class="sf-legend-moved">moved</span>
      <span class="sf-legend-annotated"><span class="sf-item-marker">A1</span>annotated — matches its feedback row</span>
    </div>
  </div>
  <aside class="sf-queue sf-open">
    <div class="sf-queue-header">Feedback <span class="sf-queue-count">2</span></div>
    <div class="sf-queue-list">
      <div class="sf-queue-item sf-item-draft" data-sid="s-demo" data-marker-hue="0">
        <span class="sf-item-marker">A1</span>
        <div class="sf-item-round">r2</div>
        <div class="sf-item-excerpt">the retry budget should be per-agent not per-call</div>
        <div class="sf-item-comment">This contradicts the cursor design.</div>
        <button class="sf-item-remove">×</button>
      </div>
      <div class="sf-queue-item sf-item-widget sf-item-submitted">
        <div class="sf-item-round">r2</div>
        <div class="sf-item-excerpt">decision: storage-engine → sqlite</div>
      </div>
    </div>
    <button class="sf-queue-send">Send 2</button>
  </aside>
  <aside class="sf-chat sf-open">
    <div class="sf-chat-log">
      <div class="sf-chat-msg sf-msg-agent"><span class="sf-msg-agent-id" title="reviewer-agent">reviewer</span><span class="sf-msg-text">Round 2 is up — the metrics grid is new.</span></div>
      <div class="sf-chat-msg sf-msg-user"><span class="sf-msg-text">Looks right. One note on the verdict widget.</span></div>
    </div>
    <div class="sf-chat-working">working<button class="sf-chat-cancel">cancel</button></div>
    <form class="sf-chat-form">
      <textarea class="sf-chat-input" placeholder="Reply…"></textarea>
      <button class="sf-chat-submit">Send</button>
    </form>
  </aside>
  <div class="sf-audit sf-open">
    <button class="sf-audit-badge">2 layout notes</button>
    <div class="sf-audit-list">
      <div class="sf-audit-finding sf-sev-warn">overlapping-text near .sd-badge (overflow 0px)</div>
      <div class="sf-audit-finding sf-sev-error">clipped-text in .sd-tablewrap</div>
    </div>
  </div>
  <div class="sf-toasts"><div class="sf-toast">Queued — 2 pending</div></div>
</div>`
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length < 2) {
    console.error('usage: node test/preview.js <review|eval|answer-key|page|queue> <data.json> [--out f.html] [--theme dark] [--mermaid] [--chrome]')
    process.exit(2)
  }
  const [templateName, dataPath] = argv
  const flag = (n) => argv.includes(n)
  const value = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1] }

  const data = JSON.parse(await readFile(resolve(dataPath), 'utf8'))
  const theme = value('--theme', 'light')
  const html = await buildPreview(templateName, data, {
    theme, mermaid: flag('--mermaid'), chrome: flag('--chrome'), recorded: flag('--recorded'),
  })

  const out = resolve(value('--out', join(ROOT, 'test', 'out', `${templateName}-${theme}.html`)))
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, html, 'utf8')
  console.log(out)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
