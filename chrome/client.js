// easel chrome runtime. Owns all sf-* DOM (vocabulary documented in docs/api.md);
// styling lives in easel.css. No framework, no build step.

import { WB } from './whiteboard-protocol.js'

const KEY = document.body.dataset.key
const CONTENT = document.getElementById('sf-content')
const CHROME = document.getElementById('sf-chrome')

const CLIENT_ID_STORAGE = 'sf-client-id'
let clientId = localStorage.getItem(CLIENT_ID_STORAGE)
if (!clientId) {
  clientId = crypto.randomUUID()
  localStorage.setItem(CLIENT_ID_STORAGE, clientId)
}

const api = {
  async get(path) {
    const res = await fetch(path)
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
    return res.json()
  },
  async send(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      // The payload rides along: a 409 conflict is told apart by its code, never
      // by its message text.
      const payload = await res.json().catch(() => ({}))
      const err = new Error(payload.error || res.statusText)
      err.body = payload
      throw err
    }
    return res.json()
  },
}

const QUEUE_HOTKEY = 'f'
const QUEUE_HOTKEY_LABEL = 'press f'
const CHAT_HOTKEY = 'c'
const CHAT_HOTKEY_LABEL = 'press c'
const THEME_HOTKEY = 't'
const ANNOTATE_HOTKEY = 'a'
// 'x', not 'r': E/R are the width nudge pair.
const REMOVED_HOTKEY = 'x'
const ROUND_BACK_HOTKEY = 'q'
const ROUND_FORWARD_HOTKEY = 'w'
const WIDTH_NARROW_HOTKEY = 'e'
const WIDTH_WIDEN_HOTKEY = 'r'
const WIDTH_MIN = 600
const WIDTH_MAX = 1400
const WIDTH_KEY_STEP = 40
const MARKER_HUES = 6
const TABLE_ROW_TAGS = new Set(['TR', 'TABLE', 'THEAD', 'TBODY'])

const state = {
  data: null,          // last /state payload
  viewingRound: null,  // null = follow latest
  annotating: false,
  diffView: true,
  showRemoved: false,
  draftsByKey: new Map(), // anchor key (sid, or sid@x,y for pins) -> draft items, for page-side removal
}

// ---------------------------------------------------------------- chrome DOM

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

// Inline style, not the hidden attribute: easel.css sets explicit display
// on chrome classes, which would override the UA's [hidden] rule.
function show(node, on) {
  node.style.display = on ? '' : 'none'
}

const ui = {}

// The shell's inline THEME_SCRIPT applies the same override before first paint.
const THEME_STORAGE = 'sf-theme'
const FAMILY_STORAGE = 'sf-theme-family'
const LOOK_STORAGE = 'sf-diagram-look'
const WRAP_STORAGE = 'sf-wrap-code'
const WIDTH_STORAGE = 'sf-width'
const THEME_FAMILIES = [
  ['', 'Default'],
  ['lantern', 'Lantern'],
  ['fig', 'Fig'],
]

function themeMode() {
  const stored = localStorage.getItem(THEME_STORAGE)
  return stored === 'light' || stored === 'dark' ? stored : 'auto'
}

// A ?theme= pin names a theme FAMILY and beats the picker; the mode cycle
// still applies within either.
const pinnedTheme = () => new URLSearchParams(location.search).get('theme')

function themeFamily() {
  return pinnedTheme() || localStorage.getItem(FAMILY_STORAGE) || ''
}

function setThemeFamily(fam) {
  if (fam) localStorage.setItem(FAMILY_STORAGE, fam)
  else localStorage.removeItem(FAMILY_STORAGE)
  syncThemeToggle()
  if (wbReady) postToWhiteboard({ type: WB.themeChanged, theme: wbTheme() })
}

function syncThemeToggle() {
  const fam = themeFamily()
  const mode = themeMode()
  const effective =
    mode === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode
  document.documentElement.dataset.theme = fam ? `${fam}-${effective}` : effective
  ui.themeToggle.textContent = `[T]heme: ${mode}`
  for (const btn of ui.themePick?.querySelectorAll('[data-family]') || []) {
    btn.classList.toggle('sf-on', btn.dataset.family === fam)
  }
}

function applyWidth(px) {
  document.documentElement.style.setProperty('--content-max', `${px}px`)
  localStorage.setItem(WIDTH_STORAGE, px)
}

function nudgeWidth(dir) {
  const cur = parseInt(ui.widthSlider.value) || 1040
  const next = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, cur + dir * WIDTH_KEY_STEP))
  ui.widthSlider.value = next
  applyWidth(next)
}

function cycleTheme() {
  const next = { auto: 'light', light: 'dark', dark: 'auto' }[themeMode()]
  if (next === 'auto') localStorage.removeItem(THEME_STORAGE)
  else localStorage.setItem(THEME_STORAGE, next)
  syncThemeToggle()
  if (wbReady) postToWhiteboard({ type: WB.themeChanged, theme: wbTheme() })
}

