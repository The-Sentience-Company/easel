/* Fixups applied to a mermaid→excalidraw skeleton, shared by the publish-time
   converter (via window.__excal) and the live whiteboard frame. */

// Open Color blue-2 / yellow-2, the excalidraw background picker's own swatches.
const NODE_FILL = '#a5d8ff'
const DECISION_FILL = '#ffec99'

const FILLABLE = new Set(['rectangle', 'ellipse', 'diamond'])

const hasColor = (el) => Boolean(el.backgroundColor || el.strokeColor)

/** Excalidraw text has no markup, so a <br/> label arrives literal; the node is
    already sized for the extra line. */
function unwrapBreaks(elements) {
  const br = /<br\s*\/?>/gi
  for (const el of elements) {
    if (typeof el.text === 'string') el.text = el.text.replace(br, '\n')
    if (typeof el.label?.text === 'string') el.label.text = el.label.text.replace(br, '\n')
  }
}

/** Colour is only ever what the source declared, so an unstyled diagram converts
    to white boxes. Filled in per diagram: half-painting a styled one invents meaning. */
export function normalizeSkeleton(elements) {
  if (!Array.isArray(elements)) return elements
  unwrapBreaks(elements)
  if (elements.some(hasColor)) return elements
  for (const el of elements) {
    // Connectors keep the default stroke; colouring those reads as noise.
    if (!FILLABLE.has(el.type)) continue
    el.backgroundColor = el.type === 'diamond' ? DECISION_FILL : NODE_FILL
    // Solid, matching what the library emits when it does map a declared fill.
    el.fillStyle = 'solid'
  }
  return elements
}
