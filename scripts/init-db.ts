import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DB_PATH = resolve('db/ieltsy.db')
const SCHEMA_PATH = resolve('db/schema.sql')

const schema = readFileSync(SCHEMA_PATH, 'utf-8')
const db = new Database(DB_PATH)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(schema)

console.log(`✓ Database initialized at ${DB_PATH}\n`)
console.log('Tables:')
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  .all() as { name: string }[]

for (const t of tables) {
  const row = db.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).get() as { c: number }
  console.log(`  - ${t.name.padEnd(20)} ${row.c} rows`)
}

db.close()
