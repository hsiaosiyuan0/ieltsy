import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { sourceHeadwordCandidates, toAmericanEnglish, toAmericanHeadword } from './study-profile'

/**
 * 把任意词加入学习队列。
 *
 * Usage:
 *   pnpm study:add-word --word consultant
 *   pnpm study:add-word --word consultant --pos n      # 指定 POS（同词多义时）
 *   pnpm study:add-word --word newword --force         # db 里没有就建空条目
 *   pnpm study:add-word --words "consultant,client,deadline"   # 批量
 */

const DB_PATH = resolve('db/ieltsy.db')

const { values } = parseArgs({
  options: {
    word: { type: 'string' },
    words: { type: 'string' }, // comma-separated batch
    pos: { type: 'string' },
    force: { type: 'boolean', default: false },
  },
})

const inputs: string[] = []
if (values.word) inputs.push(values.word)
if (values.words) inputs.push(...values.words.split(',').map((s) => s.trim()).filter(Boolean))

if (inputs.length === 0) {
  console.error('Usage: pnpm study:add-word --word consultant [--pos n] [--force]')
  console.error('       pnpm study:add-word --words "consultant,client,deadline"')
  process.exit(1)
}

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

const today = new Date().toISOString().split('T')[0]!

interface WordRow {
  id: number
  headword: string
  pos: string
  cefr_level: string | null
  awl_sublist: number | null
  definition_en: string | null
}

const findExact = db.prepare(
  `SELECT id, headword, pos, cefr_level, awl_sublist, definition_en
   FROM words WHERE LOWER(headword) = ? AND pos = ?
   ORDER BY id LIMIT 1`
)
const findAny = db.prepare(
  `SELECT id, headword, pos, cefr_level, awl_sublist, definition_en
   FROM words WHERE LOWER(headword) = ?
   ORDER BY (pos = 'unknown'), id LIMIT 1`
)
const findSimilar = db.prepare(`SELECT headword FROM words WHERE headword LIKE ? LIMIT 5`)
const insertBare = db.prepare(
  `INSERT INTO words (headword, pos) VALUES (?, 'unknown') RETURNING id`
)

const checkProgress = db.prepare(
  `SELECT status, first_seen_date FROM word_progress WHERE word_id = ?`
)
const insertProgress = db.prepare(`
  INSERT INTO word_progress (word_id, first_seen_date, status, next_review_date)
  VALUES (?, ?, 'learning', ?)
`)
const resetProgress = db.prepare(`
  UPDATE word_progress
  SET status = 'learning', next_review_date = ?, interval_days = 1, repetitions = 0
  WHERE word_id = ?
`)

function findWord(word: string, pos?: string): WordRow | undefined {
  const matches: WordRow[] = []
  for (const candidate of sourceHeadwordCandidates(word)) {
    const row = pos
      ? findExact.get(candidate, pos) as WordRow | undefined
      : findAny.get(candidate) as WordRow | undefined
    if (row) matches.push(row)
  }
  return matches.sort((left, right) => left.id - right.id)[0]
}

let added = 0
let reset = 0
let notFound = 0

for (const raw of inputs) {
  const wordLc = toAmericanHeadword(raw)
  if (!wordLc) continue

  let row = findWord(wordLc, values.pos)

  if (!row) {
    if (!values.force) {
      console.error(`× "${raw}" not in db.`)
      const similar = findSimilar.all(`${wordLc.slice(0, 3)}%`) as { headword: string }[]
      if (similar.length > 0) {
        const suggestions = [...new Set(similar.map((suggestion) => toAmericanHeadword(suggestion.headword)))]
        console.error(`  Did you mean: ${suggestions.join(', ')}`)
      }
      console.error(`  Use --force to add as a bare entry.`)
      notFound++
      continue
    }
    const newId = (insertBare.get(wordLc) as { id: number }).id
    row = { id: newId, headword: wordLc, pos: 'unknown', cefr_level: null, awl_sublist: null, definition_en: null }
    console.log(`+ Created bare entry: ${row.headword} (id=${row.id})`)
  }

  const existing = checkProgress.get(row.id) as
    | { status: string; first_seen_date: string }
    | undefined
  const meta = [row.pos, row.cefr_level, row.awl_sublist ? `AWL${row.awl_sublist}` : null]
    .filter(Boolean)
    .join(' · ')
  const displayHeadword = toAmericanHeadword(row.headword)

  if (existing) {
    resetProgress.run(today, row.id)
    console.log(`↻ "${displayHeadword}" (${meta}) — already tracked since ${existing.first_seen_date}, reset to learning`)
    reset++
  } else {
    insertProgress.run(row.id, today, today)
    console.log(`+ "${displayHeadword}" (${meta}) added to learning queue`)
    if (row.definition_en) console.log(`  ${toAmericanEnglish(row.definition_en).slice(0, 90)}`)
    added++
  }
}

console.log()
console.log(`Summary: ${added} added · ${reset} reset · ${notFound} not found`)
console.log(`Next session will include these in the review queue.`)

db.close()
