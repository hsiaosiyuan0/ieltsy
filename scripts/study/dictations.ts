import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { discoverDictationLibrary, nextDictationAttempt } from './dictation-library'
import { assertDictationProjection, syncDictationProjection } from './dictation-projection'

const { values } = parseArgs({
  options: {
    date: { type: 'string' },
    sync: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
})

const date = values.date ?? new Date().toISOString().slice(0, 10)
const library = discoverDictationLibrary()

if (values.sync || values.check) {
  const db = new Database(resolve('db/ieltsy.db'))
  db.pragma('foreign_keys = ON')
  if (values.sync) syncDictationProjection(db, library.attempts)
  assertDictationProjection(db, library.attempts)
  db.close()
}

const attempts = library.byDate.get(date) ?? []
const next = nextDictationAttempt(date, library)
const output = {
  date,
  attempts: attempts.map((attempt) => ({
    attempt_number: attempt.attemptNumber,
    practiced_at: attempt.practicedAt,
    correct_words: attempt.correctWords,
    total_words: attempt.totalWords,
    accuracy: attempt.accuracy,
    result: attempt.result,
    path: attempt.relativePath,
  })),
  next_attempt: { attempt_number: next.number, path: next.path },
  projection: values.sync ? 'synced' : values.check ? 'verified' : 'not_checked',
}

if (values.json) {
  console.log(JSON.stringify(output, null, 2))
} else {
  console.log(`=== 整篇默写 (${date}) ===`)
  if (attempts.length === 0) console.log('暂无记录')
  for (const attempt of attempts) {
    console.log(`  #${attempt.attemptNumber} · ${attempt.practicedAt} · ${attempt.accuracy}% · ${attempt.result}`)
  }
  console.log(`下一次: #${next.number} → ${next.path}`)
  if (values.sync) console.log(`✓ Synced ${library.attempts.length} dictation attempt(s) to SQLite`)
  else if (values.check) console.log(`✓ Verified ${library.attempts.length} dictation attempt(s) against SQLite`)
}
