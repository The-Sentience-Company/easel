import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readerChecks, formatFindings, sinceLast } from '../daemon/reader-checks.js'

// Helper: a paragraph whose text is exactly n copies of "word".
const wallP = (n) => `<p>${'word '.repeat(n).trim()}</p>`

describe('wall', () => {
  test('paragraph over 110 words is flagged', () => {
    const findings = readerChecks(wallP(112))
    assert.equal(findings.length, 1)
    assert.equal(findings[0].type, 'wall')
    assert.match(findings[0].detail, /112-word paragraph/)
  })

  test('paragraph at or under 110 words is clean', () => {
    assert.equal(readerChecks(wallP(110)).length, 0)
  })
})

describe('shorthand', () => {
  test('undefined token in prose is flagged', () => {
    const html = '<p>APR-01 shipped last week.</p>'
    const findings = readerChecks(html)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].type, 'shorthand')
    assert.match(findings[0].sample, /APR-01/)
  })

  test('token defined in any table cell (including second column) is not flagged', () => {
    // False positive fix: the old code only read the first <td> per row.
    const html = `
      <table>
        <tr><td>Campaign tracker</td><td>APR-01</td></tr>
      </table>
      <p>APR-01 shipped last week.</p>`
    assert.equal(readerChecks(html).filter((f) => f.type === 'shorthand').length, 0)
  })

  test('token defined in first column is also not flagged', () => {
    const html = `
      <table><tr><td>APR-01</td><td>approval queue</td></tr></table>
      <p>APR-01 shipped last week.</p>`
    assert.equal(readerChecks(html).filter((f) => f.type === 'shorthand').length, 0)
  })

  test('token inside a code span is not flagged', () => {
    const html = '<p>The <code>APR-01</code> handler runs first.</p>'
    assert.equal(readerChecks(html).filter((f) => f.type === 'shorthand').length, 0)
  })
})

describe('pointer', () => {
  test('"see round N" phrase is flagged', () => {
    const html = '<p>For details see round 9.</p>'
    const findings = readerChecks(html)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].type, 'pointer')
  })

  test('"full text: /" phrase is flagged', () => {
    const html = '<p>Full text: /data/file.txt</p>'
    const findings = readerChecks(html).filter((f) => f.type === 'pointer')
    assert.equal(findings.length, 1)
  })
})

describe('label', () => {
  test('button over five words is flagged', () => {
    const html = '<button data-option="a">Approve as written with changes today</button>'
    const findings = readerChecks(html)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].type, 'label')
    assert.match(findings[0].detail, /6-word button/)
  })

  test('button of five words or fewer is clean', () => {
    const html = '<button data-option="a">Approve as written</button>'
    assert.equal(readerChecks(html).filter((f) => f.type === 'label').length, 0)
  })

  test('a button without data-option is not checked', () => {
    const html = '<button>Submit this very long label text here</button>'
    assert.equal(readerChecks(html).filter((f) => f.type === 'label').length, 0)
  })
})

describe('formatting', () => {
  test('html tag printed as escaped text is flagged', () => {
    const html = '<p>Use &lt;br to break lines.</p>'
    const findings = readerChecks(html).filter((f) => f.type === 'formatting')
    assert.equal(findings.length, 1)
    assert.match(findings[0].detail, /html tag/)
  })

  test('unfilled placeholder is flagged', () => {
    const html = '<p>PR {TICKET_ID} was merged.</p>'
    const findings = readerChecks(html).filter((f) => f.type === 'formatting')
    assert.equal(findings.length, 1)
    assert.match(findings[0].detail, /placeholder/)
  })

  test('bare PR number with no link is flagged', () => {
    const html = '<p>See #6485 for details.</p>'
    const findings = readerChecks(html).filter((f) => f.type === 'formatting')
    assert.equal(findings.length, 1)
    assert.match(findings[0].detail, /PR number/)
  })

  test('linked PR number is not flagged', () => {
    const html = '<p>See <a href="https://github.com/org/repo/pull/6485">#6485</a> for details.</p>'
    assert.equal(readerChecks(html).filter((f) => f.type === 'formatting').length, 0)
  })
})

describe('blockquote false positive fix', () => {
  test('200-word paragraph inside a blockquote yields no wall finding', () => {
    const html = `<blockquote>${wallP(200)}</blockquote>`
    assert.equal(readerChecks(html).filter((f) => f.type === 'wall').length, 0)
  })

  test('escaped tags inside a blockquote yield no formatting finding', () => {
    const html = '<blockquote><p>Example: &lt;br tags break lines.</p></blockquote>'
    assert.equal(readerChecks(html).filter((f) => f.type === 'formatting').length, 0)
  })

  test('a wall paragraph outside a blockquote is still flagged', () => {
    const html = `<blockquote>${wallP(200)}</blockquote>${wallP(112)}`
    const walls = readerChecks(html).filter((f) => f.type === 'wall')
    assert.equal(walls.length, 1)
  })

  test('hex colours inside a baked diagram or a style block are not bare PR numbers', () => {
    const html = '<svg><g style="fill:#333;stroke:#000"><text>node</text></g></svg><style>.x{color:#a5d8ff}</style><p>one short line.</p>'
    assert.equal(readerChecks(html).filter((f) => f.type === 'formatting').length, 0)
  })

  test('a bare PR number in prose is still flagged', () => {
    const html = '<svg><g style="fill:#333"></g></svg><p>merged as #4123 this morning.</p>'
    assert.equal(readerChecks(html).filter((f) => f.type === 'formatting').length, 1)
  })
})

