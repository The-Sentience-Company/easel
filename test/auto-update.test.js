/* Exercises auto-update.sh's policy and generation helpers by extracting them
   from the shipped script — never runs --enable/--run, which would touch launchd. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'install', 'auto-update.sh')
const INSTALL = join(HERE, '..', 'install', 'install.sh')
const LAUNCHER = join(HERE, '..', 'install', 'easeld-launcher.sh')
const TEMPLATE = join(HERE, '..', 'install', 'com.sentience.easeld-update.plist.template')

/** Pull one `name() { ... }` block out of a script by brace depth. */
function extract(name, file = SCRIPT) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`))
  assert.notEqual(start, -1, `${file} no longer defines ${name}()`)
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  assert.fail(`unterminated ${name}() in ${file}`)
}

const runBash = (script) => execFileSync('bash', ['-c', script], { encoding: 'utf8' })

describe('auto-update.sh: shipped form', () => {
  test('git tracks it as executable', () => {
    const out = execFileSync('git', ['ls-files', '-s', 'install/auto-update.sh'], {
      cwd: join(HERE, '..'),
      encoding: 'utf8',
    })
    assert.match(out, /^100755 /, 'tracked non-executable — a clean checkout cannot exec it')
  })

  test('parses (bash -n)', () => {
    execFileSync('bash', ['-n', SCRIPT])
  })

  /* update.sh pulls again after the incoming range was logged, so a moving
     origin can land more than was promised — the landed range must be recorded. */
  test('a run records the landed range, not only the planned one', () => {
    const body = extract('run')
    assert.match(body, /landed:/)
    assert.match(body, /\$before\.\.HEAD/)
  })

  test('enable waits out launchd teardown before bootstrapping again', () => {
    assert.match(extract('enable_agent'), /bootout_if_loaded/)
  })

  /* The script lifts these by sed range instead of forking them; if either
     source stops matching the range, the lift silently evals nothing. */
  test('the functions it lifts from install.sh and the launcher still extract', () => {
    for (const [name, file] of [
      ['xml_escape', INSTALL],
      ['subst_value', INSTALL],
      ['bootout_if_loaded', INSTALL],
      ['resolve_node', LAUNCHER],
    ]) {
      const body = runBash(`sed -n '/^${name}() {/,/^}/p' ${JSON.stringify(file)}`)
      assert.match(body, new RegExp(`^${name}\\(\\) \\{`), `${name} no longer lifts from ${file}`)
      execFileSync('bash', ['-n'], { input: body })
    }
  })
})

describe('auto-update.sh: parse_at', () => {
  const fn = extract('parse_at')
  const parse = (raw) => runBash(`${fn}\nparse_at ${JSON.stringify(raw)}\necho "$HOUR $MINUTE"`)

  test('accepts 24h times and strips leading zeros for launchd', () => {
    assert.equal(parse('09:30').trim(), '9 30')
    assert.equal(parse('0:05').trim(), '0 5')
    assert.equal(parse('23:59').trim(), '23 59')
  })

  for (const bad of ['25:00', '10:60', '9', '9:5', 'noon', '10:00pm']) {
    test(`rejects ${bad}`, () => {
      assert.throws(() => parse(bad), /wants HH:MM/)
    })
  }
})

describe('auto-update.sh: plan_update', () => {
  const fn = extract('plan_update')

  /** A bare origin with one commit, and a clone of it on branch main. */
  const scratch = () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-auto-'))
    const origin = join(box, 'origin.git')
    const clone = join(box, 'clone')
    const seed = join(box, 'seed')
    const git = (cwd, ...args) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: box } })
    execFileSync('git', ['init', '--bare', '-b', 'main', origin], { encoding: 'utf8' })
    mkdirSync(seed)
    git(seed, 'init', '-b', 'main')
    git(seed, 'config', 'user.email', 't@t')
    git(seed, 'config', 'user.name', 't')
    writeFileSync(join(seed, 'a'), '1\n')
    git(seed, 'add', 'a')
    git(seed, 'commit', '-m', 'one')
    git(seed, 'remote', 'add', 'origin', origin)
    git(seed, 'push', 'origin', 'main')
    execFileSync('git', ['clone', origin, clone], { encoding: 'utf8' })
    git(clone, 'config', 'user.email', 't@t')
    git(clone, 'config', 'user.name', 't')
    return { box, origin, clone, seed, git }
  }

  const plan = (root) => runBash(`ROOT=${JSON.stringify(root)}\n${fn}\nplan_update`).trim()

  test('a current checkout is left alone', () => {
    const { clone } = scratch()
    assert.match(plan(clone), /^current [0-9a-f]+$/)
  })

  test('a checkout behind origin plans an update', () => {
    const { clone, seed, git } = scratch()
    writeFileSync(join(seed, 'a'), '2\n')
    git(seed, 'commit', '-am', 'two')
    git(seed, 'push', 'origin', 'main')
    assert.match(plan(clone), /^update [0-9a-f]+ [0-9a-f]+$/)
  })

  test('a dirty tree is a human situation', () => {
    const { clone } = scratch()
    writeFileSync(join(clone, 'a'), 'dirty\n')
    assert.equal(plan(clone), 'skip: working tree dirty')
  })

  test('a feature branch is a human situation', () => {
    const { clone, git } = scratch()
    git(clone, 'checkout', '-b', 'feature')
    assert.equal(plan(clone), 'skip: on feature, not main')
  })

  test('diverged history — a force-push, say — is a human situation', () => {
    const { clone, seed, git } = scratch()
    writeFileSync(join(seed, 'a'), '2\n')
    git(seed, 'commit', '-am', 'two')
    git(seed, 'push', 'origin', 'main')
    git(clone, 'commit', '--allow-empty', '-m', 'local divergence')
    assert.equal(plan(clone), 'skip: history diverged')
  })

  test('an unreachable origin skips instead of failing', () => {
    const { clone, origin } = scratch()
    execFileSync('rm', ['-rf', origin])
    assert.equal(plan(clone), 'skip: fetch failed')
  })
})

describe('auto-update.sh: plist generation', () => {
  const helpers = [extract('xml_escape', INSTALL), extract('subst_value', INSTALL), extract('write_agent_plist')].join('\n')

  const generate = () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-auto-plist-'))
    const out = join(box, 'test.plist')
    runBash(`
      LABEL=com.sentience.easeld-update
      ROOT=/Users/x/repos/easel
      STATE_DIR=/Users/x/.easel
      HOUR=9 MINUTE=30
      TEMPLATE=${JSON.stringify(TEMPLATE)}
      ${helpers}
      write_agent_plist ${JSON.stringify(out)}
    `)
    return out
  }

  test('every placeholder is substituted and the plist parses', () => {
    const out = generate()
    assert.doesNotMatch(readFileSync(out, 'utf8'), /__[A-Z_]+__/)
    execFileSync('plutil', ['-lint', out], { encoding: 'utf8' })
  })

  test('the schedule and the --run invocation land', () => {
    const out = generate()
    const read = (path) =>
      execFileSync('plutil', ['-extract', path, 'raw', '-o', '-', out], { encoding: 'utf8' }).trim()
    assert.equal(read('StartCalendarInterval.Hour'), '9')
    assert.equal(read('StartCalendarInterval.Minute'), '30')
    assert.equal(read('ProgramArguments.1'), '--run')
  })

  test('enabling never itself triggers an update', () => {
    assert.doesNotMatch(readFileSync(TEMPLATE, 'utf8'), /<key>RunAtLoad<\/key>/)
  })
})

describe('auto-update.sh: status', () => {
  const fn = extract('autoupdate_status')

  const status = ({ plist, optout } = {}) => {
    const box = mkdtempSync(join(tmpdir(), 'easel-auto-status-'))
    const plistPath = join(box, 'agent.plist')
    const optoutPath = join(box, 'auto-update.off')
    if (plist) {
      runBash(`
        LABEL=com.sentience.easeld-update ROOT=/r STATE_DIR=/s HOUR=10 MINUTE=0
        TEMPLATE=${JSON.stringify(TEMPLATE)}
        ${[extract('xml_escape', INSTALL), extract('subst_value', INSTALL), extract('write_agent_plist')].join('\n')}
        write_agent_plist ${JSON.stringify(plistPath)}
      `)
    }
    if (optout) writeFileSync(optoutPath, '2026-08-17\n')
    return runBash(`
      PLIST=${JSON.stringify(plistPath)}
      OPTOUT=${JSON.stringify(optoutPath)}
      LOG=/s/auto-update.log
      ${fn}
      autoupdate_status
    `).trim()
  }

  test('never configured reads as unset — what tells an agent to disclose once', () => {
    assert.match(status(), /^unset/)
  })

  test('a recorded decline reads as off, with the date', () => {
    assert.match(status({ optout: true }), /^off — declined 2026-08-17/)
  })

  test('an installed agent reads as on, with its schedule', () => {
    assert.match(status({ plist: true }), /^on — daily at 10:00/)
  })

  test('a decline never shadows an installed agent', () => {
    assert.match(status({ plist: true, optout: true }), /^on/)
  })
})

describe('install.sh: migrate_updater', () => {
  const fn = extract('migrate_updater', INSTALL)
  const genHelpers = [extract('xml_escape', INSTALL), extract('subst_value', INSTALL), extract('write_agent_plist')].join('\n')

  /** A fake root whose auto-update.sh just records how it was called. */
  const fakeRoot = (box, name) => {
    const root = join(box, name)
    mkdirSync(join(root, 'install'), { recursive: true })
    const stub = join(root, 'install', 'auto-update.sh')
    writeFileSync(stub, `#!/bin/sh\necho "$@" > ${JSON.stringify(join(box, 'stub-args'))}\n`, { mode: 0o755 })
    return root
  }

  const migrate = ({ plistRoot, installRoot }) => {
    const box = mkdtempSync(join(tmpdir(), 'easel-migrate-'))
    const plistDir = join(box, 'LaunchAgents')
    mkdirSync(plistDir)
    const oldRoot = fakeRoot(box, 'old')
    const newRoot = fakeRoot(box, 'new')
    const roots = { old: oldRoot, new: newRoot }
    runBash(`
      LABEL=com.sentience.easeld-update
      ROOT=${JSON.stringify(roots[plistRoot])}
      STATE_DIR=/s HOUR=9 MINUTE=30
      TEMPLATE=${JSON.stringify(TEMPLATE)}
      ${genHelpers}
      write_agent_plist ${JSON.stringify(join(plistDir, 'com.sentience.easeld-update.plist'))}
    `)
    const out = runBash(`
      say() { printf '  %s\\n' "$*"; }
      PLIST_DIR=${JSON.stringify(plistDir)}
      ROOT=${JSON.stringify(roots[installRoot])}
      STATE_DIR=/s
      ${fn}
      migrate_updater
    `)
    let stubArgs = null
    try { stubArgs = readFileSync(join(box, 'stub-args'), 'utf8').trim() } catch { /* not called */ }
    return { out, stubArgs }
  }

  test('rebinds an updater left pointing at a previous checkout, keeping its schedule', () => {
    const { out, stubArgs } = migrate({ plistRoot: 'old', installRoot: 'new' })
    assert.equal(stubArgs, '--enable --at 09:30')
    assert.match(out, /rebound/)
  })

  test('leaves an updater already bound to this checkout alone', () => {
    const { stubArgs } = migrate({ plistRoot: 'new', installRoot: 'new' })
    assert.equal(stubArgs, null, 're-bootstrapped an updater that did not move')
  })

  test('is a no-op when auto-update was never enabled', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-migrate-'))
    mkdirSync(join(box, 'LaunchAgents'))
    const out = runBash(`
      say() { printf '  %s\\n' "$*"; }
      PLIST_DIR=${JSON.stringify(join(box, 'LaunchAgents'))}
      ROOT=/nowhere
      STATE_DIR=/s
      ${fn}
      migrate_updater
    `)
    assert.equal(out.trim(), '')
  })
})

describe('wiring', () => {
  test('uninstall also removes the auto-update agent', () => {
    const src = readFileSync(INSTALL, 'utf8')
    assert.match(src, /com\.sentience\.easeld-update/, 'install.sh --uninstall would orphan the update agent')
  })

  test('the CLI exposes autoupdate and routes it to the script', () => {
    const cli = readFileSync(join(HERE, '..', 'cli', 'easel.js'), 'utf8')
    assert.match(cli, /easel autoupdate on \[--at HH:MM\] \| off \| status/)
    assert.match(cli, /auto-update\.sh/)
  })

  test('an unknown subcommand fails with usage, not a launchd call', () => {
    assert.throws(
      () => execFileSync('node', [join(HERE, '..', 'cli', 'easel.js'), 'autoupdate', 'bogus'], { encoding: 'utf8' }),
      (err) => {
        assert.equal(err.status, 1)
        assert.match(String(err.stderr), /autoupdate on/)
        return true
      },
    )
  })
})
