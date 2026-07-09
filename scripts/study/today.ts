import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const DB_PATH = resolve('db/ieltsy.db')

const { values } = parseArgs({
  options: {
    force: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
})

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

interface UserState {
  target_band: number
  baseline_cefr: string | null
  target_date: string
  daily_new_words: number
  daily_new_grammar: number
}

interface WordRow {
  id: number
  headword: string
  pos: string
  cefr_level: string | null
  awl_sublist: number | null
  definition_en: string | null
  pronunciation_uk: string | null
}

interface GrammarRow {
  id: number
  chapter: number
  section: string | null
  title: string
  importance: number
  description: string | null
}

const state = db.prepare('SELECT * FROM user_state WHERE id = 1').get() as UserState | undefined
if (!state) {
  console.error('No study plan found. Run:')
  console.error('  pnpm study init --target-band 7 --target-date 2026-12-01')
  process.exit(1)
}

const today = new Date().toISOString().split('T')[0]!

// 为当日学习产物建好文件夹（Codex/LLM 编排器之后会往里写 article.md / session.md）
const dayFolder = resolve('learning/days', today)
mkdirSync(dayFolder, { recursive: true })

// Existing session check
const existingSession = db
  .prepare('SELECT * FROM daily_sessions WHERE session_date = ?')
  .get(today) as
  | {
      new_word_ids: string
      new_grammar_id: number | null
      review_word_ids: string
      article_genre: string | null
      article_path: string | null
      session_path: string | null
    }
  | undefined

let newWordIds: number[]
let grammarId: number | null
let reviewWordIds: number[]
let articleGenre: string
let articlePath: string
let sessionPath: string

if (existingSession && !values.force) {
  newWordIds = JSON.parse(existingSession.new_word_ids ?? '[]')
  grammarId = existingSession.new_grammar_id
  reviewWordIds = JSON.parse(existingSession.review_word_ids ?? '[]')
  articleGenre = existingSession.article_genre ?? 'narrative'
  articlePath = existingSession.article_path ?? `learning/days/${today}/article.md`
  sessionPath = existingSession.session_path ?? `learning/days/${today}/session.md`
} else {
  // Build today's plan
  let baselineFilter = ''
  if (state.baseline_cefr === 'A1') baselineFilter = `AND (w.cefr_level NOT IN ('A1') OR w.cefr_level IS NULL)`
  else if (state.baseline_cefr === 'A2') baselineFilter = `AND (w.cefr_level NOT IN ('A1','A2') OR w.cefr_level IS NULL)`
  else if (state.baseline_cefr === 'B1') baselineFilter = `AND (w.cefr_level NOT IN ('A1','A2','B1') OR w.cefr_level IS NULL)`
  else if (state.baseline_cefr === 'B2') baselineFilter = `AND (w.cefr_level NOT IN ('A1','A2','B1','B2') OR w.cefr_level IS NULL)`

  // Pick new words: dedupe by headword (smallest id wins), exclude already-learned
  // Order: CEFR ascending → AWL preferred → AWL sublist ascending → id
  const newWords = db
    .prepare(
      `
    SELECT id, headword, pos, cefr_level, awl_sublist, definition_en, pronunciation_uk
    FROM words w
    WHERE id IN (
      SELECT MIN(id) FROM words GROUP BY headword
    )
    AND id NOT IN (SELECT word_id FROM word_progress)
    AND pos IN ('n','v','adj','adv')
    AND headword NOT LIKE '% %'
    ${baselineFilter}
    ORDER BY
      CASE w.cefr_level
        WHEN 'A2' THEN 1 WHEN 'B1' THEN 2 WHEN 'B2' THEN 3 WHEN 'C1' THEN 4 ELSE 5
      END,
      CASE WHEN w.awl_sublist IS NOT NULL THEN 1 ELSE 2 END,
      w.awl_sublist,
      w.id
    LIMIT ?
  `
    )
    .all(state.daily_new_words) as WordRow[]

  newWordIds = newWords.map((w) => w.id)

  // Pick new grammar: highest importance first, smallest id
  const newGrammar = db
    .prepare(
      `
    SELECT id, chapter, section, title, importance, description
    FROM grammar_points g
    WHERE id NOT IN (SELECT grammar_id FROM grammar_progress)
    ORDER BY importance DESC, chapter, id
    LIMIT 1
  `
    )
    .get() as GrammarRow | undefined
  grammarId = newGrammar?.id ?? null

  // Review queue: due today
  const reviewWords = db
    .prepare(
      `
    SELECT w.id
    FROM word_progress wp
    JOIN words w ON w.id = wp.word_id
    WHERE wp.next_review_date <= ?
      AND wp.status != 'mastered'
      AND wp.first_seen_date < ?
    ORDER BY wp.next_review_date, wp.ease_factor
    LIMIT 20
  `
    )
    .all(today, today) as { id: number }[]
  reviewWordIds = reviewWords.map((r) => r.id)

  // Determine genre from ISO weekday (Mon=narrative, Tue=argumentative, etc.)
  const weekday = new Date(today).getUTCDay() // 0=Sun ... 6=Sat
  const genreByDay = ['argumentative', 'narrative', 'argumentative', 'descriptive', 'expository', 'dialogue', 'narrative']
  articleGenre = genreByDay[weekday]!

  articlePath = `learning/days/${today}/article.md`
  sessionPath = `learning/days/${today}/session.md`

  // Save session draft (or replace if force)
  if (existingSession) {
    db.prepare('DELETE FROM daily_sessions WHERE session_date = ?').run(today)
  }
  db.prepare(
    `INSERT INTO daily_sessions (session_date, new_word_ids, new_grammar_id, review_word_ids,
                                  article_genre, article_path, session_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(today, JSON.stringify(newWordIds), grammarId, JSON.stringify(reviewWordIds),
        articleGenre, articlePath, sessionPath)

  // Mark new words as 'learning'
  const initWordProgress = db.prepare(`
    INSERT INTO word_progress (word_id, first_seen_date, status, next_review_date)
    VALUES (?, ?, 'learning', ?)
    ON CONFLICT(word_id) DO NOTHING
  `)
  db.transaction(() => {
    for (const id of newWordIds) {
      initWordProgress.run(id, today, today)
    }
  })()

  // Mark grammar as studied
  if (grammarId) {
    db.prepare(`
      INSERT INTO grammar_progress (grammar_id, first_seen_date, status)
      VALUES (?, ?, 'studied')
      ON CONFLICT(grammar_id) DO NOTHING
    `).run(grammarId, today)
  }
}

// Hydrate full data
const newWords = db
  .prepare(`SELECT * FROM words WHERE id IN (${newWordIds.map(() => '?').join(',') || 'NULL'})`)
  .all(...newWordIds) as WordRow[]

const grammar = grammarId
  ? (db.prepare('SELECT * FROM grammar_points WHERE id = ?').get(grammarId) as GrammarRow)
  : null

const reviewWords = db
  .prepare(`SELECT * FROM words WHERE id IN (${reviewWordIds.map(() => '?').join(',') || 'NULL'})`)
  .all(...reviewWordIds) as WordRow[]

// Output
if (values.json) {
  console.log(
    JSON.stringify(
      {
        date: today,
        plan: state,
        article_genre: articleGenre,
        article_path: articlePath,
        session_path: sessionPath,
        new_words: newWords,
        grammar,
        review_words: reviewWords,
      },
      null,
      2
    )
  )
} else {
  console.log(`=== 今日学习计划 (${today}) ===`)
  console.log(`体裁: ${articleGenre} | article: ${articlePath} | session: ${sessionPath}\n`)

  console.log(`📚 新词 (${newWords.length})`)
  for (const w of newWords) {
    const meta = [w.pos, w.cefr_level, w.awl_sublist ? `AWL${w.awl_sublist}` : null]
      .filter(Boolean)
      .join(' · ')
    const def = w.definition_en ? ` — ${w.definition_en.slice(0, 60)}` : ''
    console.log(`  ${w.headword.padEnd(18)} (${meta})${def}`)
  }
  console.log()

  if (grammar) {
    console.log(`📖 语法点`)
    console.log(`  #${grammar.id} Ch.${grammar.chapter} | ${grammar.title} ${'★'.repeat(grammar.importance)}`)
    if (grammar.section) console.log(`  ${grammar.section}`)
    if (grammar.description) console.log(`  ${grammar.description}`)
    console.log()
  }

  if (reviewWords.length > 0) {
    console.log(`🔄 复习队列 (${reviewWords.length})`)
    for (const w of reviewWords.slice(0, 15)) {
      console.log(`  ${w.headword.padEnd(18)} ${w.cefr_level ?? ''}`)
    }
    if (reviewWords.length > 15) console.log(`  ... 还有 ${reviewWords.length - 15} 个`)
    console.log()
  } else {
    console.log(`🔄 今日无复习任务\n`)
  }

  // Compact JSON for Codex/LLM consumption
  console.log('--- DATA (JSON) ---')
  console.log(
    JSON.stringify({
      date: today,
      article_genre: articleGenre,
      article_path: articlePath,
      session_path: sessionPath,
      new_words: newWords.map((w) => ({
        id: w.id,
        headword: w.headword,
        pos: w.pos,
        cefr: w.cefr_level,
        def: w.definition_en,
      })),
      grammar: grammar
        ? { id: grammar.id, title: grammar.title, importance: grammar.importance, description: grammar.description }
        : null,
      review_words: reviewWords.map((w) => ({ id: w.id, headword: w.headword, def: w.definition_en })),
    })
  )
}

db.close()
