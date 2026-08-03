/* Exercises install.sh's pure helpers by extracting them from the shipped
   script — never runs the installer itself, which would touch launchd. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, symlinkSync, existsSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'install', 'install.sh')

/** Pull one `name() { ... }` block out of install.sh by brace depth. */
function extract(name) {
  const lines = readFileSync(SCRIPT, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`))
  assert.notEqual(start, -1, `install.sh no longer defines ${name}()`)
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n')
  }
  assert.fail(`unterminated ${name}() in install.sh`)
}

const runBash = (script) => execFileSync('bash', ['-c', script], { encoding: 'utf8' })

const writeTemp = (contents) => {
  const p = join(mkdtempSync(join(tmpdir(), 'easel-plist-')), 'test.plist')
  writeFileSync(p, contents)
  return p
}

describe('install.sh: subst_value', () => {
  const fn = [extract('xml_escape'), extract('subst_value')].join('\n')
  const esc = (raw) => runBash(`${fn}\nsubst_value ${JSON.stringify(raw)}`)

  test('escapes XML text before sed replacement syntax', () => {
    assert.equal(esc('a&b'), 'a\\&amp;b')
    assert.equal(esc('a<b>c'), 'a\\&lt;b\\&gt;c')
  })

  test('escapes the sed delimiter and backslash', () => {
    assert.equal(esc('a|b'), 'a\\|b')
    assert.equal(esc('a\\b'), 'a\\\\b')
  })

  test('leaves an ordinary path untouched', () => {
    assert.equal(esc('/Users/x/repos/dev_workflows/easel'), '/Users/x/repos/dev_workflows/easel')
  })

  test('a hostile path survives the real sed substitution as valid plist text', () => {
    const hostile = '/tmp/a&b|c<d>/easel'
    const out = runBash(
      `${fn}\nprintf '<string>__ROOT__</string>' | sed -e "s|__ROOT__|$(subst_value ${JSON.stringify(hostile)})|g"`,
    )
    assert.equal(out, '<string>/tmp/a&amp;b|c&lt;d&gt;/easel</string>')
    // Nothing that would make the plist unparseable survived.
    assert.doesNotMatch(out.replace(/^<string>|<\/string>$/g, ''), /[<>]/)
  })
})

describe('install.sh: plist generation', () => {
  const fn = [extract('xml_escape'), extract('subst_value')].join('\n')
  const TEMPLATE = join(HERE, '..', 'install', 'com.sentience.easeld.plist.template')

  /** The real multi-line sed invocation, lifted verbatim from install.sh. */
  const sedBlock = () => {
    const lines = readFileSync(SCRIPT, 'utf8').split('\n')
    const start = lines.findIndex((l) => l.startsWith('sed -e "s|__LABEL__|'))
    assert.notEqual(start, -1, 'install.sh no longer generates the plist with a sed block')
    const end = lines.findIndex((l, i) => i >= start && l.includes('> "$TMP_PLIST"'))
    assert.notEqual(end, -1, 'unterminated sed block in install.sh')
    return lines.slice(start, end + 1).join('\n')
  }

  const generate = (helper, nodeEnvXml = '') => runBash(`
    LABEL=com.sentience.easeld
    NODE_BIN=/opt/homebrew/bin/node
    ROOT=/Users/x/repos/dev_workflows/easel
    PORT=4400
    STATE_DIR=/Users/x/.easel
    NODE_ENV_XML=$(printf %s ${JSON.stringify(Buffer.from(nodeEnvXml).toString('base64'))} | base64 -d)
    TEMPLATE=${JSON.stringify(TEMPLATE)}
    TMP_PLIST=$(mktemp)
    ${helper}
    ${sedBlock()}
    cat "$TMP_PLIST"; rm -f "$TMP_PLIST"
  `)

  test('escaping is inert for values with no metacharacters', () => {
    const escaped = generate(fn)
    const raw = generate(`subst_value() { printf '%s' "$1"; }`)
    assert.equal(escaped, raw, 'escaping leaked into ordinary values')
  })

  test('every placeholder is substituted', () => {
    assert.doesNotMatch(generate(fn), /__[A-Z_]+__/)
  })

  // The agent's environment does not inherit the installing shell, so the
  // launcher only sees EASEL_NODE if the plist carries it.
  const nodeEnvXml = (easelNode) => runBash(`
    ${fn}
    ${extract('node_env_xml')}
    ${easelNode === undefined ? 'unset EASEL_NODE' : `EASEL_NODE=${JSON.stringify(easelNode)}`}
    node_env_xml
  `)

  test('omits EASEL_NODE entirely when no override was given', () => {
    assert.equal(nodeEnvXml(undefined), '')
    const plist = generate(fn, nodeEnvXml(undefined))
    assert.doesNotMatch(plist, /EASEL_NODE/)
    execFileSync('plutil', ['-lint', writeTemp(plist)], { encoding: 'utf8' })
  })

  test('pins EASEL_NODE into the agent when one was given', () => {
    const plist = generate(fn, nodeEnvXml('/custom/bin/node'))
    assert.match(plist, /<key>EASEL_NODE<\/key>\s*<string>\/custom\/bin\/node<\/string>/)
    execFileSync('plutil', ['-lint', writeTemp(plist)], { encoding: 'utf8' })
  })

  /* Read the path back with plutil, not by matching escaped XML: an assertion
     on the escaped text can pass on a string awk has already mangled. */
  const installedNodePath = (raw) => {
    const plist = writeTemp(generate(fn, nodeEnvXml(raw)))
    execFileSync('plutil', ['-lint', plist], { encoding: 'utf8' })
    return execFileSync('plutil', ['-extract', 'EnvironmentVariables.EASEL_NODE', 'raw', '-o', '-', plist], {
      encoding: 'utf8',
    }).replace(/\n$/, '')
  }

  for (const raw of ['/opt/a&b/node', '/opt/<node>/bin', '/opt/a|b/node', '/opt/a\\bin/node', '/opt/plain/node']) {
    test(`EASEL_NODE ${raw} reaches launchd byte-for-byte`, () => {
      assert.equal(installedNodePath(raw), raw)
    })
  }

  // The daemon reads EASEL_DATA_DIR; an installer that exports any other name
  // silently hands it nothing and it falls back to ~/.easel.
  test('exports the env var name the daemon actually reads', () => {
    const plist = generate(fn)
    assert.match(plist, /<key>EASEL_DATA_DIR<\/key>/)
    assert.doesNotMatch(plist, /<key>EASEL_HOME<\/key>/)
  })

  test('the generated plist parses', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-plist-'))
    const out = join(box, 'test.plist')
    writeFileSync(out, generate(fn))
    execFileSync('plutil', ['-lint', out], { encoding: 'utf8' })
  })
})

describe('install.sh: the installed entry point', () => {
  const MARKER2 = readFileSync(SCRIPT, 'utf8').match(/^MARKER="(.+)"$/m)[1]
  const helpers = ['owns_entry', 'write_entry'].map(extract).join('\n')

  const setup = (root, port, dir) => `
    MARKER=${JSON.stringify(readFileSync(SCRIPT, 'utf8').match(/^MARKER="(.+)"$/m)[1])}
    ROOT=${JSON.stringify(root)}
    PORT=${JSON.stringify(String(port))}
    CLI="$ROOT/cli/easel.js"
    ${helpers}
    write_entry ${JSON.stringify(join(dir, 'easel'))}
  `

  test('carries the port this install chose, so the CLI reaches the right daemon', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-entry-'))
    runBash(setup('/repo/easel', 4711, box))
    const entry = readFileSync(join(box, 'easel'), 'utf8')
    assert.match(entry, /EASEL_URL="\$\{EASEL_URL:-http:\/\/127\.0\.0\.1:4711\}"/)
    assert.match(entry, /exec node "\/repo\/easel\/cli\/easel\.js" "\$@"/)
  })

  /** Build a runnable entry whose CLI is a stub that reports EASEL_URL. */
  const runnableEntry = (port) => {
    const box = mkdtempSync(join(tmpdir(), 'easel-entry-'))
    mkdirSync(join(box, 'cli'), { recursive: true })
    const stub = join(box, 'cli', 'easel.js')
    writeFileSync(stub, 'console.log(process.env.EASEL_URL)\n')
    chmodSync(stub, 0o755)
    runBash(setup(box, port, box))
    return join(box, 'easel')
  }

  // A checkout that drops the exec bit must not kill the entry point.
  test('the shim runs a CLI file that has no exec bit', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-entry-'))
    mkdirSync(join(box, 'cli'), { recursive: true })
    writeFileSync(join(box, 'cli', 'easel.js'), 'console.log("alive")\n', { mode: 0o644 })
    runBash(setup(box, 4400, box))
    assert.equal(runBash(JSON.stringify(join(box, 'easel'))).trim(), 'alive')
  })

  test('the running CLI gets the installed port by default', () => {
    assert.equal(runBash(runnableEntry(4711)).trim(), 'http://127.0.0.1:4711')
  })

  test('an explicit EASEL_URL still wins over the installed default', () => {
    const entry = runnableEntry(4711)
    assert.equal(runBash(`EASEL_URL=http://example.test ${JSON.stringify(entry)}`).trim(), 'http://example.test')
  })

  test('claims a pre-shim symlink to this checkout so an upgrade is not blocked', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-legacy-'))
    mkdirSync(join(box, 'cli'), { recursive: true })
    const cli = join(box, 'cli', 'easel.js')
    writeFileSync(cli, '#!/usr/bin/env node\n')
    symlinkSync(cli, join(box, 'easel'))
    const owns = runBash(`
      MARKER=${JSON.stringify(MARKER2)}
      ROOT=${JSON.stringify(box)}
      CLI="$ROOT/cli/easel.js"
      ${extract('owns_entry')}
      owns_entry ${JSON.stringify(join(box, 'easel'))} && echo yes || echo no
    `).trim()
    assert.equal(owns, 'yes', 'an upgrade from the symlink era would hard-error')
  })

  test('upgrading a pre-shim symlink replaces it without clobbering the CLI', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-legacy-'))
    mkdirSync(join(box, 'cli'), { recursive: true })
    const cli = join(box, 'cli', 'easel.js')
    writeFileSync(cli, '#!/usr/bin/env node\nORIGINAL\n')
    symlinkSync(cli, join(box, 'easel'))
    runBash(setup(box, 4400, box))
    assert.match(readFileSync(cli, 'utf8'), /ORIGINAL/, 'wrote through the symlink and destroyed the CLI')
    assert.match(readFileSync(join(box, 'easel'), 'utf8'), /EASEL_URL/)
  })

  test('recognises its own entry and disowns another checkout\'s', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-entry-'))
    runBash(setup('/repo/a', 4400, box))
    const owns = (root) => runBash(`
      MARKER=${JSON.stringify(readFileSync(SCRIPT, 'utf8').match(/^MARKER="(.+)"$/m)[1])}
      ROOT=${JSON.stringify(root)}
      ${extract('owns_entry')}
      owns_entry ${JSON.stringify(join(box, 'easel'))} && echo yes || echo no
    `).trim()
    assert.equal(owns('/repo/a'), 'yes')
    assert.equal(owns('/repo/b'), 'no', 'claimed an entry installed from a different checkout')
  })
})

