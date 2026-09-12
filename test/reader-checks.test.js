import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readerChecks, formatFindings } from '../daemon/reader-checks.js'

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
