import type Database from 'better-sqlite3'
import { resolve } from 'node:path'
import type { GrammarLibrary, GrammarPoint } from './grammar-library'

export const GRAMMAR_DB_PATH = resolve(process.env.IELTSY_DB_PATH || 'db/ieltsy.db')

export interface GrammarProjectionRow {
  id: number
  chapter: number
  section: string | null
  title: string
  importance: number
  description: string | null
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

export function readGrammarProjection(db: Database.Database): GrammarProjectionRow[] {
  return db
    .prepare(`
      SELECT id, chapter, section, title, importance, description
      FROM grammar_points
      ORDER BY id
    `)
    .all() as GrammarProjectionRow[]
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
): { sourcePoints: number; indexedPoints: number } {
  const actualRows = readGrammarProjection(db)
  const differences = grammarProjectionDifferences(library, actualRows)
  if (differences.length > 0) {
    const details = differences.slice(0, 12).map((difference) => `  - ${difference}`).join('\n')
    const remaining = differences.length > 12 ? `\n  - ... ${differences.length - 12} more` : ''
    throw new Error(
      `Grammar projection is out of sync with grammar/*.md:\n${details}${remaining}\nRun pnpm db:import:grammar.`
    )
  }
  return { sourcePoints: library.points.length, indexedPoints: actualRows.length }
}
