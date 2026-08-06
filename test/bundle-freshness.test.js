/* Guards for the bundle-freshness check. The daemon serves render/.gen, so an
   e2e run against a stale build silently tests the previous one. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { staleBundles, assertBundleFresh, REBUILD_CMD, BUNDLES } from './harness.js'

const HOUR = 3600

/* A synthetic tree, so a deliberately backdated artifact never touches the real
   render/.gen — the check is what is under test, not this worktree. */
function tree({ inputAgeS, outputAgeS, writeOutput = true }) {
  const root = mkdtempSync(join(tmpdir(), 'sf-fresh-'))
  const out = 'render/.gen/whiteboard/whiteboard.js'
  const input = 'chrome/whiteboard-frame.js'
  const now = Date.now() / 1000
  for (const rel of [out, input]) {
    if (rel === out && !writeOutput) continue
    mkdirSync(join(root, dirname(rel)), { recursive: true })
    writeFileSync(join(root, rel), '//')
  }
  utimesSync(join(root, input), now - inputAgeS, now - inputAgeS)
  if (writeOutput) utimesSync(join(root, out), now - outputAgeS, now - outputAgeS)
  return { root, bundles: [{ out, inputs: [input] }] }
}

describe('a stale bundle is caught before the daemon starts', () => {
  test('an input newer than its artifact is reported, naming the artifact', () => {
    const { root, bundles } = tree({ inputAgeS: 0, outputAgeS: HOUR })
    const stale = staleBundles(root, bundles)
    assert.equal(stale.length, 1)
    assert.match(stale[0].out, /whiteboard\.js$/)
    assert.match(stale[0].input, /whiteboard-frame\.js$/)
  })

  test('an artifact newer than its input is clean', () => {
    const { root, bundles } = tree({ inputAgeS: HOUR, outputAgeS: 0 })
    assert.deepEqual(staleBundles(root, bundles), [])
  })

  test('an absent artifact is not staleness — the build legitimately skips', () => {
    // Without esbuild the bundles are never built, and those installs have no
    // whiteboard to test. Reporting that as stale would fail every e2e run.
    const { root, bundles } = tree({ inputAgeS: 0, outputAgeS: 0, writeOutput: false })
    assert.deepEqual(staleBundles(root, bundles), [])
  })
})

describe('the failure says what to do about it', () => {
  test('the thrown message names the stale artifact and the rebuild command', () => {
    const { root, bundles } = tree({ inputAgeS: 0, outputAgeS: HOUR })
    assert.throws(() => assertBundleFresh(root, bundles),
      (err) => /stale bundle/.test(err.message) &&
        /whiteboard\.js is older than/.test(err.message) &&
        /whiteboard-frame\.js/.test(err.message) &&
        /node render\/build-excalidraw\.mjs/.test(err.message))
  })

  test('a fresh tree returns true rather than throwing', () => {
    const { root, bundles } = tree({ inputAgeS: HOUR, outputAgeS: 0 })
    assert.equal(assertBundleFresh(root, bundles), true)
  })

  test('the rebuild command is the one that actually builds the bundles', () => {
    assert.equal(REBUILD_CMD, 'node render/build-excalidraw.mjs')
  })
})

describe('the build script counts as an input to everything it emits', () => {
  test('every artifact lists the builder', () => {
    // Changing which assets the builder copies stales every artifact without
    // touching a single source file, so no entry may omit it.
    for (const { out, inputs } of BUNDLES) {
      assert.ok(inputs.includes('render/build-excalidraw.mjs'),
        `${out} does not treat the build script as an input`)
    }
  })

  test('a builder newer than an artifact is stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'sf-fresh-b-'))
    const out = 'render/.gen/excalidraw-bundle.js'
    const builder = 'render/build-excalidraw.mjs'
    const now = Date.now() / 1000
    for (const rel of [out, builder]) {
      mkdirSync(join(root, dirname(rel)), { recursive: true })
      writeFileSync(join(root, rel), '//')
    }
    utimesSync(join(root, out), now - HOUR, now - HOUR)
    utimesSync(join(root, builder), now, now)
    const stale = staleBundles(root, [{ out, inputs: [builder] }])
    assert.equal(stale.length, 1, 'a newer build script did not stale its artifact')
  })
})

describe('this worktree is fresh right now', () => {
  test('no bundle input is newer than its artifact', () => {
    // Fails the moment someone edits a bundle input without rebuilding — which
    // is the whole point, and is cheaper to read than 7 whiteboard e2e failures.
    assert.equal(assertBundleFresh(), true)
  })
})