describe('table', () => {
  const row = (...cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`
  const table = (rows) => `<table><thead><tr><th>Run</th><th>Case</th></tr></thead><tbody>${rows}</tbody></table>`
  // The real shape: one row per (run, miss) pair, so each run label repeats.
  const crossProduct = table(
    ['before', 'before', 'before', 'cut 1', 'cut 1', 'cut 1', 'cut 2', 'cut 2', 'final', 'final']
      .map((r, i) => row(r, `case ${i}`)).join(''),
  )

  test('a first column repeating under half is flagged, with the worst value', () => {
    const findings = readerChecks(crossProduct)
    assert.deepEqual(findings.map((f) => f.type), ['table'])
    assert.match(findings[0].detail, /10-row table, 4 distinct values in the first column/)
    assert.match(findings[0].sample, /"before" 3 times/)
  })

  test('one row per thing is clean, however long', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`case ${i}`, 'what it did')).join('')
    assert.equal(readerChecks(table(rows)).length, 0)
  })

  test('a table under six body rows never fires, even repeating every value', () => {
    const rows = Array.from({ length: 5 }, () => row('same', 'x')).join('')
    assert.equal(readerChecks(table(rows)).length, 0)
  })

  test('exactly half distinct fires; just over half does not', () => {
    const half = ['a', 'a', 'b', 'b', 'c', 'c'].map((v) => row(v, 'x')).join('')
    assert.equal(readerChecks(table(half)).length, 1, 'three of six is the boundary and counts')
    const over = ['a', 'a', 'b', 'c', 'd', 'e'].map((v) => row(v, 'x')).join('')
    assert.equal(readerChecks(table(over)).length, 0, 'five of six is not a cross product')
  })

  test('header rows are not counted as body rows', () => {
    // Five body rows plus a header must stay under the six-row floor.
    const rows = Array.from({ length: 5 }, () => row('same', 'x')).join('')
    assert.equal(readerChecks(table(rows)).length, 0)
  })

  test('a quoted specimen is not the author\'s own table', () => {
    assert.equal(readerChecks(`<blockquote>${crossProduct}</blockquote>`).length, 0)
  })
})

describe('prose', () => {
  // Three paragraphs of 100 words each: no single one is a wall, the section is.
  const paras = Array.from({ length: 3 }, () => wallP(100)).join('')
  const section = (inner) => `<section class="sd-section"><h2>Data flow</h2>${inner}</section>`

  test('a 300-word section of only paragraphs is flagged with its heading', () => {
    const findings = readerChecks(section(paras))
    assert.deepEqual(findings.map((f) => f.type), ['prose'])
    assert.match(findings[0].detail, /300-word section/)
    assert.equal(findings[0].sample, 'Data flow')
  })

  test('the same section with a table, a list, or a block is clean', () => {
    for (const block of ['<table><tr><td>x</td></tr></table>', '<ul><li>x</li></ul>', '<div class="sd-grid"></div>', '<div class="sd-callout">x</div>']) {
      assert.equal(readerChecks(section(paras + block)).length, 0, block)
    }
  })

  test('a section at or under 250 words is clean', () => {
    assert.equal(readerChecks(section(wallP(100) + wallP(100) + wallP(50))).length, 0)
  })
})

describe('clean board', () => {
  test('a well-formed board yields zero findings', () => {
    const html = `
      <table>
        <tr><td>APR-01</td><td>approval queue card</td></tr>
        <tr><td>SCR-01</td><td>screenshot service ticket</td></tr>
      </table>
      <p>APR-01 and SCR-01 are the two tickets in scope.</p>
      <p>Each has a clear owner and a deadline.</p>
      <button data-option="yes">Approve</button>
      <button data-option="no">Defer</button>`
    assert.equal(readerChecks(html).length, 0)
  })
})

describe('sinceLast', () => {
  test('a finding present last round is carried, a new one is fresh', () => {
    const prev = readerChecks(wallP(112))
    const cur = readerChecks(`${wallP(112)}<p>merged as #4123 today.</p>`)
    const { fresh, carried } = sinceLast(cur, prev)
    assert.equal(carried, 1)
    assert.deepEqual(fresh.map((f) => f.type), ['formatting'])
  })

  test('the first round carries nothing', () => {
    const cur = readerChecks(wallP(112))
    assert.deepEqual(sinceLast(cur, []), { fresh: cur, carried: 0 })
  })
})

describe('formatFindings', () => {
  test('returns empty string for zero findings', () => {
    assert.equal(formatFindings([]), '')
  })

  test('includes reader checks header and bullet format', () => {
    const findings = readerChecks(wallP(112))
    const out = formatFindings(findings)
    assert.match(out, /^reader checks:/)
    assert.match(out, /• 112-word paragraph/)
    assert.match(out, /rule:/)
  })
})
