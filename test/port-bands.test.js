/* Guards for the shared port allocator. Overlapping bands made e2e failures
   depend on which pids a run was dealt, which made every failure ambiguous. */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testFiles, bandFor, assertDisjoint, portFor } from './harness.js'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('every test file owns a band no other file can reach', () => {
  test('the real band map is disjoint', () => {
    assert.equal(assertDisjoint(testFiles().map((f) => bandFor(f))), true)
  })

  test('a new test file cannot silently land on top of an existing band', () => {
    // The defect was that a band was a constant someone had to choose. Adding a
    // file now shifts the map but keeps it disjoint without anyone choosing.
    const withNew = [...testFiles(), 'zzz-brand-new.test.js'].sort()
    assert.equal(assertDisjoint(withNew.map((f) => bandFor(f, withNew))), true)
  })

  test('this file\'s own port sits inside this file\'s own band', () => {
    const band = bandFor('port-bands.test.js')
    const port = portFor(import.meta.url)
    assert.ok(port >= band.start && port <= band.end,
      `portFor gave ${port}, outside ${band.start}-${band.end}`)
  })

  test('an unknown file is an error, not a silently shared band', () => {
    assert.throws(() => bandFor('not-a-real.test.js'), /not a \.test\.js file/)
  })
})

describe('a duplicate band fails loudly rather than flaking', () => {
  test('an identical band throws and names both files', () => {
    // The exact shape that shipped: await-unbounded and ended-writes were both
    // 4560 + pid % 30, so they collided only when their pids happened to agree.
    assert.throws(() => assertDisjoint([
      { file: 'a.test.js', start: 4560, end: 4589 },
      { file: 'b.test.js', start: 4560, end: 4589 },
    ]), (err) => /a\.test\.js/.test(err.message) && /b\.test\.js/.test(err.message))
  })

  test('a partial overlap throws too', () => {
    // The other shape: 4590+30 and 4600+30 share 4600-4619.
    assert.throws(() => assertDisjoint([
      { file: 'a.test.js', start: 4590, end: 4619 },
      { file: 'b.test.js', start: 4600, end: 4629 },
    ]), /overlap/)
  })

  test('bands that merely touch are not an overlap', () => {
    assert.equal(assertDisjoint([
      { file: 'a.test.js', start: 4800, end: 4819 },
      { file: 'b.test.js', start: 4820, end: 4839 },
    ]), true)
  })
})

describe('a file needing several ports stays inside its own band', () => {
  test('every index this file can ask for lands in this file\'s band', () => {
    const band = bandFor('port-bands.test.js')
    for (let i = 0; i < 4; i++) {
      const p = portFor(import.meta.url, i)
      assert.ok(p >= band.start && p <= band.end,
        `index ${i} gave ${p}, outside ${band.start}-${band.end}`)
    }
  })

  test('different indices are different ports', () => {
    const seen = [0, 1, 2, 3].map((i) => portFor(import.meta.url, i))
    assert.equal(new Set(seen).size, seen.length, `indices collided: ${seen}`)
  })

  test('an index past the reservation is an error, not a silent neighbour', () => {
    assert.throws(() => portFor(import.meta.url, 4), /index must be 0\.\.3/)
  })

  test('no test file derives a port by arithmetic', () => {
    // A sink port built by adding an offset escaped into another file's band.
    // Disjoint bands mean nothing if a file can compute its way out of one.
    const offenders = readdirSync(HERE)
      .filter((f) => f.endsWith('.js') && f !== 'harness.js')
      .filter((f) => /\bPORT\s*[+-]\s*\d/.test(readFileSync(join(HERE, f), 'utf8')))
    assert.deepEqual(offenders, [], `these files derive a port: ${offenders.join(', ')}`)
  })
})

describe('no test file may hand-pick a port again', () => {
  test('the allocator is the only place a pid becomes a port', () => {
    // Without this, the next test file can reintroduce the defect by copying an
    // older file's header, and nothing would notice until a run flaked.
    const offenders = readdirSync(HERE)
      .filter((f) => f.endsWith('.js') && f !== 'harness.js')
      .filter((f) => /\d{4}\s*\+\s*\(?\s*process\.pid/.test(readFileSync(join(HERE, f), 'utf8')))
    assert.deepEqual(offenders, [], `these files hand-pick a port band: ${offenders.join(', ')}`)
  })
})
