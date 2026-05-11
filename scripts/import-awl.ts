import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DB_PATH = resolve('db/ieltsy.db')
const AWL_PATH = resolve('data/awl.json')

interface AwlData {
  [sublistKey: string]: {
    [headword: string]: { subwords: string[] | null }
  }
}

function main(): void {
  const db = new Database(DB_PATH)
  db.pragma('foreign_keys = ON')

  const awl: AwlData = JSON.parse(readFileSync(AWL_PATH, 'utf-8'))

  // Find existing word by headword (any pos); prefer non-'unknown' pos for natural merge
  const findExisting = db.prepare(`
    SELECT id, pos FROM words
    WHERE headword = ?
    ORDER BY (pos = 'unknown') ASC, id ASC
    LIMIT 1
  `)
  const updateAwl = db.prepare(`UPDATE words SET awl_sublist = ? WHERE id = ?`)
  const insertNew = db.prepare(`
    INSERT INTO words (headword, pos, awl_sublist)
    VALUES (?, 'unknown', ?)
    ON CONFLICT(headword, pos) DO UPDATE SET awl_sublist = excluded.awl_sublist
    RETURNING id
  `)
  const insertForm = db.prepare(`
    INSERT INTO word_forms (word_id, form, form_type) VALUES (?, ?, 'derivation')
  `)

  let matched = 0
  let inserted = 0
  let formCount = 0

  const importAll = db.transaction(() => {
    for (const [sublistKey, families] of Object.entries(awl)) {
      const sublistNum = parseInt(sublistKey.replace('sublist_', ''), 10)
      for (const [headword, info] of Object.entries(families)) {
        let wordId: number
        const existing = findExisting.get(headword) as { id: number; pos: string } | undefined
        if (existing) {
          updateAwl.run(sublistNum, existing.id)
          wordId = existing.id
          matched++
        } else {
          const result = insertNew.get(headword, sublistNum) as { id: number }
          wordId = result.id
          inserted++
        }

        if (info.subwords) {
          for (const form of info.subwords) {
            insertForm.run(wordId, form)
            formCount++
          }
        }
      }
    }
  })

  importAll()

  console.log(`✓ AWL import:`)
  console.log(`  - ${matched} headwords matched existing entries (awl_sublist set)`)
  console.log(`  - ${inserted} new headwords inserted`)
  console.log(`  - ${formCount} word forms added`)

  db.close()
}

main()
