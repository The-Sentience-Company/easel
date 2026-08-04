#!/usr/bin/env node
// easeld daemon — implements docs/api.md (authoritative).

import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, stat, truncate, rm, readdir } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpError, readBody } from './body.js'
import { createStore } from './store.js'
import { now, DATA_DIR } from './db.js'
import { annotateAndDiff, contextForSid, excerptForSid, extractIslands } from './differ.js'
import { ROUTES } from './routes.js'

const PORT = Number(process.env.EASEL_PORT || 4400)
const ROOT = dirname(fileURLToPath(import.meta.url))
const VERSION = '0.1.0'

// The running build vs what is on disk: if the checkout has moved past the commit
// this process booted from, the daemon is serving stale code until `easel update`.
// Forking git costs ~50ms and blocks the loop; the index polls the build every
// two seconds, so the answer is cached just long enough to stay out of the way.
const HEAD_TTL_MS = 15000
let headCache = { at: -Infinity, commit: null }

function headCommit() {
  if (Date.now() - headCache.at < HEAD_TTL_MS) return headCache.commit
  let commit = null
  try {
    commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    commit = null
  }
  headCache = { at: Date.now(), commit }
  return commit
}
const BOOT_COMMIT = headCommit()

function buildInfo() {
  const onDisk = headCommit()
  return { version: VERSION, commit: BOOT_COMMIT, onDisk, stale: Boolean(BOOT_COMMIT && onDisk && BOOT_COMMIT !== onDisk) }
}
// A scene carries excalidraw's embedded `files`, so one pasted image dwarfs the
// generic limit — and a 413 on the close flush would trap the drawing unsaved.
const MAX_SCENE_BYTES = 32 * 1024 * 1024
const TEMPLATES = new Set(['review', 'eval', 'page', 'answer-key', 'queue'])

const store = createStore()

// ---------------------------------------------------------------- rendering

const templateCache = new Map()

async function loadTemplate(name) {
  if (templateCache.has(name)) return templateCache.get(name)
  const url = new URL(`../templates/${name}.js`, import.meta.url)
  let mod
  try {
    mod = await import(url.href)
  } catch (err) {
    throw new Error(`template "${name}" not available (${err.code || err.message}) — templates ship separately`)
  }
  if (typeof mod.render !== 'function') throw new Error(`template "${name}" exports no render()`)
  templateCache.set(name, mod)
  return mod
}

// Sources are captured from the same string preRender consumes, so a diagram's
// stored ordinal is the one stamped onto the rendered element.
async function mermaidRender(html) {
  try {
    const mod = await import(new URL('../render/mermaid.js', import.meta.url).href)
    return { html: await mod.preRender(html), diagrams: mod.extractMermaidSources(html) }
  } catch {
    return { html, diagrams: [] }
  }
}

// Runs after mermaid so the two <pre> transforms cannot claim the same block.
async function diffRender(html) {
  try {
    const mod = await import(new URL('../render/diff.js', import.meta.url).href)
    return mod.preRender(html)
  } catch {
    return html
  }
}

function extractBody(raw) {
  const open = raw.match(/<body[^>]*>/i)
  if (!open) return raw
  const start = open.index + open[0].length
  const end = raw.search(/<\/body\s*>/i)
  return end > start ? raw.slice(start, end) : raw.slice(start)
}

// Returns { html, raw, diagrams }: html is post-mermaid render, raw is the
// pre-render source.
async function renderSource(board) {
  let raw
  if (board.template) {
    const mod = await loadTemplate(board.template)
    const data = JSON.parse(await readFile(board.data_file, 'utf8'))
    raw = mod.render(data)
  } else {
    raw = extractBody(await readFile(board.file, 'utf8'))
  }
  const rendered = await mermaidRender(raw)
  return { ...rendered, html: await diffRender(rendered.html), raw }
}

// Advisory-only static checks; the headless-render audit can extend this later.
function auditHtml(html) {
  const findings = []
  for (const m of html.matchAll(/style="[^"]*width:\s*(\d{4,})px/g)) {
    findings.push({ severity: 'warn', type: 'fixed-width-overflow', sid: null, detail: `inline width ${m[1]}px risks horizontal overflow` })
  }
  return { findings, at: now() }
}

// ---------------------------------------------------------------- SSE hub

const sseClients = new Map() // key -> Set<res>
const globalClients = new Map() // res -> Map<key, tabCount>, from /events?keys=
const eventSeqs = new Map() // key -> count of broadcasts; lets a reconnecting client detect missed events

function globalTabCount(key) {
  let n = 0
  for (const counts of globalClients.values()) n += counts.get(key) ?? 0
  return n
}

function eventSeq(key) {
  return eventSeqs.get(key) ?? 0
}

function broadcast(key, event, data) {
  const seq = eventSeq(key) + 1
  eventSeqs.set(key, seq)
  const payload = { ...data, seq }
  const set = sseClients.get(key)
  if (set) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const res of set) {
      // Timer-context callers (waiter timeouts) have no request-scoped error
      // handling: one torn-down socket must not take the daemon down.
      try {
        res.write(frame)
      } catch {
        set.delete(res)
      }
    }
  }
  const tagged = `event: ${event}\ndata: ${JSON.stringify({ key, ...payload })}\n\n`
  for (const [res, counts] of globalClients) {
    if (!counts.has(key)) continue
    try {
      res.write(tagged)
    } catch {
      globalClients.delete(res)
    }
  }
}

// Pings bypass broadcast(): they are keepalive, not board state, so they
// must not bump eventSeqs — and each client gets exactly one frame.
setInterval(() => {
  const frame = `event: ping\ndata: {}\n\n`
  for (const set of sseClients.values()) {
    for (const res of set) {
      try {
        res.write(frame)
      } catch {
        set.delete(res)
      }
    }
  }
  for (const res of globalClients.keys()) {
    try {
      res.write(frame)
    } catch {
      globalClients.delete(res)
    }
  }
}, 25000).unref()

// ---------------------------------------------------------------- config + auto-open

const CONFIG_PATH = join(DATA_DIR, 'config.json')

// Cached so the auto-open path needs no await: a file read there would let two
// triggers interleave between the cooldown check and its update, and both spawn.
let configCache = {}

async function loadConfig() {
  try {
    configCache = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch {
    configCache = {}
  }
  return configCache
}

async function writeConfig(patch) {
  const next = { ...configCache, ...patch }
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2))
  configCache = next
  return next
}

const autoOpenLast = new Map() // key -> ts of last spawn
const AUTO_OPEN_COOLDOWN_MS = Number(process.env.EASEL_AUTO_OPEN_COOLDOWN_MS || 15000)

// Off by default; a burst of publishes opens at most one tab per cooldown, and a
// a board someone is already viewing never opens.
function maybeAutoOpen(key) {
  if (configCache.autoOpen !== true) return
  if ((sseClients.get(key)?.size ?? 0) > 0 || globalTabCount(key) > 0) return
  const lastAt = autoOpenLast.get(key) ?? 0
  if (Date.now() - lastAt < AUTO_OPEN_COOLDOWN_MS) return
  autoOpenLast.set(key, Date.now())
  try {
    const child = spawn(process.env.EASEL_OPEN_CMD || 'open', [`http://127.0.0.1:${PORT}/b/${key}`], {
      stdio: 'ignore',
      detached: true,
    })
    // spawn reports a missing binary via the async error event; unhandled it kills the daemon.
    child.on('error', (err) => console.error(`auto-open failed: ${err.message}`))
    child.unref()
  } catch {}
}

