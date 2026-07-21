import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  discoverGrammarLibrary,
  parseGrammarCurriculumMarkdown,
  validateGrammarCurriculumDocument,
  type GrammarCurriculumDocument,
} from './grammar-library'

const library = discoverGrammarLibrary()
const {
  phaseByPointId: _phaseByPointId,
  ...canonicalDocument
} = library.curriculum

function curriculumFixture(): GrammarCurriculumDocument {
  return structuredClone(canonicalDocument)
}

test('parses the canonical 473-point curriculum into six complete phases', () => {
  const markdown = readFileSync(resolve('grammar/curriculum.md'), 'utf-8')
  const curriculum = parseGrammarCurriculumMarkdown(markdown, library.points)

  assert.equal(library.points.length, 473)
  assert.equal(curriculum.phases.length, 6)
  assert.equal(curriculum.phases.reduce((sum, phase) => sum + phase.nominalWeeks, 0), 78)
  assert.deepEqual(curriculum.phases.map((phase) => phase.pointIds.length), [93, 117, 107, 69, 48, 39])
  assert.equal(curriculum.phaseByPointId.size, 473)
  for (const point of library.points) {
    assert.ok(curriculum.phaseByPointId.has(point.id), `point #${point.id} has no phase`)
  }
})

test('rejects a repeated grammar point ID', () => {
  const document = curriculumFixture()
  const phase = document.phases[0]!
  phase.pointIds[1] = phase.pointIds[0]!

  assert.throws(
    () => validateGrammarCurriculumDocument(document, library.points),
    /repeats point #/
  )
})

test('rejects an unknown grammar point ID', () => {
  const document = curriculumFixture()
  document.phases[0]!.pointIds[0] = 474

  assert.throws(
    () => validateGrammarCurriculumDocument(document, library.points),
    /references unknown point #474/
  )
})

test('rejects a grammar point omitted from every phase', () => {
  const document = curriculumFixture()
  const omitted = document.phases[0]!.pointIds.shift()!

  assert.throws(
    () => validateGrammarCurriculumDocument(document, library.points),
    new RegExp(`Grammar point #${omitted} has no curriculum phase`)
  )
})

test('rejects a discontinuous phase band boundary', () => {
  const document = curriculumFixture()
  document.phases[1]!.startBand = 5.1

  assert.throws(
    () => validateGrammarCurriculumDocument(document, library.points),
    /does not start at the previous phase target/
  )
})

test('rejects a curriculum whose nominal weeks do not total 78', () => {
  const document = curriculumFixture()
  document.phases[0]!.nominalWeeks += 1

  assert.throws(
    () => validateGrammarCurriculumDocument(document, library.points),
    /nominal weeks total 79; expected 78/
  )
})