function buildChrome() {
  CHROME.replaceChildren()

  const topbar = el('div', 'sf-topbar')
  const brand = el('a', 'sf-brand', 'easel')
  brand.href = '/'
  brand.title = 'All sessions'
  ui.themePick = el('div', 'sf-theme-pick')
  for (const [fam, label] of THEME_FAMILIES) {
    const btn = el('button', 'sf-theme-pick-btn', label)
    btn.type = 'button'
    btn.dataset.family = fam
    btn.title = fam ? `${label} theme` : 'The stock theme'
    btn.onclick = () => setThemeFamily(fam)
    ui.themePick.appendChild(btn)
  }
  ui.tunerToggle = el('button', 'sf-tuner-toggle', '⚙')
  ui.tunerToggle.type = 'button'
  ui.tunerToggle.title = 'Tune the theme: colors, fonts, size'
  ui.tunerToggle.onclick = () => toggleTuner()
  ui.themePick.appendChild(ui.tunerToggle)
  ui.title = el('div', 'sf-title')
  ui.wipMarker = el('div', 'sf-wip-marker', 'unpublished changes')
  show(ui.wipMarker, false)
  ui.agent = el('div', 'sf-agent')
  ui.agentLabel = el('span', 'sf-agent-label', '')
  ui.cancelWait = el('button', 'sf-cancel-wait', 'Cancel')
  ui.cancelWait.type = 'button'
  ui.cancelWait.title = 'Stop the agent waiting on this board'
  show(ui.cancelWait, false)
  ui.cancelWait.onclick = () => api.send('POST', `/api/b/${KEY}/cancel-waiting`).catch(() => {})
  ui.agent.append(ui.agentLabel, ui.cancelWait)
  ui.status = el('div', 'sf-status')
  ui.statusDot = el('span', 'sf-status-dot')
  ui.statusLabel = el('span', 'sf-status-label', 'connecting')
  ui.status.append(ui.statusDot, ui.statusLabel)
  ui.themeToggle = el('button', 'sf-theme-toggle')
  ui.themeToggle.type = 'button'
  ui.themeToggle.title = `Cycle theme: auto → light → dark (press ${THEME_HOTKEY})`
  ui.themeToggle.onclick = cycleTheme
  syncThemeToggle()
  ui.widthSlider = el('input', 'sf-width-slider')
  ui.widthSlider.type = 'range'
  ui.widthSlider.min = String(WIDTH_MIN)
  ui.widthSlider.max = String(WIDTH_MAX)
  ui.widthSlider.step = '20'
  ui.widthSlider.title = 'Page width — E narrows, R widens; double-click to reset to the theme default'
  ui.widthSlider.value = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--content-max')) || 1040
  ui.widthSlider.oninput = () => applyWidth(ui.widthSlider.value)
  ui.widthSlider.ondblclick = () => {
    document.documentElement.style.removeProperty('--content-max')
    localStorage.removeItem(WIDTH_STORAGE)
    ui.widthSlider.value = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--content-max')) || 1040
  }
  ui.width = el('span', 'sf-width')
  ui.width.append(el('span', 'sf-width-keys', '[E]'), ui.widthSlider, el('span', 'sf-width-keys', '[R]'))
  ui.annotateToggle = el('button', 'sf-annotate-toggle', '[A]nnotate')
  ui.annotateToggle.type = 'button'
  ui.annotateToggle.title = `Annotate mode (press ${ANNOTATE_HOTKEY})`
  ui.annotateToggle.onclick = () => setAnnotating(!state.annotating)
  // Panel launchers live in the always-visible topbar: the panels themselves are
  // display:none until sf-open, so nothing inside them can be the opener.
  ui.queueToggle = el('button', 'sf-queue-toggle', '[F]eedback')
  ui.queueToggle.type = 'button'
  ui.queueToggle.title = `Feedback panel (${QUEUE_HOTKEY_LABEL})`
  ui.queueToggleCount = el('span', 'sf-queue-count', '0')
  ui.queueToggle.appendChild(ui.queueToggleCount)
  ui.queueToggle.onclick = () => toggleQueue()

  ui.sendNow = el('button', 'sf-send-now', 'Send')
  ui.sendNow.type = 'button'
  ui.sendNow.title = 'Send queued feedback to the agent'
  ui.sendNow.onclick = sendDrafts
  show(ui.sendNow, false)
  ui.chatToggle = el('button', 'sf-chat-toggle', '[C]hat')
  ui.chatToggle.type = 'button'
  ui.chatToggle.title = `Conversation panel (${CHAT_HOTKEY_LABEL})`
  ui.chatToggle.onclick = () => toggleChat()
  ui.endSession = el('button', 'sf-end-session', 'End')
  ui.endSession.type = 'button'
  ui.endSession.title = 'End this board: the agent stops waiting and nothing more can be sent'
  ui.endSession.onclick = endSession

  topbar.append(brand, ui.themePick, ui.title, ui.wipMarker, ui.agent, ui.status, ui.themeToggle, ui.width, ui.annotateToggle, ui.sendNow, ui.queueToggle, ui.chatToggle, ui.endSession)

  ui.rounds = el('div', 'sf-rounds')
  show(ui.rounds, false)

  ui.queue = el('aside', 'sf-queue')
  ui.queueHeader = el('div', 'sf-queue-header', 'Feedback')
  ui.queueCount = el('span', 'sf-queue-count', '0')
  ui.queueHeader.appendChild(ui.queueCount)
  ui.queueHeader.onclick = () => toggleQueue()
  ui.queueList = el('div', 'sf-queue-list')
  ui.queueSend = el('button', 'sf-queue-send', 'Send')
  ui.queueSend.type = 'button'
  ui.queueSend.onclick = sendDrafts
  ui.queue.append(ui.queueHeader, ui.queueList, ui.queueSend)

  ui.chat = el('aside', 'sf-chat')
  const chatHeader = el('div', 'sf-chat-header', 'Conversation')
  chatHeader.onclick = () => toggleChat()
  ui.chatLog = el('div', 'sf-chat-log')
  ui.chatWorking = el('div', 'sf-chat-working')
  ui.chatWorking.append(el('span', 'sf-spinner'), el('span', null, 'Working…'))
  ui.chatCancel = el('button', 'sf-chat-cancel', 'Cancel')
  ui.chatCancel.type = 'button'
  ui.chatCancel.onclick = () => api.send('POST', `/api/b/${KEY}/cancel-waiting`).catch(() => {})
  ui.chatWorking.appendChild(ui.chatCancel)
  show(ui.chatWorking, false)
  ui.chatForm = el('form', 'sf-chat-form')
  ui.chatInput = el('textarea', 'sf-chat-input')
  ui.chatInput.placeholder = 'Message the agent…'
  ui.chatInput.rows = 2
  ui.chatSubmit = el('button', 'sf-chat-submit', 'Send')
  ui.chatSubmit.type = 'submit'
  ui.chatForm.append(ui.chatInput, ui.chatSubmit)
  ui.chatForm.onsubmit = async (e) => {
    e.preventDefault()
    const text = ui.chatInput.value.trim()
    if (!text) return
    ui.chatInput.value = ''
    try {
      // Through the mutation chain (no overtaking an in-flight click); withDrafts is
      // unconditional so a just-queued draft rides along — the server no-ops when empty.
      const res = await enqueueMutation(() => api.send('POST', `/api/b/${KEY}/chat`, { clientId, text, withDrafts: true }))
      if (res.submitted?.length) {
        toast(`Sent chat + ${res.submitted.length} feedback item${res.submitted.length === 1 ? '' : 's'}`)
        sync()
      }
    } catch (err) {
      toast(`Send failed: ${err.message}`)
    }
    show(ui.chatWorking, true)
  }
  submitOnEnter(ui.chatInput, () => ui.chatForm.requestSubmit())
  ui.chat.append(chatHeader, ui.chatLog, ui.chatWorking, ui.chatForm)

  ui.audit = el('div', 'sf-audit')
  ui.auditBadge = el('button', 'sf-audit-badge')
  ui.auditBadge.type = 'button'
  ui.auditBadge.onclick = () => ui.audit.classList.toggle('sf-open')
  ui.auditList = el('div', 'sf-audit-list')
  ui.audit.append(ui.auditBadge, ui.auditList)
  show(ui.audit, false)

  // Not a modal: an ended board stays readable, so this reports the state and
  // the disabled controls enforce it.
  ui.endedBanner = el('div', 'sf-ended-banner', 'This board has ended. Nothing more can be sent to the agent.')
  show(ui.endedBanner, false)

  ui.gateBanner = el('div', 'sf-gate-banner')
  show(ui.gateBanner, false)

  ui.toasts = el('div', 'sf-toasts')

  CHROME.append(topbar, ui.rounds, ui.queue, ui.chat, ui.audit, ui.endedBanner, ui.gateBanner, ui.toasts)

  // The gate can reveal itself before the first render — its safety timeout and
  // its button are inline, so the chrome learns about it from the event.
  window.addEventListener('sf-gate-revealed', (e) => reportForcedReveal(e.detail?.reason))
  if (document.body.dataset.gateForced) reportForcedReveal(document.body.dataset.gateForced)
}

function toast(text) {
  const t = el('div', 'sf-toast', text)
  ui.toasts.appendChild(t)
  setTimeout(() => t.remove(), 4000)
}

// ---------------------------------------------------------------- rendering

let syncSeq = 0

async function sync(round = state.viewingRound) {
  const seq = ++syncSeq
  const qs = new URLSearchParams({ clientId })
  if (round != null) qs.set('round', String(round))
  let data
  try {
    data = await api.get(`/api/b/${KEY}/state?${qs}`)
  } catch (err) {
    toast(`Sync failed: ${err.message}`)
    return
  }
  if (seq !== syncSeq) return // a newer sync superseded this response
  state.data = data
  if (data.seq != null) eventSeq = data.seq
  render()
}

/* Each sync replaces the whole body, resetting every <details> to its authored
   state and moving the page under a reader scrolled past it. */
const readerToggled = new Map() // sid -> the open state the reader chose
const asRendered = new Map()    // sid -> the state this render left it in

/* Only what the reader touched; a later round is free to change the rest. Inserting
   a <details open> fires toggle too — an event matching this render is that echo. */
CONTENT.addEventListener(
  'toggle',
  (e) => {
    if (!(e.target instanceof HTMLDetailsElement)) return
    const sid = e.target.dataset.sid
    if (!sid || asRendered.get(sid) === e.target.open) return
    readerToggled.set(sid, e.target.open)
  },
  true
)

// toggle does not bubble, hence the capture listener above.
function restoreDetails() {
  asRendered.clear()
  for (const d of CONTENT.querySelectorAll('details[data-sid]')) {
    const was = readerToggled.get(d.dataset.sid)
    if (was !== undefined) d.open = was
    asRendered.set(d.dataset.sid, d.open)
  }
}

// Queue boards emit <time data-live-age datetime>; recompute so a long-open
// tab never shows a stale "waiting" age. Publish-time text is the fallback.
function refreshLiveAges() {
  for (const t of CONTENT.querySelectorAll('time[data-live-age]')) {
    const ms = Date.parse(t.getAttribute('datetime') || '')
    if (Number.isNaN(ms)) continue
    const m = Math.floor((Date.now() - ms) / 60000)
    const age = m < 1 ? 'just now' : m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
    t.textContent = `waiting ${age}`
  }
}
setInterval(refreshLiveAges, 30_000)

function render() {
  const d = state.data
  if (!d) return
  ui.title.textContent = d.board.title || d.board.file || d.board.key

  const showWip = d.wip && state.viewingRound == null
  const html = showWip ? d.wip.html : d.currentRound.html
  // Rebuilding on a feedback-only sync would reload every island frame (a flicker
  // per queued note); the key needs round/WIP identity — island-only publishes keep host html identical.
  const contentKey = (showWip ? `wip|${d.wip.updatedAt}` : `r${state.viewingRound ?? d.currentRound.seq}`) + `|${html}`
  const rebuild = state.renderedContentKey !== contentKey
  if (rebuild) {
    CONTENT.innerHTML = html
    state.renderedContentKey = contentKey
    restoreDetails()
    refreshLiveAges()
  }
  CONTENT.classList.toggle('sf-wip', Boolean(showWip))
  show(ui.wipMarker, Boolean(d.wip))

  renderRounds(d)
  if (rebuild && !showWip && state.diffView && d.diff) applyDiff(d.diff)
  // Feedback is tied to the round it was left on; other rounds' items stay out.
  // A draft not yet stamped with a round (null) belongs to the round on screen.
  const roundFeedback = d.feedback.filter((i) => i.round == null || i.round === d.currentRound.seq)
  if (!rebuild) clearAnnotations()
  // Assigns the marker ids the queue rows label themselves with, so it runs first.
  markAnnotated(roundFeedback)
  renderQueue(roundFeedback)
  renderChat(d.chat)
  renderAudit(d.audit)
  resolveGate(d.audit)
  setAgentWaiting(d.agentWaiting)
  // A tab that arrives after the end never sees the `end` event, so status is
  // the only thing that tells it. The server refuses the writes either way.
  // Belt-and-braces, deliberately untested: no second render of an ended
  // board is reachable today, so setEnded()'s own call always suffices.
  if (d.board.status !== 'open') {
    setEnded()
    disableContentControls()
  }
  markRecordedWidgets(roundFeedback)
  if (rebuild) {
    attachWhiteboardButtons()
    attachWrapButtons()
    mountIslands(d, showWip)
  }
}

