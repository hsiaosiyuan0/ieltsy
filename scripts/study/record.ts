import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const DB_PATH = resolve('db/ieltsy.db')

const { values } = parseArgs({
  options: {
    correct: { type: 'string', default: '' }, // comma-separated word ids
    incorrect: { type: 'string', default: '' },
    'whole-dictation': { type: 'boolean', default: false },
    notes: { type: 'string', default: '' },
    date: { type: 'string' }, // override date (default = today)
    'mistakes-json': { type: 'string', default: '' }, // detailed mistake records
    'mistakes-file': { type: 'string' }, // OR path to JSON file with mistakes
  },
})

interface MistakeRecord {
  word_id: number
  context: string
  user_answer: string
  correct_answer: string
  error_type?: 'spelling' | 'similar-form' | 'meaning' | 'pos' | 'unknown'
}

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

const date = values.date ?? new Date().toISOString().split('T')[0]!

const session = db.prepare('SELECT * FROM daily_sessions WHERE session_date = ?').get(date) as
  | { id: number; cloze_correct: number; cloze_total: number; session_path: string | null }
  | undefined

if (!session) {
  console.error(`No session found for ${date}. Run pnpm study today first.`)
  process.exit(1)
}

// Parse mistakes (from --mistakes-json or --mistakes-file)
let mistakes: MistakeRecord[] = []
if (values['mistakes-file']) {
  const text = readFileSync(resolve(values['mistakes-file']), 'utf-8')
  mistakes = JSON.parse(text)
} else if (values['mistakes-json']) {
  mistakes = JSON.parse(values['mistakes-json'])
}

const correctIds = (values.correct ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => parseInt(s, 10))
  .filter((n) => !isNaN(n))

const incorrectIds = (values.incorrect ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => parseInt(s, 10))
  .filter((n) => !isNaN(n))

console.log(`Recording session for ${date}`)
console.log(`  Correct: ${correctIds.length}`)
console.log(`  Incorrect: ${incorrectIds.length}`)

// SM-2 algorithm (simplified binary correct/incorrect)
function nextSm2State(
  prev: { interval_days: number; ease_factor: number; repetitions: number },
  correct: boolean
): { interval_days: number; ease_factor: number; repetitions: number } {
  if (!correct) {
    return {
      interval_days: 1,
      ease_factor: Math.max(1.3, prev.ease_factor - 0.2),
      repetitions: 0,
    }
  }
  // correct
  const newReps = prev.repetitions + 1
  let newInterval: number
  if (newReps === 1) newInterval = 1
  else if (newReps === 2) newInterval = 6
  else newInterval = Math.round(prev.interval_days * prev.ease_factor)

  return {
    interval_days: newInterval,
    ease_factor: Math.min(2.8, prev.ease_factor + 0.1),
    repetitions: newReps,
  }
}

const updateProgress = db.prepare(`
  UPDATE word_progress
  SET interval_days = @interval_days,
      ease_factor = @ease_factor,
      repetitions = @repetitions,
      next_review_date = @next_review_date,
      last_reviewed_date = @date,
      total_reviews = total_reviews + 1,
      correct_reviews = correct_reviews + @correct_inc,
      status = @status
  WHERE word_id = @word_id
`)

const getProgress = db.prepare('SELECT * FROM word_progress WHERE word_id = ?')

let updatedCount = 0

const updateAll = db.transaction(() => {
  for (const wid of correctIds) {
    const prev = getProgress.get(wid) as
      | { interval_days: number; ease_factor: number; repetitions: number }
      | undefined
    if (!prev) continue
    const next = nextSm2State(prev, true)
    const nextDate = new Date()
    nextDate.setDate(nextDate.getDate() + next.interval_days)
    updateProgress.run({
      ...next,
      next_review_date: nextDate.toISOString().split('T')[0],
      date,
      correct_inc: 1,
      status: next.repetitions >= 5 && next.interval_days >= 30 ? 'mastered' : 'review',
      word_id: wid,
    })
    updatedCount++
  }

  for (const wid of incorrectIds) {
    const prev = getProgress.get(wid) as
      | { interval_days: number; ease_factor: number; repetitions: number }
      | undefined
    if (!prev) continue
    const next = nextSm2State(prev, false)
    updateProgress.run({
      ...next,
      next_review_date: date, // re-review tomorrow (since interval=1)
      date,
      correct_inc: 0,
      status: 'learning',
      word_id: wid,
    })
    updatedCount++
  }

  // Insert detailed mistake records
  const insertMistake = db.prepare(`
    INSERT INTO word_mistakes (word_id, session_id, context, user_answer, correct_answer, error_type)
    VALUES (@word_id, @session_id, @context, @user_answer, @correct_answer, @error_type)
  `)
  for (const m of mistakes) {
    insertMistake.run({
      word_id: m.word_id,
      session_id: session.id,
      context: m.context,
      user_answer: m.user_answer,
      correct_answer: m.correct_answer,
      error_type: m.error_type ?? 'unknown',
    })
  }

  // Update session
  db.prepare(
    `UPDATE daily_sessions
     SET cloze_correct = cloze_correct + @correct_count,
         cloze_total = cloze_total + @total_count,
         whole_dictation_done = @whole,
         notes = COALESCE(NULLIF(@notes, ''), notes)
     WHERE session_date = @date`
  ).run({
    correct_count: correctIds.length,
    total_count: correctIds.length + incorrectIds.length,
    whole: values['whole-dictation'] ? 1 : 0,
    notes: values.notes,
    date,
  })
})

updateAll()

console.log(`✓ Updated ${updatedCount} words via SM-2`)
if (mistakes.length > 0) {
  console.log(`✓ Recorded ${mistakes.length} detailed mistake(s) in word_mistakes`)
}

// Show next review dates summary
const upcoming = db
  .prepare(
    `SELECT next_review_date, COUNT(*) as c FROM word_progress
     WHERE next_review_date >= ?
     GROUP BY next_review_date
     ORDER BY next_review_date
     LIMIT 7`
  )
  .all(date) as { next_review_date: string; c: number }[]

if (upcoming.length > 0) {
  console.log(`\nUpcoming reviews:`)
  for (const u of upcoming) {
    console.log(`  ${u.next_review_date}: ${u.c} words`)
  }
}

db.close()
