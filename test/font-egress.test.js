// The publish path must resolve excalidraw's fonts from disk, never the CDN
// baked into the package, and must never claim the sketch look without them.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createConverter, fontsEmbedded } from '../render/excalidraw.js'

const SLOW = { timeout: 180000 }
const FLOW = 'graph TD\n  A[login] --> B[session]'

describe('a font the SVG names but did not embed is not success', () => {
  const withFont = 'font-family: Excalifont; src: url(data:font/woff2;base64,' + 'A'.repeat(200) + ')'
  test('an Excalifont reference with no embedded face is rejected', () => {
    assert.equal(fontsEmbedded('<svg><style>font-family: Excalifont</style></svg>'), false)
  })
  test('an Excalifont reference with a real embedded face passes', () => {
    assert.equal(fontsEmbedded(`<svg><style>${withFont}</style></svg>`), true)
  })
  // A mermaid fallback names no custom family and must not be failed by this.
  test('an SVG naming no custom font is unaffected', () => {
    assert.equal(fontsEmbedded('<svg><text>hi</text></svg>'), true)
  })
})

describe('conversion resolves fonts without the network', () => {
  test('a converted diagram embeds a real woff2 face', SLOW, async () => {
    const converter = await createConverter({})
    try {
      const out = await converter.convert(FLOW)
      assert.ok(out.ok, `conversion failed: ${out.message}`)
      assert.match(out.light, /url\(\s*data:font\/woff2;base64,[A-Za-z0-9+/=]{100,}/)
    } finally {
      await converter.close()
    }
  })

  // Every outbound route is dead, so whatever is still embedded came off disk.
  // Compares font bytes, not the SVG: rough.js reseeds every shape per run.
  test('embedded font bytes are identical with every network route dead', SLOW, async () => {
    const fontOf = (svg) => (svg.match(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/) || [])[1] || null
    const convert = async (launchArgs) => {
      const converter = await createConverter({ launchArgs })
      try {
        return await converter.convert(FLOW)
      } finally {
        await converter.close()
      }
    }

    const online = await convert([])
    const dead = await convert(['--proxy-server=127.0.0.1:1'])
    assert.ok(dead.ok, `conversion failed with the network dead: ${dead.message}`)

    const a = fontOf(online.light)
    const b = fontOf(dead.light)
    assert.ok(a && a.length > 100, 'the online run embedded no font to compare against')
    assert.equal(b, a, 'a dead network changed the embedded font — it was being fetched')
  })
})
