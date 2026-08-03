/* Whiteboard frame: the excalidraw editor, sandboxed, talking to the chrome over
   postMessage. Bundled by render/build-excalidraw.mjs; protocol in docs/api.md. */

import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import { createElement, useEffect, useState, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { WB } from './whiteboard-protocol.js'

// EXCALIDRAW_ASSET_PATH is set by the frame page, not here: excalidraw registers
// its fonts at module init, which import hoisting runs before this file's body.

const AUTOSAVE_MS = 800
const DIAGRAM_INDEX = Number(new URLSearchParams(location.search).get('diagramIndex'))
// Minted by the daemon and injected into the frame HTML: a frame cannot mint its
// own, so the chrome's channel check means something.
const CHANNEL_TOKEN = String(window.__easelWhiteboardChannelToken || '')

let channelId = ''

// The sandbox gives this document an opaque origin, so it cannot name the
// parent's; the chrome authenticates us by token and event.source instead.
function post(message) {
  parent.postMessage({ ...message, diagramIndex: DIAGRAM_INDEX, channelId }, '*')
}

/** Element counts plus any text, so the agent gets something readable without
    parsing the scene JSON. */
function summarize(elements) {
  const counts = new Map()
  const texts = []
  for (const el of elements) {
    if (el.isDeleted) continue
    counts.set(el.type, (counts.get(el.type) || 0) + 1)
    if (el.type === 'text' && el.text) texts.push(el.text.trim())
  }
  const shape = [...counts.entries()].map(([type, n]) => `${n} ${type}`).join(', ')
  return [shape ? `Elements: ${shape}` : 'Empty canvas', ...texts.filter(Boolean).map((t) => `- ${t}`)]
}

// Measuring before the font resolves reserves less than gets painted, so labels
// clip. The text is passed because the face is split into unicode subsets.
async function drawingFontReady(text) {
  try {
    await document.fonts.load('20px Excalifont', String(text || ''))
  } catch {}
  await document.fonts.ready
}

const STALE_TEXT =
  'The diagram this whiteboard came from changed in a newer round. Your drawing is kept as-is — ' +
  'reopen from the current round to start from the new diagram.'

const CONFLICT_TEXT =
  'Someone else saved this whiteboard while you were drawing. Your work is still on the canvas but can no longer be ' +
  'saved over theirs — copy what you need, then close and reopen to start from their version.'

const ENDED_TEXT =
  'This board has ended. The saved drawing is here to read, but nothing more can be saved or sent to the agent.'

function App() {
  const [api, setApi] = useState(null)
  const [theme, setTheme] = useState('light')
  const [status, setStatus] = useState({ kind: 'loading', text: 'Loading the diagram…' })
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [ended, setEnded] = useState(false)
  const [conflict, setConflict] = useState(false)
  // Refs, not state: the message handler is installed once and must read live
  // values without re-subscribing.
  const apiRef = useRef(null)
  const hashRef = useRef('')
  const saveTimer = useRef(null)
  const pending = useRef(new Map())
  // Signature of the scene the daemon holds, so an open is a read and a passive
  // tab's close cannot overwrite another tab's newer work.
  const lastSaved = useRef(null)
  const inFlight = useRef(new Map())
  const autoSeq = useRef(0)
  // The message handler and save() are installed once and must see the live value.
  const endedRef = useRef(false)
  const conflictRef = useRef(false)

  apiRef.current = api

  const sceneNow = () => {
    const a = apiRef.current
    if (!a) return null
    return {
      type: 'excalidraw',
      version: 2,
      elements: a.getSceneElements(),
      appState: { viewBackgroundColor: a.getAppState().viewBackgroundColor },
      files: a.getFiles(),
    }
  }

  // Element versions bump on every edit including deletes; the background colour
  // is the one saved thing that is not an element.
  const signature = (scene) =>
    JSON.stringify([scene.appState.viewBackgroundColor, scene.elements.map((el) => [el.id, el.version])])

  // Excalidraw opens at 100%, so a wide diagram loads with its edge labels cut off.
  // rAF: the canvas must be laid out before it can be measured against.
  const fitBoard = () =>
    requestAnimationFrame(() => apiRef.current?.scrollToContent(undefined, { fitToContent: true }))

  const markLoaded = () => {
    const scene = sceneNow()
    if (scene) lastSaved.current = signature(scene)
  }

  const save = (flushId) => {
    // The server refuses writes to an ended board, so posting one would only
    // fail the close and trap the tab on "close again to retry".
    // Retrying a conflicted save just conflicts again; the banner has already
    // told the reviewer, and the close button says what closing will cost.
    if (endedRef.current || conflictRef.current) {
      if (flushId) replyDone(flushId, true)
      return
    }
    const scene = sceneNow()
    if (!scene) {
      if (flushId) replyDone(flushId, false)
      return
    }
    const sig = signature(scene)
    if (sig === lastSaved.current) {
      if (flushId) replyDone(flushId, true)
      return
    }
    // Autosaves carry an id too: lastSaved may only advance on an acknowledged
    // write, or a failed save would leave the tab thinking it is clean.
    const id = flushId || `auto-${++autoSeq.current}`
    inFlight.current.set(id, sig)
    post({ type: WB.save, scene, sourceHash: hashRef.current, flushId: id })
  }

  // Ended outranks stale and blank: it is the one banner that changes what the
  // reviewer can still do.
  const showStatus = (s) => setStatus(endedRef.current ? { kind: 'ended', text: ENDED_TEXT } : s)

  /* Their canvas is never replaced with the stored scene — that would be data
     loss wearing a fix's clothes. It stays put, unsaveable, and says so. */
  const applyConflict = () => {
    conflictRef.current = true
    setConflict(true)
    setStatus({ kind: 'conflict', text: CONFLICT_TEXT })
  }

  const applyEnded = () => {
    endedRef.current = true
    setEnded(true)
    setStatus({ kind: 'ended', text: ENDED_TEXT })
  }

  const replyDone = (flushId, ok) => {
    const kind = pending.current.get(flushId)
    if (!kind) return
    pending.current.delete(flushId)
    if (kind === 'teardown') {
      post({ type: ok ? WB.teardownReady : WB.teardownFailed, flushId })
    } else {
      post({ type: WB.flushComplete, flushId, ok })
    }
  }

  // Mirrored onto <html> so the frame's own chrome follows the board's theme
  // rather than the OS, which prefers-color-scheme would have given it.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    const onMessage = async (event) => {
      if (event.source !== parent) return
      const message = event.data || {}
      if (message.type === WB.init) {
        channelId = String(message.channelId || '')
        hashRef.current = String(message.sourceHash || '')
        setTheme(message.theme === 'dark' ? 'dark' : 'light')
        if (message.ended) applyEnded()
        const a = apiRef.current
        if (!a) return
        if (message.saved?.elements) {
          a.updateScene({ elements: message.saved.elements })
          if (message.saved.files) a.addFiles(Object.values(message.saved.files))
          markLoaded()
          fitBoard()
          showStatus(message.stale ? { kind: 'stale', text: STALE_TEXT } : { kind: 'ok', text: '' })
          return
        }
        if (!message.source) {
          markLoaded()
          showStatus({ kind: 'blank', text: message.reason || 'This diagram has no stored source — starting blank.' })
          return
        }
        try {
          await drawingFontReady(message.source)
          const { elements, files } = await parseMermaidToExcalidraw(message.source)
          // <br/> labels arrive literal; render them as line breaks. Mirrors PAGE_JOB.
          const br = /<br\s*\/?>/gi
          for (const el of elements) {
            if (typeof el.text === 'string') el.text = el.text.replace(br, '\n')
            if (typeof el.label?.text === 'string') el.label.text = el.label.text.replace(br, '\n')
          }
          a.updateScene({ elements: convertToExcalidrawElements(elements) })
          if (files) a.addFiles(Object.values(files))
          fitBoard()
          showStatus({ kind: 'ok', text: '' })
        } catch (err) {
          showStatus({ kind: 'blank', text: `Could not convert this diagram (${err.message}) — starting blank.` })
        }
        markLoaded()
        return
      }
      if (!channelId || message.channelId !== channelId) return
      if (message.type === WB.themeChanged) setTheme(message.theme === 'dark' ? 'dark' : 'light')
      if (message.type === WB.sourceChanged) showStatus({ kind: 'stale', text: STALE_TEXT })
      if (message.type === WB.boardEnded) applyEnded()
      if (message.type === WB.prepareTeardown || message.type === WB.flush) {
        const kind = message.type === WB.prepareTeardown ? 'teardown' : 'flush'
        pending.current.set(String(message.flushId || ''), kind)
        clearTimeout(saveTimer.current)
        save(String(message.flushId || ''))
      }
      if (message.type === WB.saveResult) {
        const id = String(message.flushId || '')
        if (message.ok && inFlight.current.has(id)) lastSaved.current = inFlight.current.get(id)
        inFlight.current.delete(id)
        if (message.conflict) applyConflict()
        if (id) replyDone(id, Boolean(message.ok) || Boolean(message.conflict))
        if (!message.ok && !message.conflict) setStatus({ kind: 'error', text: `Save failed: ${message.error || 'unknown error'}` })
      }
      if (message.type === WB.queueResult) {
        setSending(false)
        if (message.conflict) applyConflict()
        else if (!message.ok) setStatus({ kind: 'error', text: `Send failed: ${message.error || 'unknown error'}` })
      }
    }
    window.addEventListener('message', onMessage)
    post({ type: WB.ready, channelToken: CHANNEL_TOKEN })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Escape reaches this frame, not the chrome, so closing is forwarded. Capture
  // phase reads what excalidraw is about to consume; only a bare Escape closes.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      const s = apiRef.current?.getAppState()
      if (!s) return
      if (s.openMenu || s.openDialog || s.openPopup || s.contextMenu || s.showHyperlinkPopup) return
      if (s.editingTextElement || s.newElement || s.editingLinearElement) return
      post({ type: WB.close })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const onChange = () => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => save(''), AUTOSAVE_MS)
  }

  const send = () => {
    const scene = sceneNow()
    if (!scene || sending || endedRef.current || conflictRef.current) return
    setSending(true)
    post({
      type: WB.queueFeedback,
      scene,
      note,
      summaryLines: summarize(scene.elements),
      sourceHash: hashRef.current,
    })
  }

  return createElement(
    'div',
    { className: 'wb-root' },
    status.text ? createElement('div', { className: `wb-banner wb-${status.kind}`, role: 'status' }, status.text) : null,
    createElement(
      'div',
      { className: 'wb-canvas' },
      createElement(Excalidraw, {
        excalidrawAPI: setApi,
        theme,
        onChange,
        viewModeEnabled: ended,
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false } },
      })
    ),
    createElement(
      'div',
      { className: 'wb-bar' },
      createElement('input', {
        className: 'wb-note',
        placeholder: 'Note for the agent (optional)',
        value: note,
        onChange: (e) => setNote(e.target.value),
        disabled: ended,
      }),
      createElement(
        'button',
        { className: 'wb-send', onClick: send, disabled: sending || ended || conflict },
        sending ? 'Sending…' : 'Send to agent'
      ),
      createElement(
        'button',
        { className: 'wb-fit', onClick: () => apiRef.current?.scrollToContent(undefined, { fitToContent: true }) },
        'Fit to diagram'
      ),
      createElement(
        'button',
        { className: 'wb-close', onClick: () => post({ type: WB.close }) },
        conflict ? 'Close without saving' : 'Close'
      )
    )
  )
}

createRoot(document.getElementById('wb')).render(createElement(App))