// ---------------------------------------------------------------- await waiters

const waiters = new Map() // key -> Set<waiter>

// A window expiring empties the set until the CLI re-attaches; that gap is not
// the agent leaving, so the board stays logically waiting across it.
const waitingGrace = new Map() // key -> timer running since the set emptied
const WAITING_GRACE_MS = Number(process.env.EASEL_WAITING_GRACE_MS || 30000)

// A window that expired and was never re-attached: the listener is gone without
// having cancelled or collected, which is a dead agent rather than a finished one.
const lostListeners = new Map() // key -> { agent, at }

function agentWaiting(key) {
  return (waiters.get(key)?.size ?? 0) > 0 || waitingGrace.has(key)
}

function listenerLost(key) {
  return lostListeners.get(key) ?? null
}

function clearLost(key) {
  if (lostListeners.delete(key)) broadcast(key, 'agent', { lost: null })
}

function endGrace(key) {
  const timer = waitingGrace.get(key)
  if (!timer) return false
  clearTimeout(timer)
  waitingGrace.delete(key)
  return true
}

// One waiter per (board, agent): a new attach supersedes the old one.
// The old one is found before the new joins, and resolves after — so the set
// never empties mid-swap and agentWaiting only broadcasts on a true edge.
function addWaiter(key, waiter) {
  if (!waiters.has(key)) waiters.set(key, new Set())
  const set = waiters.get(key)
  const wasEmpty = set.size === 0
  const reattach = endGrace(key)
  clearLost(key)
  const old = [...set].find((w) => w.agent === waiter.agent)
  set.add(waiter)
  if (old) old.supersede()
  if (wasEmpty && !reattach) {
    broadcast(key, 'agent', { waiting: true })
    // Grace covers an in-process re-attach; the flag covers one that outlived it.
    // An agent that collects a reply and waits again is asking about a round the
    // reader has already read; a tab there shows them nothing they have not seen.
    if (!waiter.resumed && store.hasUnseenRound(key)) maybeAutoOpen(key)
  }
}

// grace is for the expiry path only: the server ended that window, so the CLI is
// about to re-attach. A dropped socket or a cancel is the agent actually gone.
function removeWaiter(key, waiter, grace = false) {
  const set = waiters.get(key)
  if (!set) return
  set.delete(waiter)
  if (set.size !== 0) return
  waiters.delete(key)
  if (!grace) {
    broadcast(key, 'agent', { waiting: false })
    return
  }
  if (waitingGrace.has(key)) return
  const timer = setTimeout(() => {
    waitingGrace.delete(key)
    // Nothing re-attached inside the window, so this listener died mid-wait.
    lostListeners.set(key, { agent: waiter.agent, at: now() })
    broadcast(key, 'agent', { waiting: false, lost: waiter.agent })
  }, WAITING_GRACE_MS)
  timer.unref?.()
  waitingGrace.set(key, timer)
}

// Cancel and end are the agent deliberately leaving — no re-attach is coming, so
// the wait ends now instead of lingering for the grace window.
function clearWaitingNow(key) {
  clearLost(key)
  if (endGrace(key)) broadcast(key, 'agent', { waiting: false })
}

function wakeWaiters(key) {
  for (const waiter of [...(waiters.get(key) ?? [])]) waiter.check()
}

function cancelWaiters(key) {
  const set = [...(waiters.get(key) ?? [])]
  for (const waiter of set) waiter.cancel()
  clearWaitingNow(key)
  return set.length
}

// Publish drops the publisher's own parked waiter synchronously — the exit lands
// in-turn, never as a wake after the agent stops. Other agents are untouched.
function dropAgentWaiter(key, agent) {
  if (!agent) return false
  const waiter = [...(waiters.get(key) ?? [])].find((w) => w.agent === agent)
  if (!waiter) return false
  waiter.drop()
  return true
}

// ---------------------------------------------------------------- file watching

const watchers = new Map() // key -> FSWatcher[]
const wipTimers = new Map()

/** Returns false when any path could not be watched — that board loses live WIP. */
function watchBoard(board) {
  unwatchBoard(board.key)
  const paths = [board.file, board.data_file].filter(Boolean)
  const list = []
  let ok = true
  for (const p of paths) {
    try {
      const w = watch(dirname(p), (eventType, filename) => {
        if (filename && filename !== basename(p)) return
        clearTimeout(wipTimers.get(board.key))
        wipTimers.set(board.key, setTimeout(() => rebuildWip(board.key), 150))
      })
      list.push(w)
    } catch (err) {
      ok = false
      console.error(`watch failed for ${p}: ${err.message}`)
    }
  }
  watchers.set(board.key, list)
  return ok
}

function unwatchBoard(key) {
  for (const w of watchers.get(key) ?? []) w.close()
  watchers.delete(key)
  clearTimeout(wipTimers.get(key))
  wipTimers.delete(key)
}

async function rebuildWip(key) {
  const board = store.board(key)
  if (!board || board.status !== 'open') return
  let rendered
  try {
    rendered = await renderSource(board)
  } catch (err) {
    console.error(`wip render failed for ${key}: ${err.message}`)
    return
  }
  const last = store.lastRound(key)
  const { html: hostHtml, islands } = extractIslands(rendered.html)
  // Carry sids onto WIP so annotation anchors keep working pre-publish.
  const { html: sidHtml } = annotateAndDiff(hostHtml, last?.html ?? null)
  // An island-only edit leaves the host html identical — compare payloads too.
  const sameIslands =
    JSON.stringify(islands ?? []) === JSON.stringify(store.roundIslands(key, last?.seq) ?? [])
  if (last && sidHtml === last.html && sameIslands) {
    store.setWip(key, null)
  } else {
    store.setWip(key, sidHtml, rendered.diagrams, islands)
  }
  broadcast(key, 'wip', { updatedAt: store.board(key)?.wip_updated_at ?? null })
}

// ---------------------------------------------------------------- http plumbing

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function requireBoard(key, res) {
  const board = store.board(key)
  if (!board) json(res, 404, { error: `no board: ${key}` })
  return board
}

/* Every write path a browser or agent can reach. `await` 409s on a non-open
   board, so anything accepted here would be stored where nothing collects it. */
/* 409 already means "board ended" on these routes, so the conflict carries a
   code the chrome can branch on instead of reading the message. */
function whiteboardConflict(res, key, index) {
  json(res, 409, {
    error: 'whiteboard changed since you loaded it',
    code: 'whiteboard_conflict',
    whiteboard: store.whiteboard(key, index),
  })
}

function requireOpenBoard(key, res) {
  const board = requireBoard(key, res)
  if (!board) return null
  if (board.status !== 'open') {
    json(res, 409, { error: `board ${board.status}` })
    return null
  }
  return board
}

// ---------------------------------------------------------------- pages

/* The gate hides an empty #sf-content until client.js has painted it. Its
   reveal path is inline so a client.js that never loads cannot strand a reader. */
const GATE_MAX_HOLD_MS = 4000

/* Revealing would only expose an empty <main>, so the gate says what happened
   instead of pretending the page loaded. */
const GATE_NOSCRIPT =
  `<noscript><style>.sf-gate-show{display:none}` +
  `.sf-gate-copy::after{content:" This board needs JavaScript to render its content."}` +
  `</style></noscript>`