describe('cli entry point: tracked file mode', () => {
  // Git only restores modes it tracks; a local chmod +x cannot be trusted.
  test('git tracks cli/easel.js as executable', () => {
    const out = execFileSync('git', ['ls-files', '-s', 'cli/easel.js'], {
      cwd: join(HERE, '..'),
      encoding: 'utf8',
    })
    assert.match(out, /^100755 /, 'cli/easel.js tracked non-executable — a clean checkout cannot exec it')
  })

  test('git tracks install/update.sh as executable', () => {
    const out = execFileSync('git', ['ls-files', '-s', 'install/update.sh'], {
      cwd: join(HERE, '..'),
      encoding: 'utf8',
    })
    assert.match(out, /^100755 /, 'install/update.sh tracked non-executable — a clean checkout cannot exec it')
  })

  test('install/update.sh parses (bash -n)', () => {
    execFileSync('bash', ['-n', join(HERE, '..', 'install', 'update.sh')])
  })
})

describe('install.sh: remove_owned_link', () => {
  const fn = [extract('owns_entry'), extract('remove_owned_link')].join('\n')
  const MARKER = readFileSync(SCRIPT, 'utf8').match(/^MARKER="(.+)"$/m)[1]

  const harness = (root, dir) => `
    say() { printf '  %s\\n' "$*"; }
    MARKER=${JSON.stringify(MARKER)}
    ROOT=${JSON.stringify(root)}
    CLI="$ROOT/cli/easel.js"
    ${fn}
    remove_owned_link ${JSON.stringify(dir)} easel
  `

  const writeEntryFor = (root, dir) => runBash(`
    MARKER=${JSON.stringify(MARKER)}
    ROOT=${JSON.stringify(root)}
    PORT=4400
    CLI="$ROOT/cli/easel.js"
    ${extract('write_entry')}
    write_entry ${JSON.stringify(join(dir, 'easel'))}
  `)

  test('removes an entry this checkout installed', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-link-'))
    writeEntryFor('/repo/a', box)
    const out = runBash(harness('/repo/a', box))
    assert.equal(existsSync(join(box, 'easel')), false)
    assert.match(out, /removed/)
  })

  test('leaves another checkout\'s entry alone', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-link-'))
    writeEntryFor('/repo/b', box)
    const out = runBash(harness('/repo/a', box))
    assert.equal(existsSync(join(box, 'easel')), true, 'deleted an entry it does not own')
    assert.match(out, /left .* alone/)
  })

  test('leaves an unrelated executable of the same name alone', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-link-'))
    const foreign = join(box, 'someone-elses.js')
    writeFileSync(foreign, '#!/usr/bin/env node\n')
    symlinkSync(foreign, join(box, 'easel'))
    const out = runBash(harness('/repo/a', box))
    assert.equal(existsSync(join(box, 'easel')), true, 'deleted a link it does not own')
    assert.match(out, /left .* alone/)
  })

  test('is a no-op when nothing is present', () => {
    const box = mkdtempSync(join(tmpdir(), 'easel-link-'))
    assert.equal(runBash(harness('/repo/a', box)).trim(), '')
  })
})