// Undoes markAnnotated for a marker-only refresh over live content: stale
// markers, pins, and anchor classes go; the html itself stays (frames included).
function clearAnnotations() {
  CONTENT.querySelectorAll('.sf-marker').forEach((m) => m.remove())
  for (const n of CONTENT.querySelectorAll('.sf-annotated, .sf-annotated-col')) {
    n.classList.remove('sf-annotated', 'sf-annotated-col')
    delete n.dataset.markerHue
  }
}

// Islands render in an opaque-origin sandboxed frame: author CSS runs there,
// never on this origin. The frame's nonced shim reports its height.
function mountIslands(d, showWip) {
  for (const node of CONTENT.querySelectorAll('.sd-island[data-island-index]')) {
    const index = Number(node.dataset.islandIndex)
    if (!Number.isInteger(index) || index < 0) continue
    const frame = document.createElement('iframe')
    frame.className = 'sd-island-frame'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.dataset.islandIndex = String(index)
    const round = showWip ? 'wip' : String(state.viewingRound ?? d.currentRound.seq)
    frame.src = `/island-frame?key=${encodeURIComponent(KEY)}&index=${index}&round=${round}`
    const declared = Number(node.dataset.islandHeight)
    frame.style.height = `${Number.isFinite(declared) && declared > 0 ? Math.min(declared, 4000) : 320}px`
    if (node.dataset.islandTitle) frame.title = node.dataset.islandTitle
    // The frame boots with no idea whether annotate mode is on; tell it on load.
    frame.addEventListener('load', () => postIslandMode(frame))
    node.appendChild(frame)
  }
}

// Sandboxed frames have an opaque origin, so '*' is the only addressable target.
function postIslandMode(frame) {
  frame.contentWindow?.postMessage({ easelIslandMode: true, annotating: state.annotating }, '*')
}

window.addEventListener('message', (event) => {
  const m = event.data || {}
  if (m.easelIsland !== true) return
  const frame = CONTENT.querySelector(`.sd-island-frame[data-island-index="${Number(m.index)}"]`)
  if (!frame || event.source !== frame.contentWindow) return
  const h = Number(m.height)
  if (Number.isFinite(h) && h > 0) frame.style.height = `${Math.min(Math.max(h, 40), 4000)}px`
  if (m.click && state.annotating) islandPinClick(frame, m.click)
})

// A click inside an island frame arrives as frame-relative coordinates; anchor
// it to the island's sid as a fractional point and open the normal popover.
function islandPinClick(frame, click) {
  const host = frame.closest('[data-sid]')
  const round4 = (v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 1e4) / 1e4
  const x = round4(click.x)
  const y = round4(click.y)
  if (!host || !Number.isFinite(x) || !Number.isFinite(y)) return
  const r = frame.getBoundingClientRect()
  const at = { clientX: r.left + Number(click.cx || 0), clientY: r.top + Number(click.cy || 0) }
  const quote = String(click.label || '').slice(0, 200) || undefined
  const drafts = state.draftsByKey.get(`${host.dataset.sid}@${x},${y}`)
  if (drafts?.length) openDraftManager(host, at, drafts, { x, y, quote })
  else openPopover(host, at, { x, y, quote })
}

// Re-applied on every render: innerHTML replacement wipes DOM-only state.
// Drafts are sorted last so the live draft's choice wins the option marking.
function markRecordedWidgets(items) {
  // Marker-only refreshes keep the DOM, so a removed widget draft must unmark.
  for (const w of CONTENT.querySelectorAll('[data-widget].sf-recorded')) {
    w.classList.remove('sf-recorded')
    for (const opt of w.querySelectorAll('[data-option]')) opt.removeAttribute('aria-pressed')
  }
  const widgetItems = items.filter((i) => i.kind === 'widget')
  widgetItems.sort((a, b) => (a.state === 'draft' ? 1 : 0) - (b.state === 'draft' ? 1 : 0))
  for (const item of widgetItems) {
    const widget = CONTENT.querySelector(`[data-widget-id="${CSS.escape(item.widgetId)}"]`)
    if (!widget) continue
    widget.classList.add('sf-recorded')
    for (const opt of widget.querySelectorAll('[data-option]')) {
      opt.setAttribute('aria-pressed', String(opt.dataset.option === item.value))
    }
  }
}

function renderRounds(d) {
  ui.rounds.replaceChildren()
  const showPills = d.rounds.length >= 2
  const annotated = d.feedback.some((i) => i.anchor?.sid && i.kind !== 'widget')
  // The legend explains the annotation marker too, so it has to outlive the
  // pills: on round 1 a marked node had nothing telling the reader what it was.
  show(ui.rounds, showPills || annotated)
  if (!showPills && !annotated) return
  const latest = d.rounds.length ? d.rounds[d.rounds.length - 1].seq : null
  const active = state.viewingRound ?? latest
  if (showPills) {
    const keys = el('span', 'sf-round-keys', '[Q]·[W]')
    keys.title = 'Q: previous revision · W: next revision'
    ui.rounds.appendChild(keys)
  }
  for (const r of showPills ? d.rounds : []) {
    const pill = el('button', 'sf-round-pill', `r${r.seq}`)
    pill.type = 'button'
    pill.dataset.round = String(r.seq)
    if (r.note) pill.title = r.note
    if (r.seq === latest) pill.classList.add('sf-round-current')
    if (r.seq === active) pill.classList.add('sf-round-active')
    pill.onclick = () => {
      state.viewingRound = r.seq === latest ? null : r.seq
      sync(r.seq === latest ? null : r.seq)
    }
    ui.rounds.appendChild(pill)
  }
  const legend = el('div', 'sf-diff-legend')
  if (showPills) {
    for (const k of ['added', 'removed', 'modified', 'moved']) legend.appendChild(el('span', `sf-legend-${k}`, k))
  }
  if (annotated) {
    const entry = el('span', 'sf-legend-annotated')
    entry.append(el('span', 'sf-item-marker', 'A1'), 'annotated — matches its feedback row')
    legend.appendChild(entry)
  }
  ui.rounds.appendChild(legend)
  ui.removedToggle = null
  const removedCount = d.diff?.removedDetail?.length || 0
  if (showPills && removedCount) {
    const btn = el('button', 'sf-removed-toggle', `[X] Show removed (${removedCount})`)
    btn.type = 'button'
    btn.title = `Show removed content where it was removed from (press ${REMOVED_HOTKEY})`
    ui.removedToggle = btn
    btn.classList.toggle('sf-on', state.showRemoved)
    btn.onclick = () => {
      state.showRemoved = !state.showRemoved
      btn.classList.toggle('sf-on', state.showRemoved)
      CONTENT.classList.toggle('sf-show-removed', state.showRemoved)
    }
    ui.rounds.appendChild(btn)
  }
}

function applyDiff(diff) {
  for (const k of ['added', 'modified', 'moved']) {
    for (const sid of diff[k] || []) {
      const node = CONTENT.querySelector(`[data-sid="${CSS.escape(sid)}"]`)
      if (node) node.classList.add(`sf-diff-${k}`)
    }
  }
  // Removed nodes exist only in the previous round — render each as a ghost at
  // the spot it was removed from, revealed by the Removed toggle.
  CONTENT.classList.toggle('sf-show-removed', state.showRemoved)
  // Ghosts sharing an anchor chain after each other — a bare afterend on the
  // anchor every time would reverse adjacent removals.
  const lastAt = new Map()
  const bySid = (sid) => sid && CONTENT.querySelector(`[data-sid="${CSS.escape(sid)}"]`)
  for (const r of diff.removedDetail || []) {
    const item = el('aside', 'sf-ghost-item', r.excerpt || '(no text)')
    item.dataset.sid = r.sid
    const key = r.afterSid ? `a:${r.afterSid}` : r.withinSid ? `w:${r.withinSid}` : 'start'
    const prev = lastAt.get(key)
    const after = prev || bySid(r.afterSid)
    const within = bySid(r.withinSid)
    if (after) after.insertAdjacentElement('afterend', item)
    else if (within) within.insertAdjacentElement('afterbegin', item)
    else CONTENT.insertAdjacentElement('afterbegin', item)
    lastAt.set(key, item)
  }
}

function renderQueue(items) {
  ui.queueList.replaceChildren()
  const drafts = items.filter((i) => i.state === 'draft')
  ui.queueCount.textContent = String(drafts.length)
  ui.queueToggleCount.textContent = String(drafts.length)
  ui.queueSend.textContent = drafts.length ? `Send ${drafts.length}` : 'Send'
  ui.queueSend.disabled = drafts.length === 0
  ui.sendNow.textContent = `Send ${drafts.length}`
  show(ui.sendNow, drafts.length > 0)
  state.draftCount = drafts.length
  ui.chatSubmit.textContent = drafts.length ? 'Send with feedback' : 'Send'
  for (const item of items) {
    if (item.kind === 'chat') continue
    const row = el('div', 'sf-queue-item')
    row.classList.add(item.state === 'draft' ? 'sf-item-draft' : 'sf-item-submitted')
    if (item.kind === 'widget') row.classList.add('sf-item-widget')
    const sid = item.anchor?.sid
    if (sid) {
      row.dataset.sid = sid
      row.dataset.markerKey = anchorKey(item.anchor)
      const mark = state.markerIds?.get(anchorKey(item.anchor))
      if (mark) {
        row.dataset.markerHue = String(mark.hue)
        row.appendChild(el('span', 'sf-item-marker', mark.id))
      }
      row.onmouseenter = () => highlightAnchor(sid, true)
      row.onmouseleave = () => highlightAnchor(sid, false)
      row.onclick = (e) => {
        if (e.target.closest('button')) return
        revealAnchor(sid)
      }
    }
    row.appendChild(el('div', 'sf-item-excerpt', item.anchor?.quote || item.excerpt || ''))
    if (item.kind === 'widget') {
      row.appendChild(el('div', 'sf-item-comment', `${item.widgetId}: ${item.value}`))
    } else if (item.comment) {
      row.appendChild(el('div', 'sf-item-comment', item.comment))
    }
    row.appendChild(el('span', 'sf-item-round', `r${item.round}`))
    if (item.state === 'draft') {
      const remove = el('button', 'sf-item-remove', '×')
      remove.type = 'button'
      remove.title = 'Remove from queue'
      remove.onclick = () => removeFeedback(item.id)
      row.appendChild(remove)
    }
    ui.queueList.appendChild(row)
  }
}