const GATE_SCRIPT =
  `<script>(function(){var b=document.body;` +
  `function stalled(){var c=b.querySelector(".sf-gate-card");c.classList.add("sf-gate-stalled");` +
  `c.querySelector(".sf-gate-title").textContent="This board did not load.";` +
  `c.querySelector(".sf-gate-copy").textContent="The page never received its content. Reload, or check that the daemon is still running.";` +
  `var s=c.querySelector(".sf-gate-show");s.textContent="Reload";s.onclick=function(){location.reload()}}` +
  `function reveal(reason){if(!b.classList.contains("sf-gated"))return;` +
  `var m=document.getElementById("sf-content");` +
  `if(reason==="timeout"&&m&&!m.firstChild){stalled();return}` +
  `clearTimeout(b.__sfGateTimer);b.classList.remove("sf-gated");` +
  `if(reason)b.dataset.gateForced=reason;` +
  `window.dispatchEvent(new CustomEvent("sf-gate-revealed",{detail:{reason:reason||""}}))}` +
  `window.__sfRevealGate=reveal;` +
  `b.__sfGateTimer=setTimeout(function(){reveal("timeout")},${GATE_MAX_HOLD_MS});` +
  `b.querySelector(".sf-gate-show").onclick=function(){reveal("manual")}})()</script>`

const THEME_SCRIPT =
  `<script>(function(){var p=new URLSearchParams(location.search).get("theme")` +
  `||localStorage.getItem("sf-theme-family");` +
  `var m=matchMedia("(prefers-color-scheme: dark)");` +
  `function sync(){var o=localStorage.getItem("sf-theme");` +
  `var mode=o==="light"||o==="dark"?o:m.matches?"dark":"light";` +
  `document.documentElement.dataset.theme=p?p+"-"+mode:mode}` +
  `sync();m.addEventListener("change",sync);` +
  `var w=localStorage.getItem("sf-width");` +
  `if(w)document.documentElement.style.setProperty("--content-max",w+"px")})()</script>`

function shellPage(board) {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(board.title || basename(board.file || '') || board.key)}</title>
${THEME_SCRIPT}
<link rel="stylesheet" href="/assets/easel.css">
${GATE_NOSCRIPT}
</head>
<body class="sf-shell sf-gated" data-key="${esc(board.key)}">
<div class="sf-gate">
  <div class="sf-gate-card">
    <div class="sf-gate-title">Checking layout.<br>One moment.</div>
    <div class="sf-gate-copy">Waiting for the board to finish rendering before revealing it.</div>
    <button type="button" class="sf-gate-show">Show anyway</button>
  </div>
</div>
<div id="sf-chrome"></div>
<main id="sf-content"></main>
${GATE_SCRIPT}
<script type="module" src="/assets/client.js"></script>
</body>
</html>`
}

// Client-rendered on a 2s visible-tab poll: title count + favicon dot must track waiting agents without a reload.
function indexPage() {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>easel sessions</title>${THEME_SCRIPT}
<link id="favicon" rel="icon" href="">
<style>
html[data-theme$="light"]{color-scheme:light}html[data-theme$="dark"]{color-scheme:dark}body{margin:0;font:14px/1.5 -apple-system,system-ui,sans-serif;padding:32px 20px;background:Canvas;color:CanvasText}
.wrap{max-width:820px;margin:0 auto}h1{font-size:18px;margin:0 0 16px}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.autoopen{font-size:12px;opacity:.85;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.row{display:flex;align-items:center;gap:10px;padding:10px 14px;margin:6px 0;border-radius:10px;background:color-mix(in srgb,CanvasText 5%,Canvas)}
.row.ended,.row.archived{opacity:.55}
.dot{width:8px;height:8px;border-radius:50%;background:#8a8a90;flex:none}.dot.live{background:#3fb950}
.dot.waiting{background:#e3a008;animation:pulse 1.6s ease-in-out infinite}
.dot.lost{background:#f85149}
@keyframes pulse{50%{opacity:.35}}
.name{font-weight:500;color:inherit;text-decoration:none}.name:hover{text-decoration:underline}
.badge{font-size:10px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:99px;background:color-mix(in srgb,#e3a008 18%,Canvas);color:#b45309;flex:none}
html[data-theme$="dark"] .badge{color:#fbbf24}
.badge.lost{background:color-mix(in srgb,#f85149 18%,Canvas);color:#b62324}
html[data-theme$="dark"] .badge.lost{color:#ff7b72}
.stale{margin:0 0 12px;padding:8px 12px;border-radius:8px;font-size:12px;background:color-mix(in srgb,#e3a008 14%,Canvas)}
.file{flex:1;font:11px ui-monospace,monospace;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.state{font-size:11px;opacity:.7}
.legend{display:flex;flex-wrap:wrap;gap:4px 18px;margin:2px 0 10px;font-size:11px;opacity:.65}
.legend span{display:flex;align-items:center;gap:6px}
#pager{display:flex;align-items:center;justify-content:center;gap:14px;margin:14px 0 0;font-size:12px;opacity:.8}
#pager button{font:inherit;padding:5px 10px;border-radius:8px;cursor:pointer;border:1px solid color-mix(in srgb,CanvasText 18%,Canvas);background:color-mix(in srgb,CanvasText 5%,Canvas);color:inherit}
#pager button:disabled{opacity:.4;cursor:default}
</style></head>
<body><div class="wrap">
<div class="top"><h1>easel sessions <span id="count"></span></h1>
<label class="autoopen"><input type="checkbox" id="autoopen">Auto-open waiting boards</label></div>
<div class="legend">
<span><i class="dot waiting"></i>waiting — an agent is blocked on your feedback</span>
<span><i class="dot live"></i>live — open in a tab right now</span>
<span><i class="dot lost"></i>listener lost — the agent stopped waiting without collecting</span>
<span><i class="dot"></i>open — idle session</span>
<span><i class="dot" style="opacity:.4"></i>ended — closed, still readable</span>
</div>
<div id="stale"></div>
<div id="rows"><p>Loading…</p></div>
<div id="pager"></div>
</div>
<script>
const favicon = (waiting) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="' + (waiting ? '%23e3a008' : '%238a8a90') + '"/></svg>'
  document.getElementById('favicon').href = 'data:image/svg+xml,' + svg
}
function basename(p) { return (p || '').split('/').pop() }
function render(d) {
  const boards = d.boards
  const rows = document.getElementById('rows')
  rows.replaceChildren()
  for (const s of boards) {
    const state = s.agentWaiting ? 'waiting' : s.listenerLost ? 'lost' : s.connectedTabs ? 'live' : s.status
    const row = document.createElement('div')
    row.className = 'row ' + (s.status === 'open' ? state : s.status)
    const dot = document.createElement('span')
    dot.className = 'dot ' + state
    const name = document.createElement('a')
    name.className = 'name'
    name.href = '/b/' + encodeURIComponent(s.key)
    name.textContent = s.title || basename(s.file) || s.key
    row.append(dot, name)
    if (s.agentWaiting) {
      const b = document.createElement('span')
      b.className = 'badge'
      b.textContent = 'agent waiting'
      row.appendChild(b)
    } else if (s.listenerLost) {
      const b = document.createElement('span')
      b.className = 'badge lost'
      b.textContent = 'listener lost · ' + s.listenerLost.agent
      row.appendChild(b)
    }
    const file = document.createElement('span')
    file.className = 'file'
    file.textContent = s.file || (s.template + ':' + basename(s.dataFile))
    const st = document.createElement('span')
    st.className = 'state'
    st.textContent = state
    row.append(file, st)
    rows.appendChild(row)
  }
  if (!boards.length) rows.innerHTML = '<p>No sessions yet.</p>'
  document.getElementById('count').textContent = '(' + d.total + ')'
  document.title = (d.waiting ? '(' + d.waiting + ') ' : '') + 'easel sessions'
  favicon(d.waiting > 0)
  renderPager(d)
}
// Ranked server-side, so a page is the next hundred of one list, not a slice of
// whatever came back. Paging never pauses the poll; the offset just sticks.
function renderPager(d) {
  const el = document.getElementById('pager')
  el.replaceChildren()
  if (d.total <= PAGE) return
  const first = d.offset + 1
  const last = Math.min(d.offset + PAGE, d.total)
  const button = (label, target) => {
    const b = document.createElement('button')
    b.textContent = label
    b.disabled = target == null
    b.onclick = () => { offset = target; tick() }
    return b
  }
  const where = document.createElement('span')
  where.textContent = first + '–' + last + ' of ' + d.total
  el.append(
    button('← Newer', d.offset > 0 ? Math.max(0, d.offset - PAGE) : null),
    where,
    button('Older →', last < d.total ? d.offset + PAGE : null)
  )
}
function renderStale(d) {
  const el = document.getElementById('stale')
  el.replaceChildren()
  if (!d || !d.stale) return
  const p = document.createElement('div')
  p.className = 'stale'
  p.textContent = 'Daemon is running ' + d.commit + ' but the checkout is at ' + d.onDisk + ' — run: easel update'
  el.appendChild(p)
}
const PAGE = 100
let offset = 0
async function tick() {
  try {
    const d = await (await fetch('/api/status?limit=' + PAGE + '&offset=' + offset)).json()
    offset = d.offset
    renderStale(d.daemon)
    render(d)
  } catch {}
}
tick()
setInterval(() => { if (!document.hidden) tick() }, 2000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick() })
const toggle = document.getElementById('autoopen')
fetch('/api/config').then((r) => r.json()).then((c) => { toggle.checked = c.autoOpen === true })
toggle.onchange = () => fetch('/api/config', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ autoOpen: toggle.checked }),
}).catch(() => { toggle.checked = !toggle.checked })
</script>
</body></html>`
}

