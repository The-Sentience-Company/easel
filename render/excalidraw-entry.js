// Browser-side entry for the publish-time excalidraw pipeline; bundled by
// render/build-excalidraw.mjs and injected into headless chromium.
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import { convertToExcalidrawElements, exportToSvg } from '@excalidraw/excalidraw'
import { normalizeSkeleton } from './diagram-palette.js'

window.__excal = { parseMermaidToExcalidraw, convertToExcalidrawElements, exportToSvg, normalizeSkeleton }
