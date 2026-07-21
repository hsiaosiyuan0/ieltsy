import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  auditEgpRows,
  loadEgpCoverageRules,
  parseEgpWorksheetXml,
  parseSharedStringsXml,
  sha256EgpContent,
  type EgpCoverageRules,
  type EgpRow,
} from './egp-coverage'

const sourceHash = 'a'.repeat(64)

function fixtureRules(): EgpCoverageRules {
  return {
    schemaVersion: 1,
    source: {
      label: 'test',
      expectedContentSha256: sourceHash,
      expectedTotalRows: 3,
      targetLevels: ['A2', 'B1'],
      expectedTargetRows: 2,
      expectedActionableRows: 1,
      expectedPlaceholderRows: 1,
      expectedLevelCounts: { A2: 1, B1: 1 },
      expectedCategoryCounts: { CLAUSES: 2 },
    },
    mappingRules: [{
      id: 'clauses',
      superCategory: 'CLAUSES',
      subcategories: ['conditional', 'interrogatives'],
      pointIds: [41, 42],
      rationale: 'Test rule.',
    }],
  }
}

function fixtureRows(): EgpRow[] {
  return [
    {
      sourceRow: 2,
      id: 'a1',
      superCategory: 'CLAUSES',
      subCategory: 'declarative',
      level: 'A1',
      lexicalRange: 'N/A',
      guideword: 'FORM',
      canDo: 'A1 statement',
      example: 'Example.',
    },
    {
      sourceRow: 3,
      id: 'a2',
      superCategory: 'CLAUSES',
      subCategory: 'conditional',
      level: 'A2',
      lexicalRange: 'N/A',
      guideword: 'USE',
      canDo: 'A2 statement',
      example: 'Example.',
    },
    {
      sourceRow: 4,
      id: 'b1',
      superCategory: 'CLAUSES',
      subCategory: 'interrogatives',
      level: 'B1 ',
      lexicalRange: 'N/A',
      guideword: 'FORM',
      canDo: '',
      example: '',
    },
  ]
}

test('parses direct and shared XLSX strings while normalizing field whitespace', () => {
  const shared = parseSharedStringsXml('<sst><si><t>shared &amp; text</t></si><si><r><t>two</t></r><r><t> parts</t></r></si></sst>')
  assert.deepEqual(shared, ['shared & text', 'two parts'])

  const xml = `
    <worksheet><sheetData>
      <row r="1">
        <c r="A1" t="str"><v>id</v></c><c r="B1" t="str"><v>SuperCategory</v></c>
        <c r="C1" t="str"><v>SubCategory</v></c><c r="D1" t="str"><v>Level</v></c>
        <c r="E1" t="str"><v>Lexical Range</v></c><c r="F1" t="str"><v>Guideword</v></c>
        <c r="G1" t="str"><v>Can-do statement</v></c><c r="H1" t="str"><v>Example</v></c>
      </row>
      <row r="2">
        <c r="A2" t="str"><v>opaque-id</v></c><c r="B2" t="str"><v>CLAUSES</v></c>
        <c r="C2" t="inlineStr"><is><t>conditional</t></is></c><c r="D2" t="str"><v> A2 </v></c>
        <c r="E2" t="str"><v>N/A</v></c><c r="F2" t="str"><v>FORM &amp; USE</v></c>
        <c r="G2" t="s"><v>0</v></c><c r="H2" t="s"><v>1</v></c>
      </row>
    </sheetData></worksheet>`

  const rows = parseEgpWorksheetXml(xml, shared)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.level, 'A2')
  assert.equal(rows[0]!.guideword, 'FORM & USE')
  assert.equal(rows[0]!.canDo, 'shared & text')
  assert.equal(rows[0]!.example, 'two parts')
})

test('accepts the official export headers and ignores a trailing blank worksheet row', () => {
  const xml = `
    <worksheet><sheetData>
      <row r="1">
        <c r="A1" t="str"><v>#</v></c><c r="B1" t="str"><v>SuperCategory</v></c>
        <c r="C1" t="str"><v>SubCategory</v></c><c r="D1" t="str"><v>Level</v></c>
        <c r="E1" t="str"><v>Lexical Range</v></c><c r="F1" t="str"><v>guideword</v></c>
        <c r="G1" t="str"><v>Can-do statement</v></c><c r="H1" t="str"><v>Example</v></c>
      </row>
      <row r="2">
        <c r="A2" t="str"><v>1</v></c><c r="B2" t="str"><v>CLAUSES</v></c>
        <c r="C2" t="str"><v>conditional</v></c><c r="D2" t="str"><v>A2</v></c>
        <c r="E2" t="str"><v>N/A</v></c><c r="F2" t="str"><v>FORM</v></c>
        <c r="G2" t="str"><v>Can use if.</v></c><c r="H2" t="str"><v>If it rains, stay home.</v></c>
      </row>
      <row r="3"><c r="A3"/><c r="B3"/><c r="C3"/><c r="D3"/></row>
    </sheetData></worksheet>`

  const rows = parseEgpWorksheetXml(xml)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, '1')
})

test('hashes normalized EGP row content independently of worksheet row positions', () => {
  const rows = fixtureRows()
  assert.equal(sha256EgpContent(rows), sha256EgpContent(rows.map((row) => ({ ...row, sourceRow: row.sourceRow + 10 }))))
})

test('classifies every target row as mapped or an explicit source placeholder', () => {
  const audit = auditEgpRows(fixtureRows(), fixtureRules(), new Set([41, 42]), sourceHash)
  assert.equal(audit.summary.targetRows, 2)
  assert.equal(audit.summary.mappedRows, 1)
  assert.equal(audit.summary.excludedRows, 1)
  assert.equal(audit.summary.unmappedRows, 0)
  assert.equal(audit.decisions[0]!.status, 'mapped')
  assert.equal(audit.decisions[1]!.status, 'excluded')
  assert.match(audit.decisions[0]!.rowHash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(audit).includes('A2 statement'), false)
})

test('fails when an actionable source subcategory has no mapping decision', () => {
  const rows = fixtureRows()
  rows[1] = { ...rows[1]!, subCategory: 'new category' }
  assert.throws(
    () => auditEgpRows(rows, fixtureRules(), new Set([41, 42]), sourceHash),
    /actionable rows without a mapping rule/
  )
})

test('fails on changed normalized content or a missing local point ID', () => {
  assert.throws(
    () => auditEgpRows(fixtureRows(), fixtureRules(), new Set([41, 42]), 'b'.repeat(64)),
    /normalized content SHA-256 changed/
  )
  assert.throws(
    () => auditEgpRows(fixtureRows(), fixtureRules(), new Set([41]), sourceHash),
    /missing grammar point #42/
  )
})

test('the tracked high-recall crosswalk includes every appended grammar point', () => {
  const rules = loadEgpCoverageRules(resolve('audits/egp-coverage-rules.json'))
  const mappedPointIds = new Set(rules.mappingRules.flatMap((rule) => rule.pointIds))

  for (let id = 460; id <= 473; id += 1) {
    assert.ok(mappedPointIds.has(id), `new grammar point #${id} is absent from the EGP category crosswalk`)
  }
})