// ---------------------------------------------------------------- state assembly

function stateFor(board, { clientId, round } = {}) {
  const roundRow = round != null ? store.round(board.key, round) : store.lastRound(board.key)
  if (!roundRow) return null
  const submitted = store.submittedSince(board.key, 0)
  const drafts = clientId ? store.draftsForClient(board.key, clientId) : []
  const feedback = [...submitted, ...drafts].sort((a, b) => a.id - b.id)
  return {
    board: {
      key: board.key,
      title: board.title,
      file: board.file,
      template: board.template,
      status: board.status,
      createdAt: board.created_at,
      updatedAt: board.updated_at,
    },
    currentRound: { seq: roundRow.seq, note: roundRow.note, publishedAt: roundRow.published_at, html: roundRow.html },
    rounds: store.rounds(board.key),
    wip: board.wip_html && round == null ? { html: board.wip_html, updatedAt: board.wip_updated_at } : null,
    diff: roundRow.diff_json ? JSON.parse(roundRow.diff_json) : null,
    feedback,
    chat: store.chatFor(board.key),
    agentWaiting: agentWaiting(board.key),
    audit: board.audit_json ? JSON.parse(board.audit_json) : { findings: [], at: null },
  }
}

// ---------------------------------------------------------------- handlers

/** Every template's data names the board; without --title the index fell back to
    the key, which names nothing. Unreadable or titleless data is not an error here. */
async function titleFromData(path) {
  try {
    const title = JSON.parse(await readFile(path, 'utf8'))?.title
    return typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : null
  } catch {
    return null
  }
}

async function handleOpen(req, res) {
  const body = await readBody(req)
  const { file, template, data, title } = body
  if (!file && !template) return json(res, 400, { error: 'need file or template' })
  if (template && !TEMPLATES.has(template)) return json(res, 400, { error: `unknown template: ${template}` })
  if (template && !data) return json(res, 400, { error: `template ${template} needs data` })
  // Contract: file boards are html, template data is json. Anything else is
  // stored verbatim as round html — no sids, no diffs, silent degradation.
  if (file && !/\.html?$/i.test(file)) return json(res, 400, { error: 'file must be .html (see docs/api.md)' })
  if (data && !/\.json$/i.test(data)) return json(res, 400, { error: 'data must be .json (see docs/api.md)' })

  const existing = store.findOpen({ file: file ?? null, template, data_file: data ?? null })
  if (existing) {
    return json(res, 200, { key: existing.key, url: `http://127.0.0.1:${PORT}/b/${existing.key}`, created: false })
  }

  const key = randomBytes(4).toString('hex')
  const board = store.createBoard({
    key,
    title: title ?? (data ? await titleFromData(data) : null),
    file: file ?? null,
    template: template ?? null,
    data_file: data ?? null,
  })
  let rendered
  try {
    rendered = await renderSource(board)
  } catch (err) {
    store.setStatus(key, 'archived')
    return json(res, 422, { error: `render failed: ${err.message}` })
  }
  const { html: hostHtml, islands } = extractIslands(rendered.html)
  const { html: sidHtml } = annotateAndDiff(hostHtml)
  const audit = auditHtml(sidHtml)
  store.addRound(key, 1, sidHtml, null, null, audit, rendered.diagrams, islands)
  store.setAudit(key, audit)
  watchBoard(board)
  json(res, 200, { key, url: `http://127.0.0.1:${PORT}/b/${key}`, created: true })
}

async function handlePublish(req, res, match) {
  const board = requireBoard(match[1], res)
  if (!board) return
  if (board.status !== 'open') return json(res, 409, { error: `board is ${board.status}` })
  const body = await readBody(req)
  let rendered
  try {
    rendered = await renderSource(board)
  } catch (err) {
    return json(res, 422, { error: `render failed: ${err.message}` })
  }
  // Boards opened before the data title was read stay nameless otherwise, and a
  // source that gains a title should get to use it.
  if (board.data_file && !board.title) {
    const fromData = await titleFromData(board.data_file)
    if (fromData) store.fillTitle(board.key, fromData)
  }
  const last = store.lastRound(board.key)
  const { html: hostHtml, islands } = extractIslands(rendered.html)
  const { html: sidHtml, diff } = annotateAndDiff(hostHtml, last?.html ?? null)
  const seq = (last?.seq ?? 0) + 1
  const audit = auditHtml(sidHtml)
  store.addRound(board.key, seq, sidHtml, body.note ?? null, diff, audit, rendered.diagrams, islands)
  store.setAudit(board.key, audit)
  store.setWip(board.key, null)
  broadcast(board.key, 'round', { seq })
  maybeAutoOpen(board.key)
  const listenerDropped = dropAgentWaiter(board.key, body.agent)
  json(res, 200, { round: seq, listenerDropped, diff: diff ?? { added: [], removed: [], modified: [], moved: [] }, audit })
}