const removing = new Set()

// A swallowed failure here is why removal was reported as impossible: the row
// stayed and nothing said why.
async function removeFeedback(id) {
  if (removing.has(id)) return
  removing.add(id)
  try {
    await api.send('DELETE', `/api/b/${KEY}/feedback/${id}`)
    toast('Removed')
  } catch (err) {
    toast(`Remove failed: ${err.message}`)
  } finally {
    removing.delete(id)
  }
  sync()
}

// Single writer for the panel's open state: the topbar button, the panel header
// and the hotkey all route here so the toggle's sf-on class cannot drift.
function togglePanel(panel, button, force) {
  const open = panel.classList.toggle('sf-open', force)
  button.classList.toggle('sf-on', open)
  return open
}

const toggleQueue = (force) => togglePanel(ui.queue, ui.queueToggle, force)
const toggleChat = (force) => togglePanel(ui.chat, ui.chatToggle, force)

// Enter submits, Shift+Enter is a newline. IME composition must pass through:
// picking a candidate fires Enter and would otherwise submit a half-typed word.
function submitOnEnter(field, submit) {
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    submit()
  })
}

function typingInFormField(target) {
  if (!target) return false
  return target.isContentEditable || ['TEXTAREA', 'INPUT', 'SELECT'].includes(target.tagName)
}

async function sendDrafts() {
  try {
    // Through the mutation chain: Send must not overtake an in-flight click.
    const res = await enqueueMutation(() => api.send('POST', `/api/b/${KEY}/send`, { clientId }))
    toast(`Sent ${res.submitted.length} item${res.submitted.length === 1 ? '' : 's'}`)
    sync()
  } catch (err) {
    toast(`Send failed: ${err.message}`)
  }
}

// Session ids are UUID-length; the bubble shows a short form and the full id
// stays on the title attribute.
function callsign(agent) {
  return agent.length <= 8 ? agent : agent.slice(0, 8)
}

function renderChat(messages) {
  ui.chatLog.replaceChildren()
  for (const m of messages) {
    const bubble = el('div', `sf-chat-msg ${m.role === 'agent' ? 'sf-msg-agent' : 'sf-msg-user'}`)
    if (m.agent) {
      const tag = el('span', 'sf-msg-agent-id', callsign(m.agent))
      tag.title = m.agent
      bubble.appendChild(tag)
    }
    bubble.appendChild(el('span', 'sf-msg-text', m.text))
    ui.chatLog.appendChild(bubble)
  }
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight
  const last = messages[messages.length - 1]
  if (last && last.role === 'agent') show(ui.chatWorking, false)
}

function renderAudit(audit) {
  const findings = audit?.findings || []
  const hasFindings = findings.length > 0
  show(ui.audit, hasFindings)
  if (!hasFindings) return
  ui.auditBadge.textContent = `layout ${findings.length}`
  ui.auditList.replaceChildren()
  for (const f of findings) {
    ui.auditList.appendChild(el('div', `sf-audit-finding sf-sev-${f.severity}`, `${f.type}: ${f.detail}`))
  }
}

/* Reveal once the content is actually painted. An error-severity finding holds
   the gate, but only until the inline safety timeout — never indefinitely. */
function resolveGate(audit) {
  if (!document.body.classList.contains('sf-gated')) return
  const held = (audit?.findings || []).some((f) => f.severity === 'error')
  if (held) {
    const card = document.querySelector('.sf-gate-card')
    if (card && !card.classList.contains('sf-gate-held')) {
      card.classList.add('sf-gate-held')
      card.querySelector('.sf-gate-title').textContent = 'Fixing a layout issue…'
      card.querySelector('.sf-gate-copy').textContent =
        'The layout audit reported an error. Your agent has been notified; this reveals on the next clean publish.'
    }
    return
  }
  window.__sfRevealGate?.()
}

function reportForcedReveal(reason) {
  if (!reason) return
  ui.gateBanner.textContent =
    reason === 'timeout'
      ? 'This board may have layout issues. It was revealed after the safety timeout so review is never blocked.'
      : 'This board may have layout issues. You chose to show it before the layout check finished.'
  show(ui.gateBanner, true)
}

function setAgentWaiting(waiting) {
  ui.agent.classList.toggle('sf-agent-waiting', waiting)
  ui.agentLabel.textContent = waiting ? 'agent waiting' : ''
  show(ui.cancelWait, waiting)
}

// A pin (island click point) is its own anchor: each unique point gets its own
// marker id, while plain annotations still share one marker per sid.
const isPin = (anchor) => Number.isFinite(anchor?.x) && Number.isFinite(anchor?.y)
const anchorKey = (anchor) => (isPin(anchor) ? `${anchor.sid}@${anchor.x},${anchor.y}` : anchor?.sid)

// Markers are real nodes, not ::before pseudo-elements: they carry a number that
// keys them to their panel row, and they have to be hoverable and clickable.
function markAnnotated(items) {
  state.draftsByKey = new Map()
  state.commentsByKey = new Map()
  state.markerIds = new Map()
  const order = []
  for (const item of items) {
    const sid = item.anchor?.sid
    if (!sid || item.kind === 'widget') continue
    const key = anchorKey(item.anchor)
    if (!state.markerIds.has(key)) {
      state.markerIds.set(key, {
        id: markerId(order.length),
        hue: order.length % MARKER_HUES,
        sid,
        pin: isPin(item.anchor) ? { x: item.anchor.x, y: item.anchor.y, quote: item.anchor.quote } : null,
      })
      order.push(key)
    }
    if (item.comment) {
      if (!state.commentsByKey.has(key)) state.commentsByKey.set(key, [])
      state.commentsByKey.get(key).push(item.comment)
    }
    if (item.state !== 'draft') continue
    if (!state.draftsByKey.has(key)) state.draftsByKey.set(key, [])
    state.draftsByKey.get(key).push(item)
  }
  for (const key of order) {
    const mark = state.markerIds.get(key)
    const node = CONTENT.querySelector(`[data-sid="${CSS.escape(mark.sid)}"]`)
    if (!node) continue
    // A pin floats at its click point over the island; no gutter badge, no
    // whole-block outline — the island itself is not what was annotated.
    if (mark.pin) {
      const pinBtn = buildMarker(key, mark.id, mark.hue)
      pinBtn.classList.add('sf-pin')
      pinBtn.style.left = `${mark.pin.x * 100}%`
      pinBtn.style.top = `${mark.pin.y * 100}%`
      node.appendChild(pinBtn)
      continue
    }
    node.classList.add('sf-annotated')
    node.dataset.markerHue = String(mark.hue)
    for (const cell of columnCells(node)) {
      cell.classList.add('sf-annotated-col')
      cell.dataset.markerHue = String(mark.hue)
    }
    // A button is not valid content for a table row — the parser would hoist it
    // out of the table. Table anchors host it in their first cell instead.
    const host = TABLE_ROW_TAGS.has(node.tagName) ? node.querySelector('td, th') : node
    if (!host) continue
    const marker = buildMarker(key, mark.id, mark.hue)
    // Nested anchors can resolve to the same host (a table and its first row),
    // which would stack the badges on identical coordinates.
    marker.style.setProperty('--marker-stack', String(host.querySelectorAll(':scope > .sf-marker').length))
    host.prepend(marker)
  }
}

// A1..A9, B1..B9, … — two characters, so it stays legible inline and reads the
// same on the page marker and its queue row.
function markerId(i) {
  return String.fromCharCode(65 + Math.floor(i / 9) % 26) + ((i % 9) + 1)
}

// A column has no node of its own; its thead header cell stands for it.
// Logical columns, not cellIndex: colspans shift ordinal positions.
function columnCells(node) {
  if (node?.tagName !== 'TH' || !node.closest('thead')) return []
  const table = node.closest('table')
  if (!table) return []
  const start = [...node.parentElement.cells].slice(0, node.cellIndex).reduce((n, c) => n + c.colSpan, 0)
  const end = start + node.colSpan
  return [...table.tBodies].flatMap((b) => [...b.rows]).flatMap((r) => {
    const out = []
    let col = 0
    for (const cell of r.cells) {
      // Fully-contained cells only: a row-spanning widget cell is not one column's.
      if (col >= start && col + cell.colSpan <= end) out.push(cell)
      col += cell.colSpan
    }
    return out
  })
}

function highlightAnchor(sid, on) {
  const node = CONTENT.querySelector(`[data-sid="${CSS.escape(sid)}"]`)
  if (!node) return
  for (const n of [node, ...columnCells(node)]) n.classList.toggle('sf-linked', on)
}

