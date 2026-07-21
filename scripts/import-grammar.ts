import Database from 'better-sqlite3'
import { discoverGrammarLibrary } from './study/grammar-library'
import {
  assertGrammarProjection,
  GRAMMAR_DB_PATH,
  projectGrammarAssignments,
  projectGrammarPhase,
  projectGrammarPoint,
} from './study/grammar-projection'

function main(): void {
  const db = new Database(GRAMMAR_DB_PATH)
  db.pragma('foreign_keys = ON')
  const library = discoverGrammarLibrary()

  db.exec(`
    CREATE TABLE IF NOT EXISTS grammar_phases (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      caption TEXT NOT NULL,
      cefr_focus TEXT NOT NULL,
      start_band REAL NOT NULL,
      target_band REAL NOT NULL,
      nominal_weeks INTEGER NOT NULL,
      word_focus TEXT NOT NULL,
      grammar_focus TEXT NOT NULL,
      outcomes_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grammar_point_curriculum (
      grammar_id INTEGER PRIMARY KEY,
      phase_id TEXT NOT NULL,
      phase_order INTEGER NOT NULL,
      FOREIGN KEY (grammar_id) REFERENCES grammar_points(id) ON DELETE CASCADE,
      FOREIGN KEY (phase_id) REFERENCES grammar_phases(id) ON DELETE CASCADE,
      UNIQUE(phase_id, phase_order)
    );
    CREATE INDEX IF NOT EXISTS idx_grammar_curriculum_phase
      ON grammar_point_curriculum(phase_id, phase_order);
  `)

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
  const insertPhase = db.prepare(`
    INSERT INTO grammar_phases (
      id, position, name, caption, cefr_focus, start_band, target_band,
      nominal_weeks, word_focus, grammar_focus, outcomes_json
    ) VALUES (
      @id, @position, @name, @caption, @cefr_focus, @start_band, @target_band,
      @nominal_weeks, @word_focus, @grammar_focus, @outcomes_json
    )
  `)
  const insertAssignment = db.prepare(`
    INSERT INTO grammar_point_curriculum (grammar_id, phase_id, phase_order)
    VALUES (@grammar_id, @phase_id, @phase_order)
  `)

  let total = 0

  const importAll = db.transaction(() => {
    for (const point of library.points) {
      insert.run(projectGrammarPoint(point))
      total += 1
    }
    db.prepare('DELETE FROM grammar_point_curriculum').run()
    db.prepare('DELETE FROM grammar_phases').run()
    for (const phase of library.curriculum.phases) insertPhase.run(projectGrammarPhase(phase))
    for (const assignment of projectGrammarAssignments(library)) insertAssignment.run(assignment)
  })

  importAll()

  console.log(`✓ Grammar imported: ${total} points`)
  const projection = assertGrammarProjection(db, library)
  console.log(`  Projection: ${projection.indexedPoints}/${projection.sourcePoints} SQLite rows match grammar/*.md`)
  console.log(`  Curriculum: ${projection.assignments} assignments across ${projection.phases} phases`)

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