async function handleAwait(req, res, match) {
  // Load-bearing for the CLI's re-attach loop: without this, an attach landing
  // after end parks a waiter for a full window before anything notices.
  const board = requireOpenBoard(match[1], res)
  if (!board) return
  const body = await readBody(req)
  const agent = body.agent
  if (!agent) return json(res, 400, { error: 'agent id required' })
  if (body.ack != null) store.ack(board.key, agent, Number(body.ack))
  const cursor = body.cursor != null ? Number(body.cursor) : store.cursor(board.key, agent)
  const requested = Number(body.timeoutS ?? 600)
  const timeoutS = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 3600) : 600

  const respond = (items, flags = {}) => {
    if (res.destroyed || res.writableEnded) return
    json(res, 200, {
      items: items.map(store.forAgent),
      upto: items.length ? items[items.length - 1].id : cursor,
      cursor,
      timedOut: false,
      cancelled: false,
      superseded: false,
      dropped: false,
      ...flags,
    })
  }

  const initial = store.submittedSince(board.key, cursor)
  if (initial.length) {
    // The fast path must uphold the one-waiter-per-agent invariant too.
    const stale = [...(waiters.get(board.key) ?? [])].find((w) => w.agent === agent)
    if (stale) stale.supersede()
    // This re-attach collects and exits rather than parking, so the wait is over.
    clearWaitingNow(board.key)
    return respond(initial)
  }

  const waiter = {
    agent,
    // A re-attach continues a wait that was already running, so it must not read
    // as a fresh one — after a daemon restart every live agent re-attaches at once.
    resumed: body.resumed === true,
    check() {
      const items = store.submittedSince(board.key, cursor)
      if (!items.length) return
      cleanup()
      respond(items)
    },
    cancel() {
      cleanup()
      respond([], { cancelled: true })
    },
    supersede() {
      cleanup()
      respond([], { superseded: true })
    },
    drop() {
      cleanup()
      respond([], { dropped: true })
    },
  }
  const timer = setTimeout(() => {
    cleanup(true)
    respond([], { timedOut: true })
  }, timeoutS * 1000)
  const cleanup = (expired = false) => {
    clearTimeout(timer)
    removeWaiter(board.key, waiter, expired)
  }
  // res, not req: the request stream is fully consumed by now, so its 'close'
  // has already fired; res 'close' fires when the connection actually drops.
  res.on('close', () => cleanup())
  addWaiter(board.key, waiter)
}