function highlightQueueRows(key, on) {
  for (const row of ui.queueList.querySelectorAll(`[data-marker-key="${CSS.escape(key)}"]`)) {
    row.classList.toggle('sf-linked', on)
  }
}

function revealAnchor(sid) {
  const node = CONTENT.querySelector(`[data-sid="${CSS.escape(sid)}"]`)
  if (!node) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  node.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  clearTimeout(flashTimer)
  CONTENT.querySelectorAll('.sf-flash').forEach((n) => n.classList.remove('sf-flash'))
  void node.offsetWidth // restart the animation if the same row is clicked twice
  const nodes = [node, ...columnCells(node)]
  for (const n of nodes) n.classList.add('sf-flash')
  flashTimer = setTimeout(() => nodes.forEach((n) => n.classList.remove('sf-flash')), 1200)
}
let flashTimer = null

function buildMarker(key, id, hue) {
  const marker = el('button', 'sf-marker', id)
  marker.type = 'button'
  marker.dataset.markerKey = key
  marker.dataset.markerHue = String(hue)
  const comments = state.commentsByKey?.get(key) || []
  marker.title = comments.length ? comments.join('\n\n') : 'Annotations on this element'
  marker.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const mark = state.markerIds.get(key)
    const node = mark && CONTENT.querySelector(`[data-sid="${CSS.escape(mark.sid)}"]`)
    if (!node) return
    const drafts = state.draftsByKey.get(key)
    // Submitted annotations have no drafts to manage, but the badge must still
    // do something — otherwise it reads as a broken button.
    if (drafts?.length) openDraftManager(node, e, drafts, mark.pin)
    else openPopover(node, e, mark.pin)
  }
  marker.onmouseenter = () => highlightQueueRows(key, true)
  marker.onmouseleave = () => highlightQueueRows(key, false)
  return marker
}

// ---------------------------------------------------------------- annotation layer

function setAnnotating(on) {
  state.annotating = on
  document.body.classList.toggle('sf-annotating', on)
  ui.annotateToggle.classList.toggle('sf-on', on)
  CONTENT.querySelectorAll('.sd-island-frame').forEach(postIslandMode)
  if (!on) closePopover()
}

let popover = null

function closePopover() {
  if (popover) popover.remove()
  popover = null
  CONTENT.querySelectorAll('.sf-hover').forEach((n) => n.classList.remove('sf-hover'))
}

// Chrome-injected controls inside content act, never annotate.
const CHROME_CONTROLS = '.sf-wb-open, .sf-diagram-look, .sf-wrap-toggle'

CONTENT.addEventListener('mouseover', (e) => {
  if (!state.annotating || popover) return
  const target = e.target.closest(CHROME_CONTROLS) ? null : e.target.closest('[data-sid]')
  CONTENT.querySelectorAll('.sf-hover').forEach((n) => n.classList.remove('sf-hover'))
  // Hover previews only the anchor itself; the column echo appears on the
  // saved mark (sf-annotated-col), not while merely pointing at a header.
  if (target && !target.closest('[data-option]')) target.classList.add('sf-hover')
})

CONTENT.addEventListener('click', (e) => {
  const option = e.target.closest('[data-option]')
  if (option && option.closest('[data-widget]')) {
    e.preventDefault()
    recordWidget(option.closest('[data-widget]'), option)
    return
  }
  if (!state.annotating) return
  // <summary> and links keep native behaviour. Annotate is on by default now, so
  // swallowing the click would strand every link and every collapse on the page.
  if (e.target.closest('summary') || e.target.closest('a[href]')) return
  if (e.target.closest(CHROME_CONTROLS)) return
  const target = e.target.closest('[data-sid]')
  // A widget's prompt is annotatable text; only the option buttons vote.
  if (!target || target.closest('[data-option]')) return
  e.preventDefault()
  const drafts = state.draftsByKey.get(target.dataset.sid)
  if (drafts?.length && window.getSelection()?.isCollapsed !== false) {
    openDraftManager(target, e, drafts)
    return
  }
  openPopover(target, e)
})

// The marker is a child node, so its digits would land in textContent and shift
// every prefix/suffix offset the server anchors on.
function anchorText(node) {
  const clone = node.cloneNode(true)
  return stripMarkers(clone)
}

function stripMarkers(fragment) {
  fragment.querySelectorAll('.sf-marker').forEach((m) => m.remove())
  return fragment.textContent || ''
}

function selectionAnchor(node) {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !node.contains(sel.anchorNode)) return {}
  // Badges live inside pre/table/diagram anchors, so a selection that starts at
  // the top of the block swallows their text unless it is stripped here too.
  const quote = stripMarkers(sel.getRangeAt(0).cloneContents())
  if (!quote.trim()) return {}
  const text = anchorText(node)
  const at = text.indexOf(quote)
  return {
    quote,
    prefix: at > 0 ? text.slice(Math.max(0, at - 20), at) : '',
    suffix: at >= 0 ? text.slice(at + quote.length, at + quote.length + 20) : '',
  }
}

// Clicking an element that already carries drafts manages them instead of
// stacking another one — the page-side answer to "how do I remove this?".
function openDraftManager(node, event, drafts, pin) {
  closePopover()
  popover = el('div', 'sf-popover')
  popover.appendChild(el('div', 'sf-popover-label', drafts.length === 1 ? 'Queued note' : `${drafts.length} queued notes`))
  for (const item of drafts) {
    const row = el('div', 'sf-draft-row')
    row.appendChild(el('div', 'sf-draft-comment', item.comment || '(no comment)'))
    const remove = el('button', 'sf-draft-remove', 'Remove')
    remove.type = 'button'
    remove.onclick = () => {
      closePopover()
      removeFeedback(item.id)
    }
    row.appendChild(remove)
    popover.appendChild(row)
  }
  const actions = el('div', 'sf-popover-actions')
  const addBtn = el('button', 'sf-popover-queue', 'Add another')
  addBtn.type = 'button'
  addBtn.onclick = () => openPopover(node, event, pin)
  const cancelBtn = el('button', 'sf-popover-cancel', 'Close')
  cancelBtn.type = 'button'
  cancelBtn.onclick = closePopover
  actions.append(addBtn, cancelBtn)
  popover.appendChild(actions)
  CHROME.appendChild(popover)
  placePopover(popover, event)
}

function placePopover(node, event) {
  // .sf-popover is position:fixed, so clientX/clientY need no scroll offset. The
  // lower clamp keeps it on screen when it is taller than the viewport.
  const pad = 8
  node.style.left = `${Math.max(pad, Math.min(event.clientX, window.innerWidth - node.offsetWidth - pad))}px`
  node.style.top = `${Math.max(pad, Math.min(event.clientY + pad, window.innerHeight - node.offsetHeight - pad))}px`
}

// `pin` ({x,y,quote}) skips text-selection anchoring: the anchor is a point
// inside an island frame, not a range in this document.
function openPopover(node, event, pin) {
  closePopover()
  const sid = node.dataset.sid
  const extra = pin ? { x: pin.x, y: pin.y, quote: pin.quote || undefined } : selectionAnchor(node)
  popover = el('div', 'sf-popover')
  const excerptText = extra.quote || anchorText(node).trim().slice(0, 200)
  popover.appendChild(el('div', 'sf-popover-label', pin ? 'Pin' : extra.quote ? 'Selection' : 'Element'))
  popover.appendChild(el('div', 'sf-popover-excerpt', excerptText))
  const textarea = el('textarea', 'sf-popover-text')
  textarea.placeholder = 'Comment…'
  textarea.rows = 3
  const actions = el('div', 'sf-popover-actions')
  const queue = async () => {
    const comment = textarea.value.trim()
    if (!comment) return
    try {
      await api.send('POST', `/api/b/${KEY}/feedback`, {
        clientId,
        round: state.data.currentRound.seq,
        anchor: { sid, ...extra },
        comment,
      })
      closePopover()
      toast('Queued')
      sync()
    } catch (err) {
      toast(`Queue failed: ${err.message}`)
    }
  }
  submitOnEnter(textarea, queue)
  const queueBtn = el('button', 'sf-popover-queue', 'Queue')
  queueBtn.type = 'button'
  queueBtn.onclick = queue
  const cancelBtn = el('button', 'sf-popover-cancel', 'Cancel')
  cancelBtn.type = 'button'
  cancelBtn.onclick = closePopover
  actions.append(queueBtn, cancelBtn)
  popover.append(textarea, actions)
  CHROME.appendChild(popover)
  placePopover(popover, event)
  textarea.focus()

  function excerptToLabel() {
    return el('div', 'sf-popover-label', extra.quote ? 'Selection' : 'Element')
  }
}

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape') return
    // Escape dismisses what is on top. Annotate mode is never on that list:
    // only its own button turns it off.
    if (popover) {
      e.preventDefault()
      e.stopPropagation()
      closePopover()
      return
    }
    // The whiteboard sits over everything, so it is what Escape dismisses first.
    // Through closeWhiteboard, never a shortcut: closing still has to flush.
    if (wbIndex !== null) {
      e.preventDefault()
      closeWhiteboard()
      return
    }
    if (ui.chat.classList.contains('sf-open')) toggleChat(false)
    else if (ui.queue.classList.contains('sf-open')) toggleQueue(false)
  },
  true
)

