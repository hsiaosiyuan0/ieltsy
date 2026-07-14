import Database from 'better-sqlite3'
import { discoverGrammarLibrary } from './study/grammar-library'
import {
  assertGrammarProjection,
  GRAMMAR_DB_PATH,
  projectGrammarPoint,
} from './study/grammar-projection'

function main(): void {
  const db = new Database(GRAMMAR_DB_PATH)
  db.pragma('foreign_keys = ON')
  const library = discoverGrammarLibrary()

  const insert = db.prepare(`
    INSERT INTO grammar_points (id, chapter, section, title, importance, description)
    VALUES (@id, @chapter, @section, @title, @importance, @description)
    ON CONFLICT(id) DO UPDATE SET
      chapter = excluded.chapter,
      section = excluded.section,
      title = excluded.title,
      importance = excluded.importance,
      description = excluded.description
  `)

  let total = 0

  const importAll = db.transaction(() => {
    for (const point of library.points) {
      insert.run(projectGrammarPoint(point))
      total += 1
    }
  })

  importAll()

  console.log(`✓ Grammar imported: ${total} points`)
  const projection = assertGrammarProjection(db, library)
  console.log(`  Projection: ${projection.indexedPoints}/${projection.sourcePoints} SQLite rows match grammar/*.md`)

  // Stats by chapter
  const byChapter = db
    .prepare(`SELECT chapter, COUNT(*) as count FROM grammar_points GROUP BY chapter ORDER BY chapter`)
    .all() as { chapter: number; count: number }[]
  console.log('  By chapter:')
  for (const r of byChapter) {
    console.log(`    Ch.${r.chapter}: ${r.count}`)
  }

  const byImportance = db
    .prepare(`SELECT importance, COUNT(*) as count FROM grammar_points GROUP BY importance ORDER BY importance DESC`)
    .all() as { importance: number; count: number }[]
  console.log('  By importance:')
  for (const r of byImportance) {
    console.log(`    ${'★'.repeat(r.importance)}: ${r.count}`)
  }

  db.close()
}

main()