const handlers = {
  health: (req, res) => json(res, 200, { ok: true, app: 'easel', ...buildInfo() }),

  index: (req, res) => html(res, 200, indexPage()),

  boardPage(req, res, match) {
    const board = requireBoard(match[1], res)
    if (board) html(res, 200, shellPage(board))
  },

  sse(req, res, match) {
    const board = requireBoard(match[1], res)
    if (!board) return
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    if (!sseClients.has(board.key)) sseClients.set(board.key, new Set())
    sseClients.get(board.key).add(res)
    req.on('close', () => sseClients.get(board.key)?.delete(res))
    const last = store.lastRound(board.key)
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        key: board.key,
        round: last?.seq ?? 0,
        wipAt: board.wip_updated_at ?? null,
        seq: eventSeq(board.key),
        agentWaiting: agentWaiting(board.key),
      })}\n\n`
    )
  },

  // One stream for the whole origin (docs/api.md): a SharedWorker subscribes
  // here so the browser's 6-per-origin connection cap stays unreachable.
  sseGlobal(req, res, match, url) {
    const counts = new Map()
    // Caps keep a hostile keys param from inflating connectedTabs unboundedly.
    for (const raw of (url.searchParams.get('keys') || '').split(',').slice(0, 512)) {
      const key = raw.trim()
      if (key && store.board(key)) counts.set(key, Math.min((counts.get(key) ?? 0) + 1, 32))
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    globalClients.set(res, counts)
    req.on('close', () => globalClients.delete(res))
    const boards = {}
    for (const key of counts.keys()) {
      const last = store.lastRound(key)
      boards[key] = {
        round: last?.seq ?? 0,
        wipAt: store.board(key)?.wip_updated_at ?? null,
        seq: eventSeq(key),
        agentWaiting: agentWaiting(key),
      }
    }
    res.write(`event: hello\ndata: ${JSON.stringify({ boards })}\n\n`)
  },

  state(req, res, match, url) {
    const board = requireBoard(match[1], res)
    if (!board) return
    const round = url.searchParams.get('round')
    const state = stateFor(board, {
      clientId: url.searchParams.get('clientId') || undefined,
      round: round != null ? Number(round) : undefined,
    })
    if (!state) return json(res, 404, { error: 'no such round' })
    // A tab asking for state has the board on screen; auto-open reads this to
    // tell a round nobody has looked at from one already read.
    if (url.searchParams.get('clientId')) store.markViewed(board.key, state.currentRound.seq)
    state.seq = eventSeq(board.key)
    json(res, 200, state)
  },

  open: handleOpen,
  publish: handlePublish,
  await: handleAwait,
  asset: serveAsset,

  async ack(req, res, match) {
    const board = requireBoard(match[1], res)
    if (!board) return
    const body = await readBody(req)
    if (!body.agent || body.upto == null) return json(res, 400, { error: 'agent and upto required' })
    json(res, 200, { cursor: store.ack(board.key, body.agent, Number(body.upto)) })
  },

  feedbackReplay(req, res, match, url) {
    const board = requireBoard(match[1], res)
    if (!board) return
    const since = Number(url.searchParams.get('since') ?? 0)
    json(res, 200, { items: store.submittedSince(board.key, since).map(store.forAgent) })
  },

  async feedbackCreate(req, res, match) {
    const board = requireOpenBoard(match[1], res)
    if (!board) return
    const body = await readBody(req)
    const { clientId, round, anchor, comment } = body
    if (!clientId || !anchor?.sid || !comment) return json(res, 400, { error: 'clientId, anchor.sid, comment required' })
    const roundRow = round != null ? store.round(board.key, round) : store.lastRound(board.key)
    if (!roundRow) return json(res, 404, { error: `no such round: ${round}` })
    // WIP html only stands in for the LATEST round (that's what the tab shows);
    // a historical round's annotation must excerpt that round, not newer content.
    const latestSeq = store.lastRound(board.key)?.seq
    const source =
      board.wip_html && roundRow?.seq === latestSeq ? board.wip_html : (roundRow?.html ?? '')
    const excerpt = excerptForSid(source, anchor.sid) ?? excerptForSid(roundRow?.html ?? '', anchor.sid)
    // A sid absent from the annotated round would store an unanchorable orphan row.
    if (excerpt == null) return json(res, 400, { error: `no such anchor in round ${roundRow.seq}: ${anchor.sid}` })
    const context = contextForSid(source, anchor.sid) ?? contextForSid(roundRow?.html ?? '', anchor.sid)
    const item = store.addFeedback({
      surface_key: board.key,
      round_seq: roundRow?.seq ?? null,
      kind: 'annotation',
      state: 'draft',
      client_id: clientId,
      sid: anchor.sid,
      quote: anchor.quote ?? null,
      prefix: anchor.prefix ?? null,
      suffix: anchor.suffix ?? null,
      excerpt: excerpt ?? null,
      context_json: context ? JSON.stringify(context) : null,
      comment,
    })
    broadcast(board.key, 'feedback', { id: item.id })
    json(res, 200, item)
  },

  feedbackDelete(req, res, match) {
    const board = requireBoard(match[1], res)
    if (!board) return
    const row = store.feedbackRow(Number(match[2]))
    if (!row || row.surface_key !== board.key) return json(res, 404, { error: 'no such feedback item' })
    if (row.state !== 'draft') return json(res, 409, { error: 'only drafts can be deleted' })
    store.deleteFeedback(row.id)
    broadcast(board.key, 'feedback', { id: row.id })
    json(res, 200, { deleted: true })
  },

  async send(req, res, match) {
    const board = requireOpenBoard(match[1], res)
    if (!board) return
    const body = await readBody(req)
    if (!body.clientId) return json(res, 400, { error: 'clientId required' })
    const submitted = store.submitDrafts(board.key, body.clientId)
    if (submitted.length) {
      wakeWaiters(board.key)
      broadcast(board.key, 'feedback', { id: submitted[submitted.length - 1] })
    }
    json(res, 200, { submitted })
  },

  // Widget clicks queue as drafts like every other feedback — nothing reaches
  // the agent until Send. A reclick replaces the live draft.
  async widget(req, res, match) {
    const board = requireOpenBoard(match[1], res)
    if (!board) return
    const body = await readBody(req)
    const { clientId, round, widgetId, value, sid } = body
    if (!clientId) return json(res, 400, { error: 'clientId required' })
    if (!widgetId || value == null) return json(res, 400, { error: 'widgetId and value required' })
    const roundRow = round != null ? store.round(board.key, round) : store.lastRound(board.key)
    if (!roundRow) return json(res, 404, { error: `no such round: ${round}` })
    const context = sid ? contextForSid(roundRow?.html ?? '', sid) : null
    const item = store.upsertWidgetDraft({
      surface_key: board.key,
      round_seq: roundRow?.seq ?? null,
      client_id: clientId,
      sid: sid ?? null,
      excerpt: sid ? excerptForSid(roundRow?.html ?? '', sid) : null,
      context_json: context ? JSON.stringify(context) : null,
      widget_id: widgetId,
      widget_value: String(value),
    })
    broadcast(board.key, 'feedback', { id: item.id })
    json(res, 200, item)
  },

  async chat(req, res, match) {
    const board = requireOpenBoard(match[1], res)
    if (!board) return
    const body = await readBody(req)
    if (!body.text) return json(res, 400, { error: 'text required' })
    // Drafts flip before the chat row is added, so one wake delivers one batch
    // with the chat last — the agent never reads "see my feedback" feedback-less.
    const submitted = body.withDrafts && body.clientId ? store.submitDrafts(board.key, body.clientId) : []
    const id = store.addChat(board.key, 'user', body.text)
    store.addFeedback({
      surface_key: board.key,
      round_seq: store.lastRound(board.key)?.seq ?? null,
      kind: 'chat',
      state: 'submitted',
      client_id: body.clientId ?? null,
      text: body.text,
      submitted_at: now(),
    })
    wakeWaiters(board.key)
    if (submitted.length) broadcast(board.key, 'feedback', { id: submitted[submitted.length - 1] })
    broadcast(board.key, 'chat', { id })
    json(res, 200, { id, submitted })
  },

  async reply(req, res, match) {
    const board = requireBoard(match[1], res)
    if (!board) return
    const body = await readBody(req)
    if (!body.text) return json(res, 400, { error: 'text required' })
    if (body.agent != null && typeof body.agent !== 'string') {
      return json(res, 400, { error: 'agent must be a string' })
    }
    const id = store.addChat(board.key, 'agent', body.text, body.agent ?? null)
    broadcast(board.key, 'chat', { id })
    json(res, 200, { id })
  },

  cancelWaiting(req, res, match) {
    const board = requireBoard(match[1], res)
    if (!board) return
    json(res, 200, { cancelled: cancelWaiters(board.key) })
  },

  // Paginated only when asked: the CLI and `easel status` still want every board.
  // Ranked here rather than in the page, or a slice would be an arbitrary hundred.
  statusAll(req, res, match, url) {
    const rounds = store.roundCounts()
    const all = store.allBoards().map((s) => statusRow(s, rounds.get(s.key) ?? 0))
    all.sort((a, b) => statusRank(a) - statusRank(b) || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    const total = all.length
    const waiting = all.filter((r) => r.agentWaiting).length
    const limit = positiveInt(url.searchParams.get('limit'))
    const offset = Math.min(positiveInt(url.searchParams.get('offset')) ?? 0, Math.max(0, total - 1))
    const boards = limit == null ? all : all.slice(offset, offset + limit)
    json(res, 200, { daemon: buildInfo(), boards, total, waiting, offset, limit: limit ?? null })
  },

  async config(req, res) {
    if (req.method === 'GET') return json(res, 200, await loadConfig())
    const body = await readBody(req)
    if (typeof body.autoOpen !== 'boolean') return json(res, 400, { error: 'autoOpen boolean required' })
    json(res, 200, await writeConfig({ autoOpen: body.autoOpen }))
  },

  statusOne(req, res, match) {
    const board = requireBoard(match[1], res)
    if (!board) return
    json(res, 200, {
      ...statusRow(board),
      connectedTabs: (sseClients.get(board.key)?.size ?? 0) + globalTabCount(board.key),
      daemon: buildInfo(),
    })
  },

  async end(req, res, match) {
    const board = requireBoard(match[1], res)
    if (!board) return
    const body = await readBody(req)
    if (body.reopen) {
      store.setStatus(board.key, 'open')
      watchBoard(store.board(board.key))
      return json(res, 200, { status: 'open' })
    }
    store.setStatus(board.key, 'ended')
    unwatchBoard(board.key)
    cancelWaiters(board.key)
    broadcast(board.key, 'end', {})
    json(res, 200, { status: 'ended' })
  },

  async gc(req, res) {
    const body = await readBody(req)
    const days = Number(body.olderThanDays ?? 7)
    if (!Number.isFinite(days) || days <= 0) return json(res, 400, { error: 'olderThanDays must be positive' })
    json(res, 200, { archived: store.gc(days) })
  },

  /* gc archives (status flip, reclaims nothing); purge deletes: every row of
     every board untouched past the cutoff, plus its scene files on disk. */
  async purge(req, res) {
    const body = await readBody(req)
    const days = Number(body.olderThanDays ?? 30)
    if (!Number.isFinite(days) || days <= 0) return json(res, 400, { error: 'olderThanDays must be positive' })
    const keys = store.purge(days)
    for (const key of keys) {
      cancelWaiters(key)
      unwatchBoard(key)
    }
    // Scenes sweep by surviving keys: an rm that failed on a past purge left an
    // orphan with no DB row, so the sweep — not the purge list — must find it.
    const alive = new Set(store.boardKeys())
    const sceneCleanupFailed = []
    for (const entry of await readdir(SCENES_DIR).catch(() => [])) {
      if (alive.has(entry)) continue
      try {
        await rm(join(SCENES_DIR, entry), { recursive: true, force: true })
      } catch {
        sceneCleanupFailed.push(entry)
      }
    }
    json(res, 200, { purged: keys.length, keys, ...(sceneCleanupFailed.length ? { sceneCleanupFailed } : {}) })
  },

  whiteboardFrame(req, res, match, url) {
    const key = url.searchParams.get('key') || ''
    const board = store.board(key)
    if (!board) return json(res, 404, { error: `no board: ${key}` })
    if (validIndex(url.searchParams.get('diagramIndex')) == null) {
      return json(res, 400, { error: 'diagramIndex required' })
    }
    const nonce = randomBytes(16).toString('base64')
    const token = mintChannelToken(key)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': whiteboardCsp(nonce),
      'Cache-Control': 'no-store',
    })
    res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Whiteboard</title>
<link rel="stylesheet" href="/whiteboard-assets/whiteboard.css">
<link rel="stylesheet" href="/whiteboard-assets/frame.css">
</head>
<body>
<div id="wb"></div>
<script nonce="${nonce}">window.__easelWhiteboardChannelToken=${JSON.stringify(token)};window.EXCALIDRAW_ASSET_PATH=${JSON.stringify(`${ORIGIN}/whiteboard-assets/`)}</script>
<script nonce="${nonce}" src="/whiteboard-assets/whiteboard.js"></script>
</body>
</html>`)
  },

  islandFrame(req, res, match, url) {
    const key = url.searchParams.get('key') || ''
    const board = store.board(key)
    if (!board) return json(res, 404, { error: `no board: ${key}` })
    const index = validIndex(url.searchParams.get('index'))
    if (index == null) return json(res, 400, { error: 'index required' })
    const roundParam = url.searchParams.get('round')
    const islands = roundParam === 'wip'
      ? store.wipIslands(board.key)
      : store.roundIslands(board.key, roundParam != null ? Number(roundParam) : null)
    const island = islands?.find((i) => i.index === index)
    if (!island) return json(res, 404, { error: `no island ${index}` })
    const nonce = randomBytes(16).toString('base64')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // Island html is author-verbatim: full CSS freedom, zero script (only the
      // nonced resize shim runs), zero network (data: assets only).
      'Content-Security-Policy':
        `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; ` +
        `script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
      'Cache-Control': 'no-store',
    })
    res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(island.title || `Island ${index}`)}</title>
<style>html,body{margin:0;padding:0}</style>
</head>
<body>
${island.html}
<script nonce="${nonce}">
(function(){
  var last = 0
  function report(){
    var h = Math.ceil(document.documentElement.scrollHeight)
    if (h !== last) { last = h; parent.postMessage({ easelIsland: true, index: ${index}, height: h }, '*') }
  }
  new ResizeObserver(report).observe(document.documentElement)
  addEventListener('load', report)
  report()
})()
</script>
</body>
</html>`)
  },

  async whiteboardAsset(req, res, match) {
    const root = resolve(WHITEBOARD_ROOT)
    let full
    try {
      full = resolve(root, decodeURIComponent(match[1]))
    } catch {
      return json(res, 400, { error: 'bad asset path' })
    }
    if (full !== root && !full.startsWith(root + sep)) return json(res, 403, { error: 'forbidden' })
    const type = ASSET_TYPES[full.slice(full.lastIndexOf('.'))] || 'application/octet-stream'
    try {
      const body = await readFile(full)
      // The sandbox gives the frame an opaque origin, so even same-host font
      // and worker fetches are cross-origin and need this.
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' })
      res.end(body)
    } catch {
      json(res, 404, { error: 'whiteboard bundle missing — run npm install' })
    }
  },

  async whiteboardChannel(req, res, match) {
    const board = requireBoard(match[1], res)
    if (!board) return
    const body = await readBody(req)
    if (!consumeChannelToken(String(body.token || ''), board.key)) {
      return json(res, 403, { error: 'bad channel token' })
    }
    json(res, 200, { ok: true })
  },

  whiteboardGet(req, res, match, url) {
    const board = requireBoard(match[1], res)
    if (!board) return
    const index = validIndex(match[2])
    if (index == null) return json(res, 400, { error: 'bad diagram index' })
    const diagrams = diagramsFor(board, url.searchParams.get('round'))
    const diagram = diagrams?.find((d) => d.index === index) ?? null
    const saved = store.whiteboard(board.key, index)
    // A scene drawn against a different source is never dropped or re-seeded;
    // it comes back flagged so the frame can say so and keep the drawing.
    const stale = Boolean(saved && diagram && saved.sourceHash && saved.sourceHash !== diagram.hash)
    json(res, 200, {
      whiteboard: saved,
      source: diagram?.source ?? null,
      sourceHash: diagram?.hash ?? null,
      stale,
      reason: diagram
        ? null
        : diagrams
          ? 'no diagram at this index in the round on screen'
          : 'this round was published before diagram sources were stored — starting blank',
    })
  },

  async whiteboardPut(req, res, match) {
    const board = requireOpenBoard(match[1], res)
    if (!board) return
    const index = validIndex(match[2])
    if (index == null) return json(res, 400, { error: 'bad diagram index' })
    const body = await readBody(req, MAX_SCENE_BYTES)
    if (!body.scene || typeof body.scene !== 'object') return json(res, 400, { error: 'scene required' })
    if (!Number.isInteger(body.baseVersion)) return json(res, 400, { error: 'baseVersion required' })
    const saved = store.saveWhiteboard(board.key, index, body.scene, body.sourceHash ?? null, body.baseVersion)
    if (!saved) return whiteboardConflict(res, board.key, index)
    json(res, 200, { whiteboard: saved })
  },

  async whiteboardFeedback(req, res, match) {
    const board = requireOpenBoard(match[1], res)
    if (!board) return
    const index = validIndex(match[2])
    if (index == null) return json(res, 400, { error: 'bad diagram index' })
    const body = await readBody(req, MAX_SCENE_BYTES)
    if (!body.clientId) return json(res, 400, { error: 'clientId required' })
    if (!body.scene || typeof body.scene !== 'object') return json(res, 400, { error: 'scene required' })
    if (!Number.isInteger(body.baseVersion)) return json(res, 400, { error: 'baseVersion required' })

    // Send is a write like any other: without this it was the way round the guard.
    const saved = store.saveWhiteboard(board.key, index, body.scene, body.sourceHash ?? null, body.baseVersion)
    if (!saved) return whiteboardConflict(res, board.key, index)
    const dir = join(SCENES_DIR, board.key, String(index))
    await mkdir(dir, { recursive: true })
    // Each send is an immutable snapshot: a later send of the same diagram must
    // not rewrite the files an already-queued item points at.
    const stamp = randomBytes(6).toString('hex')
    const scenePath = join(dir, `scene-${stamp}.excalidraw`)
    await writeFile(scenePath, JSON.stringify(body.scene, null, 2), 'utf8')
    const svg = await sceneSvg(body.scene)
    const svgPath = svg ? join(dir, `scene-${stamp}.svg`) : null
    if (svg) await writeFile(svgPath, svg, 'utf8')

    const summary = Array.isArray(body.summaryLines)
      ? body.summaryLines.filter((l) => typeof l === 'string').slice(0, 50).map((l) => l.slice(0, 300)).join('\n')
      : ''
    const item = store.addFeedback({
      surface_key: board.key,
      round_seq: store.lastRound(board.key)?.seq ?? null,
      kind: 'whiteboard',
      state: 'draft',
      client_id: body.clientId,
      excerpt: summary || null,
      comment: String(body.note || '').slice(0, 4000) || null,
      payload_json: JSON.stringify({
        diagramIndex: index,
        scenePath,
        svgPath,
        svgError: svg ? null : 'scene could not be rendered to SVG',
        sourceHash: body.sourceHash ?? null,
        summary,
      }),
    })
    broadcast(board.key, 'feedback', { id: item.id })
    // The send wrote the scene too, so the tab is told where the version got to.
    json(res, 200, { ...item, whiteboardVersion: saved.version })
  },
}