// Steps the viewed revision without looping: past either end is a no-op.
function stepRound(delta) {
  const rounds = state.data?.rounds ?? []
  if (rounds.length < 2) return
  const latest = rounds[rounds.length - 1].seq
  const active = state.viewingRound ?? latest
  const next = rounds[rounds.findIndex((r) => r.seq === active) + delta]
  if (!next) return
  state.viewingRound = next.seq === latest ? null : next.seq
  sync(next.seq === latest ? null : next.seq)
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (typingInFormField(e.target)) return
  const key = e.key.toLowerCase()
  if (![QUEUE_HOTKEY, CHAT_HOTKEY, THEME_HOTKEY, ANNOTATE_HOTKEY, REMOVED_HOTKEY, ROUND_BACK_HOTKEY, ROUND_FORWARD_HOTKEY, WIDTH_NARROW_HOTKEY, WIDTH_WIDEN_HOTKEY].includes(key)) return
  e.preventDefault()
  if (key === QUEUE_HOTKEY) toggleQueue()
  else if (key === CHAT_HOTKEY) toggleChat()
  else if (key === THEME_HOTKEY) cycleTheme()
  else if (key === ANNOTATE_HOTKEY) setAnnotating(!state.annotating)
  else if (key === ROUND_BACK_HOTKEY) stepRound(-1)
  else if (key === ROUND_FORWARD_HOTKEY) stepRound(1)
  else if (key === WIDTH_NARROW_HOTKEY) nudgeWidth(-1)
  else if (key === WIDTH_WIDEN_HOTKEY) nudgeWidth(1)
  else ui.removedToggle?.click()
})

// ---------------------------------------------------------------- widgets

// One promise chain for widget clicks and Send: parallel POSTs could land out
// of order (reclick keeping the older value) or strand a click behind Send.
let mutations = Promise.resolve()
function enqueueMutation(fn) {
  const next = mutations.then(fn, fn)
  mutations = next.then(() => {}, () => {})
  return next
}

async function recordWidget(widget, option) {
  const widgetId = widget.dataset.widgetId
  const value = option.dataset.option
  const sid = widget.closest('[data-sid]')?.dataset.sid || widget.dataset.sid || null
  widget.classList.add('sf-recorded')
  for (const opt of widget.querySelectorAll('[data-option]')) {
    opt.setAttribute('aria-pressed', String(opt === option))
  }
  let item
  try {
    item = await enqueueMutation(() =>
      api.send('POST', `/api/b/${KEY}/widget`, {
        clientId,
        round: state.data.currentRound.seq,
        widgetId,
        value,
        sid,
      })
    )
  } catch (err) {
    toast(`Failed to record: ${err.message}`)
    sync()
    return
  }
  toast(`Queued ${widgetId}: ${item.value} — Send delivers`)
  sync()
}

// ---------------------------------------------------------------- live events

let ended = false
let stopEvents = () => {}
// Last daemon-side broadcast counter this tab saw (rides every event and
// /state response); a hello with a different one means events were missed.
let eventSeq = null

let endArmTimer = null

function draftCount() {
  return (state.data?.feedback || []).filter((i) => i.state === 'draft').length
}

/* Two-stage rather than a native confirm: ending is irreversible from the
   browser, and the armed label states what the click will actually do. */
async function endSession() {
  const drafts = draftCount()
  if (!state.endArmed) {
    state.endArmed = true
    ui.endSession.classList.add('sf-armed')
    ui.endSession.textContent = drafts ? `Send ${drafts} and end?` : 'End session?'
    clearTimeout(endArmTimer)
    endArmTimer = setTimeout(disarmEnd, 5000)
    return
  }
  disarmEnd()
  try {
    // Unconditional, and behind the mutation chain: a draft created moments ago
    // may not be in state.data yet, and after the end it can never be sent.
    const sent = await enqueueMutation(() => api.send('POST', `/api/b/${KEY}/send`, { clientId }))
    await api.send('POST', `/api/b/${KEY}/end`, {})
    setEnded()
    const n = sent?.submitted?.length ?? 0
    toast(n ? `Sent ${n} item${n === 1 ? '' : 's'} and ended` : 'Board ended')
  } catch (err) {
    toast(`End failed: ${err.message}`)
  }
}

function disarmEnd() {
  clearTimeout(endArmTimer)
  state.endArmed = false
  ui.endSession.classList.remove('sf-armed')
  ui.endSession.textContent = 'End'
}

function setEnded() {
  if (ended) return
  ended = true
  setStatus('ended')
  stopEvents()
  setAnnotating(false)
  closePopover()
  disarmEnd()
  ui.endSession.disabled = true
  ui.annotateToggle.disabled = true
  ui.sendNow.disabled = true
  ui.queueSend.disabled = true
  ui.chatInput.disabled = true
  ui.chatForm.querySelector('.sf-chat-submit').disabled = true
  show(ui.chatWorking, false)
  show(ui.endedBanner, true)
  document.body.classList.add('sf-ended')
  disableContentControls()
  if (wbIndex !== null && wbReady) postToWhiteboard({ type: WB.boardEnded })
}

/* A disabled button fires no click, so this stops the widget path at the
   source rather than relying on the delegated listener to opt out. */
function disableContentControls() {
  for (const b of CONTENT.querySelectorAll('[data-widget] [data-option]')) b.disabled = true
}

function setStatus(state) {
  // The stream connects after the first render, so without this a fresh tab on
  // an ended board would report itself live a moment later.
  if (ended && state !== 'ended') return
  ui.statusDot.classList.toggle('sf-connected', state === 'live')
  ui.statusDot.classList.toggle('sf-reconnecting', state === 'reconnecting')
  ui.statusLabel.textContent = state
}

function handleEvent(event, data) {
  if (ended) return
  if (event !== 'hello' && data.seq != null) eventSeq = data.seq
  switch (event) {
    case 'hello': {
      const have = state.data?.currentRound?.seq
      const haveWip = state.data?.wip?.updatedAt || null
      const missed = data.seq != null && eventSeq != null && data.seq !== eventSeq
      eventSeq = data.seq ?? eventSeq
      if (data.agentWaiting != null) setAgentWaiting(data.agentWaiting)
      if (missed || have !== data.round || haveWip !== data.wipAt) sync()
      break
    }
    case 'round':
      state.viewingRound = null
      sync()
      toast('New round published')
      break
    case 'wip':
    case 'chat':
    case 'feedback':
      sync()
      break
    case 'agent':
      setAgentWaiting(data.waiting)
      break
    case 'end':
      setEnded()
      break
  }
}

// One worker-held stream for all tabs: per-tab streams exhaust the browser's
// 6-per-origin cap and starve the 7th tab. sf-tab-sse=1 forces the fallback.
const useWorker = typeof SharedWorker === 'function' && localStorage.getItem('sf-tab-sse') !== '1'

function startEvents() {
  if (useWorker) {
    const worker = new SharedWorker('/assets/events-worker.js')
    worker.port.onmessage = (e) => {
      const m = e.data
      if (m.type === 'status') setStatus(m.state)
      else if (m.type === 'event') handleEvent(m.event, m.data)
    }
    const attach = () => worker.port.postMessage({ type: 'attach', key: KEY })
    attach()
    window.addEventListener('pagehide', () => worker.port.postMessage({ type: 'detach' }))
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && !ended) {
        attach()
        sync()
      }
    })
    stopEvents = () => worker.port.postMessage({ type: 'detach' })
    return
  }

  // Fallback (no SharedWorker, e.g. Safari): per-tab stream, released while
  // the tab is hidden so backgrounded tabs stop holding connection slots.
  let sse = null
  let backoff = 1000
  let retryTimer = null
  const connect = () => {
    clearTimeout(retryTimer)
    if (ended || document.hidden) return
    if (sse && sse.readyState !== EventSource.CLOSED) return
    sse = new EventSource(`/b/${KEY}/events`)
    sse.onopen = () => {
      backoff = 1000
      setStatus('live')
    }
    sse.onerror = () => {
      sse.close()
      setStatus('reconnecting')
      retryTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 15000)
    }
    for (const name of ['hello', 'round', 'wip', 'chat', 'feedback', 'agent', 'end']) {
      sse.addEventListener(name, (e) => handleEvent(name, e.data ? JSON.parse(e.data) : {}))
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      sse?.close()
      setStatus('paused')
    } else {
      connect() // the hello seq comparison syncs anything missed while hidden
    }
  })
  stopEvents = () => sse?.close()
  connect()
}

// ---------------------------------------------------------------- whiteboard

// Overlay only: our content renders into #sf-content rather than an artifact
// iframe, so lavish's inline placement has nowhere to live.
const saveChains = new Map()
// Owned by the side that serialises the writes: a base stamped before queuing
// would already be stale by the time its turn came round.
const wbVersions = new Map()
const teardowns = new Map()
const flushes = new Map()
let wbIndex = null
let wbChannelId = ''
let wbReady = false
let nextFlushId = 0

const wbTheme = () => (document.documentElement.dataset.theme?.endsWith('dark') ? 'dark' : 'light')

