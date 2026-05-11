import Database from 'better-sqlite3'
import { resolve } from 'node:path'

const DB_PATH = resolve('db/ieltsy.db')
const db = new Database(DB_PATH, { readonly: true })

console.log('=== IELTS Database Stats ===\n')

// ---- Topics ----
const topicsByCategory = db
  .prepare(`SELECT category, COUNT(*) as count FROM topics GROUP BY category ORDER BY category`)
  .all() as { category: string; count: number }[]

console.log('Topics:')
for (const r of topicsByCategory) {
  console.log(`  ${r.category.padEnd(20)} ${r.count}`)
}

// ---- Words ----
const wordCount = (db.prepare('SELECT COUNT(*) as c FROM words').get() as { c: number }).c
console.log(`\nUnique word entries: ${wordCount}`)

// By POS
const wordsByPos = db
  .prepare(`SELECT pos, COUNT(*) as count FROM words GROUP BY pos ORDER BY count DESC`)
  .all() as { pos: string; count: number }[]
console.log('\nWords by POS:')
for (const r of wordsByPos) {
  console.log(`  ${r.pos.padEnd(12)} ${r.count}`)
}

// By CEFR
const wordsByCefr = db
  .prepare(
    `SELECT IFNULL(cefr_level, '(none)') as level, COUNT(*) as count
     FROM words GROUP BY cefr_level ORDER BY level`
  )
  .all() as { level: string; count: number }[]
console.log('\nWords by CEFR level:')
for (const r of wordsByCefr) {
  console.log(`  ${r.level.padEnd(8)} ${r.count}`)
}

// AWL
const awlBreakdown = db
  .prepare(
    `SELECT awl_sublist, COUNT(*) as count
     FROM words WHERE awl_sublist IS NOT NULL
     GROUP BY awl_sublist ORDER BY awl_sublist`
  )
  .all() as { awl_sublist: number; count: number }[]
console.log('\nAWL sublists:')
for (const r of awlBreakdown) {
  console.log(`  Sublist ${r.awl_sublist}`.padEnd(12) + r.count)
}
const awlTotal = awlBreakdown.reduce((s, r) => s + r.count, 0)
console.log(`  TOTAL AWL    ${awlTotal} headwords`)

// Oxford
const ox3000Count = (db.prepare('SELECT COUNT(*) as c FROM words WHERE oxford_3000 = 1').get() as { c: number }).c
const ox5000Count = (db.prepare('SELECT COUNT(*) as c FROM words WHERE oxford_5000 = 1').get() as { c: number }).c
console.log(`\nOxford 3000: ${ox3000Count} entries`)
console.log(`Oxford 5000: ${ox5000Count} entries`)

// Cross-references
const ox3000AndAwl = (db.prepare('SELECT COUNT(*) as c FROM words WHERE oxford_3000=1 AND awl_sublist IS NOT NULL').get() as { c: number }).c
const ox5000AndAwl = (db.prepare('SELECT COUNT(*) as c FROM words WHERE oxford_5000=1 AND awl_sublist IS NOT NULL').get() as { c: number }).c
console.log(`\nIntersections:`)
console.log(`  Oxford 3000 ∩ AWL: ${ox3000AndAwl}`)
console.log(`  Oxford 5000 ∩ AWL: ${ox5000AndAwl}`)

// Word forms
const formCount = (db.prepare('SELECT COUNT(*) as c FROM word_forms').get() as { c: number }).c
console.log(`\nWord forms (derivations): ${formCount}`)

// Examples
const exampleCount = (db.prepare('SELECT COUNT(*) as c FROM examples').get() as { c: number }).c
console.log(`Examples: ${exampleCount}`)

// Collocations
const collCount = (db.prepare('SELECT COUNT(*) as c FROM collocations').get() as { c: number }).c
console.log(`Collocations: ${collCount}`)

db.close()
