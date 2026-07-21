import type Database from 'better-sqlite3'
import { resolve } from 'node:path'
import type { GrammarCurriculumPhase, GrammarLibrary, GrammarPoint } from './grammar-library'

export const GRAMMAR_DB_PATH = resolve(process.env.IELTSY_DB_PATH || 'db/ieltsy.db')

export interface GrammarProjectionRow {
  id: number
  chapter: number
  section: string | null
  title: string
  importance: number
  description: string | null
}

export interface GrammarPhaseProjectionRow {
  id: string
  position: number
  name: string
  caption: string
  cefr_focus: string
  start_band: number
  target_band: number
  nominal_weeks: number
  word_focus: string
  grammar_focus: string
  outcomes_json: string
}

export interface GrammarAssignmentProjectionRow {
  grammar_id: number
  phase_id: string
  phase_order: number
}

const PROJECTION_FIELDS = [
  'chapter',
  'section',
  'title',
  'importance',
  'description',
] as const satisfies readonly (keyof GrammarProjectionRow)[]

export function projectGrammarPoint(point: GrammarPoint): GrammarProjectionRow {
  return {
    id: point.id,
    chapter: point.chapter,
    section: point.section || null,
    title: point.title,
    importance: point.importance,
    description: point.summary || null,
  }
}

export function projectGrammarPhase(phase: GrammarCurriculumPhase): GrammarPhaseProjectionRow {
  return {
    id: phase.id,
    position: phase.position,
    name: phase.name,
    caption: phase.caption,
    cefr_focus: phase.cefrFocus,
    start_band: phase.startBand,
    target_band: phase.targetBand,
    nominal_weeks: phase.nominalWeeks,
    word_focus: phase.wordFocus,
    grammar_focus: phase.grammarFocus,
    outcomes_json: JSON.stringify(phase.outcomes),
  }
}

export function projectGrammarAssignments(library: GrammarLibrary): GrammarAssignmentProjectionRow[] {
  return library.curriculum.phases.flatMap((phase) => phase.pointIds.map((grammarId, index) => ({
    grammar_id: grammarId,
    phase_id: phase.id,
    phase_order: index + 1,
  })))
}

export function readGrammarProjection(db: Database.Database): GrammarProjectionRow[] {
  return db
    .prepare(`
      SELECT id, chapter, section, title, importance, description
      FROM grammar_points
      ORDER BY id
    `)
    .all() as GrammarProjectionRow[]
}

export function readGrammarPhaseProjection(db: Database.Database): GrammarPhaseProjectionRow[] {
  return db.prepare(`
      SELECT id, position, name, caption, cefr_focus, start_band, target_band,
             nominal_weeks, word_focus, grammar_focus, outcomes_json
      FROM grammar_phases
      ORDER BY position
    `).all() as GrammarPhaseProjectionRow[]
}

export function readGrammarAssignmentProjection(db: Database.Database): GrammarAssignmentProjectionRow[] {
  return db.prepare(`
      SELECT grammar_id, phase_id, phase_order
      FROM grammar_point_curriculum
      ORDER BY phase_id, phase_order
    `).all() as GrammarAssignmentProjectionRow[]
}

export function grammarProjectionDifferences(
  library: GrammarLibrary,
  actualRows: GrammarProjectionRow[]
): string[] {
  const expectedById = new Map(library.points.map((point) => {
    const row = projectGrammarPoint(point)
    return [row.id, row]
  }))
  const actualById = new Map(actualRows.map((row) => [row.id, row]))
  const differences: string[] = []

  for (const [id, expected] of expectedById) {
    const actual = actualById.get(id)
    if (!actual) {
      differences.push(`#${id} is missing from SQLite`)
      continue
    }
    for (const field of PROJECTION_FIELDS) {
      if (actual[field] !== expected[field]) {
        differences.push(
          `#${id} ${field}: expected ${JSON.stringify(expected[field])}, received ${JSON.stringify(actual[field])}`
        )
      }
    }
  }

  for (const id of actualById.keys()) {
    if (!expectedById.has(id)) differences.push(`#${id} exists in SQLite but not in grammar/*.md`)
  }

  return differences
}

export function assertGrammarProjection(
  db: Database.Database,
  library: GrammarLibrary
): { sourcePoints: number; indexedPoints: number; phases: number; assignments: number } {
  const actualRows = readGrammarProjection(db)
  const differences = grammarProjectionDifferences(library, actualRows)
  const expectedPhases = library.curriculum.phases.map(projectGrammarPhase)
  const actualPhases = readGrammarPhaseProjection(db)
  if (JSON.stringify(actualPhases) !== JSON.stringify(expectedPhases)) {
    differences.push('grammar_phases projection differs from grammar/curriculum.md')
  }
  const expectedAssignments = projectGrammarAssignments(library)
    .sort((a, b) => a.grammar_id - b.grammar_id)
  const actualAssignments = readGrammarAssignmentProjection(db)
    .sort((a, b) => a.grammar_id - b.grammar_id)
  if (JSON.stringify(actualAssignments) !== JSON.stringify(expectedAssignments)) {
    differences.push('grammar_point_curriculum projection differs from grammar/curriculum.md')
  }
  if (differences.length > 0) {
    const details = differences.slice(0, 12).map((difference) => `  - ${difference}`).join('\n')
    const remaining = differences.length > 12 ? `\n  - ... ${differences.length - 12} more` : ''
    throw new Error(
      `Grammar projection is out of sync with grammar/*.md:\n${details}${remaining}\nRun pnpm db:import:grammar.`
    )
  }
  return {
    sourcePoints: library.points.length,
    indexedPoints: actualRows.length,
    phases: actualPhases.length,
    assignments: actualAssignments.length,
  }
}