function buildWhiteboard() {
  ui.wbOverlay = el('div', 'sf-wb-overlay')
  ui.wbError = el('div', 'sf-wb-error')
  show(ui.wbError, false)
  ui.wbFrame = document.createElement('iframe')
  ui.wbFrame.className = 'sf-wb-frame'
  ui.wbFrame.title = 'Whiteboard'
  ui.wbFrame.setAttribute('sandbox', 'allow-scripts allow-popups')
  ui.wbOverlay.append(ui.wbError, ui.wbFrame)
  show(ui.wbOverlay, false)
  document.body.appendChild(ui.wbOverlay)
}

// innerHTML replacement on every render wipes these, so they are re-attached.
function attachWhiteboardButtons() {
  // A themed mermaid SVG has no editable scene, so no button there. Sketch and
  // dual diagrams open their scene; an error block invites drawing a replacement.
  for (const node of CONTENT.querySelectorAll('.sd-diagram-sketch[data-diagram-index], .sd-diagram-dual[data-diagram-index], .sd-diagram-error[data-diagram-index]')) {
    const index = Number(node.dataset.diagramIndex)
    if (!Number.isInteger(index)) continue
    const button = el('button', 'sf-wb-open', 'Whiteboard')
    button.type = 'button'
    button.title = 'Edit this diagram and send it to the agent'
    button.onclick = (e) => {
      e.preventDefault()
      openWhiteboard(index)
    }
    node.appendChild(button)
  }
  for (const node of CONTENT.querySelectorAll('.sd-diagram-dual')) {
    const button = el('button', 'sf-diagram-look')
    button.type = 'button'
    button.title = 'Switch how diagrams are drawn (applies to all of them)'
    button.onclick = toggleDiagramLook
    node.appendChild(button)
  }
  applyDiagramLook()
}

const diagramLook = () => (localStorage.getItem(LOOK_STORAGE) === 'sketch' ? 'sketch' : 'mermaid')

function applyDiagramLook() {
  const look = diagramLook()
  if (look === 'sketch') document.documentElement.dataset.diagramLook = 'sketch'
  else delete document.documentElement.dataset.diagramLook
  // The label names the look a click switches TO.
  for (const btn of CONTENT.querySelectorAll('.sf-diagram-look')) {
    btn.textContent = look === 'sketch' ? 'Plain look' : 'Sketch look'
  }
}

function toggleDiagramLook() {
  if (diagramLook() === 'sketch') localStorage.removeItem(LOOK_STORAGE)
  else localStorage.setItem(LOOK_STORAGE, 'sketch')
  applyDiagramLook()
}

/* Only a block that overflows gets the chip, so wrap is cleared before the
   widths are read and re-applied after — one pass, no paint between. */
function attachWrapButtons() {
  delete document.documentElement.dataset.wrapCode
  const wide = []
  for (const node of CONTENT.querySelectorAll('pre:not(.sd-diff)')) {
    // Inside a closed <details> both widths read 0; offer the chip rather than
    // conclude it fits.
    if (node.scrollWidth > node.clientWidth + 1 || node.offsetParent === null) wide.push(node)
  }
  for (const node of wide) {
    // The class reserves the corner the chip sits in, so it never covers code.
    node.classList.add('sf-wrappable')
    const button = el('button', 'sf-wrap-toggle')
    button.type = 'button'
    button.title = 'Wrap long lines (applies to every code block)'
    button.onclick = toggleWrapCode
    node.appendChild(button)
  }
  // A narrower column rewraps every line, so the marks are re-measured on resize.
  wrapObserver?.disconnect()
  wrapObserver = new ResizeObserver((entries) => entries.forEach((e) => markWrapPoints(e.target)))
  for (const node of wide) wrapObserver.observe(node)
  applyWrapCode()
}

let wrapObserver

const wrapCode = () => localStorage.getItem(WRAP_STORAGE) === 'on'

function applyWrapCode() {
  const on = wrapCode()
  if (on) document.documentElement.dataset.wrapCode = 'on'
  else delete document.documentElement.dataset.wrapCode
  // The label names the state a click switches TO.
  for (const btn of CONTENT.querySelectorAll('.sf-wrap-toggle')) {
    btn.textContent = on ? 'No wrap' : 'Wrap'
  }
  for (const pre of CONTENT.querySelectorAll('pre.sf-wrappable')) markWrapPoints(pre)
}

/* A soft wrap breaks no element, so there is nothing to style: each logical line
   is measured and a glyph parked at the right margin of every line box but its last. */
function markWrapPoints(pre) {
  for (const old of pre.querySelectorAll('.sf-wrap-mark')) old.remove()
  if (!wrapCode()) return

  // The chip and any annotation badge are children of the pre; their labels are
  // not code and measuring them invents a wrap on the last line.
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT, (n) =>
    n.parentElement.closest(`${CHROME_CONTROLS}, .sf-marker`)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT)
  const nodes = []
  let text = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, at: text.length })
    text += n.data
  }
  if (!nodes.length) return

  const top = pre.getBoundingClientRect().top
  const range = document.createRange()
  const tops = []
  let start = 0
  let k = 0
  for (const line of text.split('\n')) {
    const end = start + line.length
    if (line.length) {
      while (k + 1 < nodes.length && nodes[k + 1].at <= start) k++
      let j = k
      while (j + 1 < nodes.length && nodes[j + 1].at <= end) j++
      range.setStart(nodes[k].node, start - nodes[k].at)
      range.setEnd(nodes[j].node, end - nodes[j].at)
      const rects = range.getClientRects()
      for (let i = 0; i < rects.length - 1; i++) tops.push(rects[i].top - top)
    }
    start = end + 1
  }

  for (const y of tops) {
    const mark = el('span', 'sf-wrap-mark', '↵')
    mark.setAttribute('aria-hidden', 'true')
    mark.style.top = `${y}px`
    pre.appendChild(mark)
  }
}

function toggleWrapCode() {
  if (wrapCode()) localStorage.removeItem(WRAP_STORAGE)
  else localStorage.setItem(WRAP_STORAGE, 'on')
  applyWrapCode()
}

function postToWhiteboard(message) {
  if (ui.wbFrame?.contentWindow && wbChannelId) {
    ui.wbFrame.contentWindow.postMessage({ ...message, channelId: wbChannelId, diagramIndex: wbIndex }, '*')
  }
}

function showWhiteboardError(text) {
  ui.wbError.textContent = text
  show(ui.wbError, true)
}

function openWhiteboard(index) {
  if (wbIndex !== null) return
  wbIndex = index
  wbReady = false
  wbChannelId = ''
  show(ui.wbError, false)
  show(ui.wbOverlay, true)
  // A fresh document per open: no stale editor state can leak between opens.
  ui.wbFrame.src = `/whiteboard-frame?key=${encodeURIComponent(KEY)}&diagramIndex=${index}`
}

function finishWhiteboardClose() {
  show(ui.wbOverlay, false)
  show(ui.wbError, false)
  ui.wbFrame.src = 'about:blank'
  wbIndex = null
  wbReady = false
  wbChannelId = ''
}

function closeWhiteboard() {
  const index = wbIndex
  if (index === null) return
  if (!wbReady) return finishWhiteboardClose()
  beginTeardown(index, (flushed) => {
    if (flushed && wbIndex === index) finishWhiteboardClose()
    else if (!flushed) showWhiteboardError('Could not save your drawing — close again to retry.')
  })
}

// Serialised per diagram: concurrent PUTs would let an older scene land last.
function chainWhiteboardWrite(index, run) {
  const previous = saveChains.get(index) || Promise.resolve()
  // The base is read when the turn comes, not when the write was queued.
  const result = previous.catch(() => {}).then(() => run(wbVersions.get(index) ?? 0))
  const tail = result.catch(() => {})
  saveChains.set(index, tail)
  tail.finally(() => {
    if (saveChains.get(index) === tail) saveChains.delete(index)
  })
  return result
}

function handleWhiteboardSave(index, message) {
  chainWhiteboardWrite(index, (baseVersion) =>
    api
      .send('PUT', `/api/b/${KEY}/whiteboard/${index}`, {
        scene: message.scene,
        sourceHash: message.sourceHash,
        baseVersion,
      })
      .then((res) => {
        if (Number.isInteger(res.whiteboard?.version)) wbVersions.set(index, res.whiteboard.version)
        return res
      })
  ).then(
    () =>
      postToWhiteboard({
        type: WB.saveResult,
        flushId: message.flushId,
        ok: true,
      }),
    (err) =>
      postToWhiteboard({
        type: WB.saveResult,
        flushId: message.flushId,
        ok: false,
        error: err.message,
        conflict: err.body?.code === 'whiteboard_conflict',
      })
  )
}

// The frame saves on demand and answers; nothing closes until it has.
function beginTeardown(index, onComplete) {
  const pending = teardowns.get(index)
  if (pending) {
    if (onComplete) pending.promise.then(onComplete)
    return pending.promise
  }
  const flushId = `teardown-${++nextFlushId}`
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  teardowns.set(index, { flushId, promise, resolve, onComplete })
  postToWhiteboard({ type: WB.prepareTeardown, flushId })
  return promise
}

function settleTeardown(index, message, ok) {
  const teardown = teardowns.get(index)
  if (!teardown || teardown.flushId !== String(message.flushId || '')) return
  teardowns.delete(index)
  teardown.onComplete?.(ok)
  teardown.resolve(ok)
}

function beginFlush(index) {
  const pending = flushes.get(index)
  if (pending) return pending.promise
  const flushId = `flush-${++nextFlushId}`
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  flushes.set(index, { flushId, promise, resolve })
  postToWhiteboard({ type: WB.flush, flushId })
  return promise
}

