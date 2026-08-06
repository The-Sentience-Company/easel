/* easeld-launcher.sh runs under launchd KeepAlive {SuccessfulExit: false},
   which respawns on any NON-zero exit — so a config failure must exit 0. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LAUNCHER = join(HERE, '..', 'install', 'easeld-launcher.sh')

/* The launcher probes absolute system node paths that no env tweak can hide.
   This copy redirects only that list; every other line is verbatim. */
function launcherWithNoSystemNode(box) {
  const src = readFileSync(LAUNCHER, 'utf8')
  const empty = join(box, 'nowhere')
  mkdirSync(empty, { recursive: true })
  const patched = src.replace(
    '/opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node',
    `${empty}/a ${empty}/b ${empty}/c`,
  )
  assert.notEqual(patched, src, 'launcher no longer probes the expected system paths')

  const install = join(box, 'install')
  mkdirSync(install, { recursive: true })
  const copy = join(install, 'easeld-launcher.sh')
  writeFileSync(copy, patched)
  chmodSync(copy, 0o755)
  return copy
}

function runWithoutNode(extraEnv = {}) {
  const box = mkdtempSync(join(tmpdir(), 'easel-nonode-'))
  const script = launcherWithNoSystemNode(box)
  // spawnSync, not execFileSync: the diagnostics go to stderr, which the
  // success path of execFileSync discards.
  const r = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    timeout: 15000,
    env: { PATH: '/usr/bin:/bin', HOME: box, NVM_DIR: join(box, 'no-nvm'), ...extraEnv },
  })
  return { code: r.status, log: String(r.stdout || '') + String(r.stderr || '') }
}

describe('easeld-launcher.sh: no usable node', () => {
  const result = runWithoutNode()

  test('exits 0 so KeepAlive does not respawn it in a hot loop', () => {
    assert.equal(result.code, 0, `exited ${result.code}; any non-zero status hot-loops under KeepAlive`)
  })

  test('says why, loudly, in the log', () => {
    assert.match(result.log, /FATAL/)
    assert.match(result.log, /no usable node interpreter/)
    assert.match(result.log, /EASEL_NODE/, 'the log must name the override that fixes it')
  })
})

describe('easeld-launcher.sh: EASEL_NODE override', () => {
  test('a non-executable override does not satisfy the check', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-badnode-'))
    const fake = join(box, 'not-node')
    writeFileSync(fake, 'text, not an executable\n')
    const result = runWithoutNode({ EASEL_NODE: fake })
    assert.equal(result.code, 0)
    assert.match(result.log, /no usable node interpreter/)
  })

  test('an executable override is used and the resolved path is logged', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-goodnode-'))
    const shim = join(box, 'fake-node')
    writeFileSync(shim, '#!/bin/bash\nif [ "$1" = "--version" ]; then echo v99.0.0; exit 0; fi\nexit 0\n')
    chmodSync(shim, 0o755)
    const result = runWithoutNode({ EASEL_NODE: shim })
    assert.equal(result.code, 0)
    assert.match(result.log, /v99\.0\.0/)
    assert.doesNotMatch(result.log, /FATAL/)
  })
})