const ASSET_TYPES = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

function statusRow(s, roundCount = null) {
  const unacked = {}
  for (const c of store.cursorsFor(s.key)) {
    unacked[c.agent_id] = store.submittedSince(s.key, c.acked_upto).length
  }
  return {
    key: s.key,
    title: s.title,
    file: s.file,
    dataFile: s.data_file,
    template: s.template,
    status: s.status,
    rounds: roundCount ?? store.rounds(s.key).length,
    unacked,
    updatedAt: s.updated_at,
    agentWaiting: agentWaiting(s.key),
    listenerLost: listenerLost(s.key),
    connectedTabs: (sseClients.get(s.key)?.size ?? 0) + globalTabCount(s.key),
  }
}

// ---------------------------------------------------------------- whiteboard

const WHITEBOARD_ROOT = join(ROOT, '..', 'render', '.gen', 'whiteboard')
const SCENES_DIR = join(DATA_DIR, 'whiteboards')
const ORIGIN = `http://127.0.0.1:${PORT}`
const CHANNEL_TTL_MS = 5 * 60 * 1000
const channelTokens = new Map() // token -> { key, at }

function mintChannelToken(key) {
  const cutoff = Date.now() - CHANNEL_TTL_MS
  for (const [t, e] of channelTokens) if (e.at < cutoff) channelTokens.delete(t)
  const token = randomBytes(24).toString('hex')
  channelTokens.set(token, { key, at: Date.now() })
  return token
}