function finishFlush(index, message) {
  const flush = flushes.get(index)
  if (!flush || flush.flushId !== String(message.flushId || '')) return
  flushes.delete(index)
  flush.resolve(Boolean(message.ok))
}

async function authenticateWhiteboard(index, token) {
  try {
    await api.send('POST', `/api/b/${KEY}/whiteboard-channel`, { token })
  } catch {
    return false
  }
  if (wbIndex !== index) return false
  wbChannelId = token
  const qs = state.viewingRound != null ? `?round=${state.viewingRound}` : ''
  let info
  try {
    info = await api.get(`/api/b/${KEY}/whiteboard/${index}${qs}`)
  } catch (err) {
    showWhiteboardError(`Could not open the whiteboard: ${err.message}`)
    return false
  }
  if (wbIndex !== index) return false
  wbVersions.set(index, info.whiteboard?.version ?? 0)
  postToWhiteboard({
    type: WB.init,
    source: info.source,
    sourceHash: info.sourceHash,
    saved: info.whiteboard?.scene ?? null,
    stale: info.stale,
    reason: info.reason,
    theme: wbTheme(),
    ended,
  })
  return true
}

async function queueWhiteboardFeedback(index, message) {
  try {
    // Joins the save chain: a send racing this tab's own autosave would
    // otherwise carry the version that autosave has just superseded.
    await chainWhiteboardWrite(index, (baseVersion) =>
      api
        .send('POST', `/api/b/${KEY}/whiteboard/${index}/feedback`, {
          clientId,
          scene: message.scene,
          note: message.note,
          summaryLines: message.summaryLines,
          sourceHash: message.sourceHash,
          baseVersion,
        })
        .then((res) => {
          if (Number.isInteger(res.whiteboardVersion)) wbVersions.set(index, res.whiteboardVersion)
          return res
        })
    )
    postToWhiteboard({ type: WB.queueResult, ok: true })
    finishWhiteboardClose()
    sync()
  } catch (err) {
    postToWhiteboard({
      type: WB.queueResult,
      ok: false,
      error: err.message,
      conflict: err.body?.code === 'whiteboard_conflict',
    })
  }
}

window.addEventListener('message', async (event) => {
  if (!ui.wbFrame || event.source !== ui.wbFrame.contentWindow || wbIndex === null) return
  const message = event.data || {}
  if (Number(message.diagramIndex) !== wbIndex) return
  const index = wbIndex
  if (message.type === WB.ready) {
    const token = String(message.channelToken || '')
    if (!token || wbChannelId) return
    const ok = await authenticateWhiteboard(index, token)
    if (ok && wbIndex === index) wbReady = true
    return
  }
  if (!wbReady || message.channelId !== wbChannelId) return
  if (message.type === WB.save) handleWhiteboardSave(index, message)
  if (message.type === WB.queueFeedback) queueWhiteboardFeedback(index, message)
  if (message.type === WB.close) closeWhiteboard()
  if (message.type === WB.teardownReady) settleTeardown(index, message, true)
  if (message.type === WB.teardownFailed) settleTeardown(index, message, false)
  if (message.type === WB.flushComplete) finishFlush(index, message)
})

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (wbReady) postToWhiteboard({ type: WB.themeChanged, theme: wbTheme() })
})

window.addEventListener('pagehide', () => {
  if (wbIndex !== null && wbReady) beginFlush(wbIndex)
})

// ----------------------------------------------------------------- tuner --

// v2: overrides now apply on every load, so campaign-era 'sf-tuner' state
// (already baked into lantern) must not resurface as a global override.
const TUNER_STORAGE = 'sf-tuner-v2'
const TUNER_VARS = [
  ['Page ground', '--color-base-200'],
  ['Panels', '--color-base-100'],
  ['Raised / code', '--color-base-300'],
  ['Emphasis ink', '--color-base-content'],
  ['Body ink', '--color-body-content'],
  ['Muted ink', '--color-muted-content'],
  ['Primary accent', '--color-primary'],
  ['Secondary accent', '--color-accent-2'],
  ['Borders', '--border'],
]
const TUNER_FONTS = [
  ['System sans', "ui-sans-serif, -apple-system, 'Segoe UI', system-ui, sans-serif"],
  ['Iowan Old Style', "'Iowan Old Style', 'Palatino Linotype', Georgia, serif"],
  ['Charter', "'Charter', Georgia, serif"],
  ['Hoefler Text', "'Hoefler Text', 'Athelas', Georgia, serif"],
  ['Baskerville', "'Baskerville', 'Palatino Linotype', Georgia, serif"],
  ['Optima', "'Optima', 'Seravek', sans-serif"],
  ['Avenir Next', "'Avenir Next', 'Seravek', sans-serif"],
  ['Helvetica Neue', "'Helvetica Neue', Helvetica, sans-serif"],
  ['American Typewriter', "'American Typewriter', 'Courier New', serif"],
  ['Didot', "'Didot', 'Bodoni 72', 'Hoefler Text', serif"],
]

function tunerState() {
  try { return JSON.parse(localStorage.getItem(TUNER_STORAGE)) || {} } catch { return {} }
}

function tunerSave(s) { localStorage.setItem(TUNER_STORAGE, JSON.stringify(s)) }

function tunerApply(s) {
  for (const [k, v] of Object.entries(s.vars || {})) document.documentElement.style.setProperty(k, v)
  if (s.bodyFont) document.body.style.fontFamily = s.bodyFont
  if (s.headFont) document.documentElement.style.setProperty('--font-serif', s.headFont)
  if (s.size) document.body.style.fontSize = `${s.size}px`
  if (s.lh) document.body.style.lineHeight = s.lh
}

// Any CSS color → #rrggbb, via canvas normalization (oklch parses fine).
function tunerHex(varName) {
  const probe = el('span')
  probe.style.color = `var(${varName})`
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  const ctx = el('canvas').getContext('2d')
  ctx.fillStyle = resolved
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
}

let tunerPanel = null

function toggleTuner() {
  if (!tunerPanel) tunerPanel = buildTuner()
  const open = tunerPanel.classList.toggle('sf-open')
  ui.tunerToggle.classList.toggle('sf-on', open)
}

function buildTuner() {
  const s = tunerState()
  const panel = el('aside', 'sf-tuner')
  panel.append(el('div', 'sf-tuner-title', 'Theme tuner'))

  for (const [label, varName] of TUNER_VARS) {
    const row = el('label', 'sf-tuner-row', label)
    const input = el('input', 'sf-tuner-color')
    input.type = 'color'
    input.value = s.vars?.[varName]?.startsWith('#') ? s.vars[varName] : tunerHex(varName)
    input.oninput = () => {
      s.vars = s.vars || {}
      s.vars[varName] = input.value
      document.documentElement.style.setProperty(varName, input.value)
      tunerSave(s)
    }
    row.appendChild(input)
    panel.appendChild(row)
  }

  const fontRow = (label, key, apply) => {
    const row = el('label', 'sf-tuner-row', label)
    const select = el('select', 'sf-tuner-select')
    select.append(new Option('(theme default)', ''))
    for (const [name, stack] of TUNER_FONTS) select.append(new Option(name, stack))
    select.value = s[key] || ''
    select.onchange = () => {
      s[key] = select.value || undefined
      apply(select.value)
      tunerSave(s)
    }
    row.appendChild(select)
    panel.appendChild(row)
  }
  fontRow('Body font', 'bodyFont', (v) => { document.body.style.fontFamily = v })
  fontRow('Heading font', 'headFont', (v) => {
    if (v) document.documentElement.style.setProperty('--font-serif', v)
    else document.documentElement.style.removeProperty('--font-serif')
  })

  const rangeRow = (label, key, min, max, step, fallback, apply) => {
    const row = el('label', 'sf-tuner-row', label)
    const input = el('input', 'sf-tuner-range')
    input.type = 'range'
    input.min = min; input.max = max; input.step = step
    input.value = s[key] || fallback
    input.oninput = () => {
      s[key] = input.value
      apply(input.value)
      tunerSave(s)
    }
    row.appendChild(input)
    panel.appendChild(row)
  }
  rangeRow('Body size', 'size', 14, 19, 0.5, parseFloat(getComputedStyle(document.body).fontSize), (v) => { document.body.style.fontSize = `${v}px` })
  rangeRow('Leading', 'lh', 1.4, 2.0, 0.02, 1.7, (v) => { document.body.style.lineHeight = v })

  const actions = el('div', 'sf-tuner-actions')
  // Edits already persist as they happen; this is the close that says so.
  const save = el('button', 'sf-tuner-send', 'Save as default')
  save.type = 'button'
  save.onclick = () => {
    toggleTuner()
    toast('Saved — applies to every board in this browser')
  }
  const reset = el('button', 'sf-tuner-reset', 'Reset')
  reset.type = 'button'
  reset.onclick = () => { localStorage.removeItem(TUNER_STORAGE); location.reload() }
  actions.append(save, reset)
  panel.appendChild(actions)
  document.body.appendChild(panel)
  return panel
}

// ---------------------------------------------------------------- boot

buildChrome()
buildWhiteboard()
setAnnotating(true)
sync()
startEvents()
tunerApply(tunerState())
if (new URLSearchParams(location.search).has('tuner')) toggleTuner()
