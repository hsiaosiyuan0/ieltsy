import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { discoverGrammarLibrary } from './grammar-library'
import { assertGrammarProjection, GRAMMAR_DB_PATH } from './grammar-projection'

if (!existsSync(GRAMMAR_DB_PATH)) {
  throw new Error(`SQLite database not found at ${GRAMMAR_DB_PATH}. Run pnpm db:reset first.`)
}

const db = new Database(GRAMMAR_DB_PATH, { readonly: true, fileMustExist: true })
try {
  const library = discoverGrammarLibrary()
  const result = assertGrammarProjection(db, library)
  console.log(`✓ Grammar projection: ${result.indexedPoints}/${result.sourcePoints} SQLite rows match grammar/*.md`)
} finally {
  db.close()
}
