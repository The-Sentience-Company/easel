// easel events worker — one EventSource for the whole origin, fanned out to
// tabs by board key over MessagePort (endpoint documented in docs/api.md).

const ports = new Map() // MessagePort -> board key

let es = null
let esKeys = null
let backoff = 1000
let status = 'connecting'
let retryTimer = null

function post(port, msg) {
  try {
    port.postMessage(msg)
  } catch {
    ports.delete(port)
    // Deferred: post() runs inside loops over ports, and the daemon-side tab
    // count must shrink once a dead port is dropped.
    queueMicrotask(ensureStream)
  }
}

function setStatus(next) {
  status = next
  for (const port of ports.keys()) post(port, { type: 'status', state: next })
}

function ensureStream() {
  clearTimeout(retryTimer)
  const wanted = [...ports.values()].sort().join(',')
  if (!wanted) {
    if (es) es.close()
    es = null
    esKeys = null
    return
  }
  if (es && esKeys === wanted) return
  if (es) es.close()
  esKeys = wanted
  es = new EventSource(`/events?keys=${encodeURIComponent(wanted)}`)
  es.onopen = () => {
    backoff = 1000
    setStatus('live')
  }
  es.onerror = () => {
    es.close()
    es = null
    esKeys = null
    setStatus('reconnecting')
    retryTimer = setTimeout(ensureStream, backoff)
    backoff = Math.min(backoff * 2, 15000)
  }
  es.addEventListener('hello', (e) => {
    const boards = JSON.parse(e.data).boards
    for (const [port, key] of ports) {
      const entry = boards[key] ?? { round: 0, wipAt: null, agentWaiting: false }
      post(port, { type: 'event', event: 'hello', data: entry })
    }
  })
  for (const name of ['round', 'wip', 'chat', 'feedback', 'agent', 'end']) {
    es.addEventListener(name, (e) => {
      const data = JSON.parse(e.data)
      for (const [port, key] of ports) if (key === data.key) post(port, { type: 'event', event: name, data })
    })
  }
}

onconnect = (e) => {
  const port = e.ports[0]
  port.onmessage = (m) => {
    if (m.data.type === 'attach') {
      ports.set(port, m.data.key)
      post(port, { type: 'status', state: status })
      ensureStream()
    } else if (m.data.type === 'detach') {
      ports.delete(port)
      ensureStream()
    }
  }
}
