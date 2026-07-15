import type Database from 'better-sqlite3'
import type { DictationAttempt } from './dictation-library'

export function ensureDictationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dictation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      attempt_number INTEGER NOT NULL,
      practiced_at TEXT NOT NULL,
      correct_words INTEGER NOT NULL,
      total_words INTEGER NOT NULL,
      accuracy REAL NOT NULL,
      passed INTEGER NOT NULL CHECK(passed IN (0, 1)),
      markdown_path TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, attempt_number),
      FOREIGN KEY (session_id) REFERENCES daily_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dictation_attempts_session ON dictation_attempts(session_id);
    CREATE INDEX IF NOT EXISTS idx_dictation_attempts_practiced ON dictation_attempts(practiced_at);
  `)
}

export function syncDictationProjection(db: Database.Database, attempts: DictationAttempt[]): void {
  ensureDictationSchema(db)
  const sessionByDate = new Map(
    (db.prepare('SELECT id, session_date FROM daily_sessions').all() as { id: number; session_date: string }[])
      .map((row) => [row.session_date, row.id])
  )
  const insert = db.prepare(`
    INSERT INTO dictation_attempts (
      session_id, attempt_number, practiced_at, correct_words, total_words, accuracy, passed, markdown_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  db.transaction(() => {
    db.prepare('DELETE FROM dictation_attempts').run()
    for (const attempt of attempts) {
      const sessionId = sessionByDate.get(attempt.articleDate)
      if (!sessionId) throw new Error(`${attempt.articleDate}: daily_sessions row is required before syncing dictation attempts`)
      insert.run(
        sessionId,
        attempt.attemptNumber,
        attempt.practicedAt,
        attempt.correctWords,
        attempt.totalWords,
        attempt.accuracy,
        attempt.passed ? 1 : 0,
        attempt.relativePath
      )
    }
  })()
}

export function assertDictationProjection(db: Database.Database, attempts: DictationAttempt[]): void {
  ensureDictationSchema(db)
  const rows = db.prepare(`
    SELECT ds.session_date, da.attempt_number, da.practiced_at, da.correct_words,
           da.total_words, da.accuracy, da.passed, da.markdown_path
    FROM dictation_attempts da
    JOIN daily_sessions ds ON ds.id = da.session_id
    ORDER BY ds.session_date DESC, da.attempt_number DESC
  `).all() as {
    session_date: string
    attempt_number: number
    practiced_at: string
    correct_words: number
    total_words: number
    accuracy: number
    passed: number
    markdown_path: string
  }[]

  if (rows.length !== attempts.length) {
    throw new Error(`Dictation projection has ${rows.length} rows; Markdown library has ${attempts.length}`)
  }
  for (const [index, attempt] of attempts.entries()) {
    const row = rows[index]!
    const expected = [
      attempt.articleDate,
      attempt.attemptNumber,
      attempt.practicedAt,
      attempt.correctWords,
      attempt.totalWords,
      attempt.accuracy,
      attempt.passed ? 1 : 0,
      attempt.relativePath,
    ]
    const actual = [
      row.session_date,
      row.attempt_number,
      row.practiced_at,
      row.correct_words,
      row.total_words,
      row.accuracy,
      row.passed,
      row.markdown_path,
    ]
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${attempt.relativePath}: SQLite dictation projection differs from Markdown`)
    }
  }
}