// Single use: the frame proves once that its page came from us, and a replayed
// token cannot open a second channel.
function consumeChannelToken(token, key) {
  const entry = channelTokens.get(token)
  if (!entry || entry.key !== key || Date.now() - entry.at > CHANNEL_TTL_MS) return false
  channelTokens.delete(token)
  return true
}

// Sandboxed frame: the origin is opaque, so 'self' matches nothing and every
// source is named. Excalidraw's esm.sh fallback matches no directive here.
function whiteboardCsp(nonce) {
  return [
    `default-src 'none'`,
    `script-src ${ORIGIN} 'nonce-${nonce}'`,
    `style-src ${ORIGIN} 'unsafe-inline'`,
    `font-src ${ORIGIN} data:`,
    `img-src ${ORIGIN} data: blob:`,
    `connect-src ${ORIGIN} data: blob:`,
    `worker-src blob: data:`,
    `frame-ancestors ${ORIGIN}`,
  ].join('; ')
}

const validIndex = (value) => {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null
}

/** null for absent or nonsense, so a bad ?limit= reads as "no pagination". */
const positiveInt = (value) => {
  const n = Number(value)
  return value != null && Number.isInteger(n) && n > 0 ? n : null
}

// The index groups by what the reader is looking for: an agent blocked on them
// first, a lost listener next, then live tabs, idle boards, and ended ones last.
const statusRank = (r) =>
  r.agentWaiting ? 0 : r.listenerLost ? 1 : r.connectedTabs ? 2 : r.status === 'open' ? 3 : 4

/** Sources for what the tab is actually showing: WIP when the board has
    unpublished changes, otherwise the round's own. */
function diagramsFor(board, roundParam) {
  if (roundParam != null) return store.roundDiagrams(board.key, Number(roundParam))
  if (board.wip_html) return store.wipDiagrams(board.key)
  return store.roundDiagrams(board.key, null)
}

async function sceneSvg(scene) {
  let converter = null
  try {
    const mod = await import(new URL('../render/excalidraw.js', import.meta.url).href)
    converter = await mod.createConverter({})
    const out = await converter.sceneToSvg(scene)
    return out.ok ? out.svg : null
  } catch {
    return null
  } finally {
    if (converter) await converter.close()
  }
}

// ---------------------------------------------------------------- routing

const ASSETS = {
  'client.js': { path: join(ROOT, '..', 'chrome', 'client.js'), type: 'text/javascript' },
  'events-worker.js': { path: join(ROOT, '..', 'chrome', 'events-worker.js'), type: 'text/javascript' },
  'easel.css': { path: join(ROOT, '..', 'chrome', 'easel.css'), type: 'text/css' },
  'whiteboard-protocol.js': { path: join(ROOT, '..', 'chrome', 'whiteboard-protocol.js'), type: 'text/javascript' },
}

async function serveAsset(req, res, match) {
  const asset = ASSETS[match[1]]
  if (!asset) return json(res, 404, { error: 'no such asset' })
  try {
    const body = await readFile(asset.path)
    // Revalidate on every load: without this, an open review tab heuristically
    // caches chrome CSS/JS and keeps painting the pre-deploy version.
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
      return res.end()
    }
    res.writeHead(200, { 'Content-Type': asset.type, ETag: etag, 'Cache-Control': 'no-cache' })
    res.end(body)
  } catch {
    json(res, 404, { error: `asset missing on disk: ${match[1]}` })
  }
}

// A name with no handler would answer 404 at runtime instead of failing to boot.
const routes = ROUTES.map((route) => {
  const handler = handlers[route.handler]
  if (!handler) throw new Error(`route ${route.method} ${route.pattern} names no handler: ${route.handler}`)
  return { ...route, fn: handler }
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  for (const { method, pattern, fn } of routes) {
    if (req.method !== method) continue
    const match = url.pathname.match(pattern)
    if (!match) continue
    try {
      await fn(req, res, match, url)
    } catch (err) {
      if (!res.headersSent) {
        // The request body may be half-read (e.g. 413) — the socket must not
        // return to the keep-alive pool.
        res.setHeader('Connection', 'close')
        json(res, err instanceof HttpError ? err.status : 500, { error: String(err?.message || err) })
      }
    }
    return
  }
  json(res, 404, { error: `no route: ${req.method} ${url.pathname}` })
})

/* Attached only once the port is bound — fs.watch blocks on a slow directory.
   A board that cannot be watched loses live WIP, nothing more. */
function attachBootWatchers() {
  let watched = 0
  let degraded = 0
  for (const board of store.allBoards()) {
    if (board.status !== 'open' || !(board.file || board.data_file)) continue
    try {
      if (watchBoard(board)) watched++
      else degraded++
    } catch (err) {
      degraded++
      console.error(`watch failed for ${board.key}: ${err.message} — live updates off for this board`)
    }
  }
  console.log(`watching ${watched} board(s)${degraded ? `, ${degraded} degraded` : ''}`)
}

/* launchd appends stdout/stderr to this file forever; truncating by path is
   safe under its O_APPEND fd. Capped, so recent restarts stay debuggable. */
export const LOG_CAP_BYTES = 5 * 1024 * 1024

export async function truncateOversizedLog(path, cap = LOG_CAP_BYTES) {
  try {
    if ((await stat(path)).size > cap) await truncate(path)
  } catch {} // no log file (tests, scratch daemons) — nothing to do
}

// Config is primed before the socket opens, so the first auto-open decision reads
// the persisted setting rather than an empty cache.
await loadConfig()

server.listen(PORT, '127.0.0.1', () => {
  console.log(`easeld ${VERSION} listening on http://127.0.0.1:${PORT}`)
  truncateOversizedLog(join(DATA_DIR, 'daemon.log'))
  setImmediate(attachBootWatchers)
})

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `port ${PORT} already in use — is another easeld (or a placeholder) running?` : err.message)
  process.exit(1)
})

function shutdown() {
  server.close()
  for (const key of watchers.keys()) unwatchBoard(key)
  store.db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
