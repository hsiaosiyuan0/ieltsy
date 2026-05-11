import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const DB_PATH = resolve('db/ieltsy.db')

const { values } = parseArgs({
  options: {
    'target-band': { type: 'string' },
    'target-date': { type: 'string' },
    'daily-words': { type: 'string', default: '17' },
    'daily-grammar': { type: 'string', default: '1' },
    'daily-minutes': { type: 'string', default: '30' },
    baseline: { type: 'string' },
    reset: { type: 'boolean', default: false },
  },
})

if (!values['target-band'] || !values['target-date']) {
  console.error('Usage:')
  console.error(
    '  pnpm study init --target-band 7.0 --target-date 2026-12-01 [--daily-words 17] [--baseline B1] [--reset]'
  )
  process.exit(1)
}

const db = new Database(DB_PATH)
db.pragma('foreign_keys = ON')

const targetBand = parseFloat(values['target-band']!)
const targetDate = values['target-date']!
const dailyWords = parseInt(values['daily-words']!, 10)
const dailyGrammar = parseInt(values['daily-grammar']!, 10)
const dailyMinutes = parseInt(values['daily-minutes']!, 10)
const baseline = values.baseline ?? null

if (values.reset) {
  db.exec(`
    DELETE FROM word_progress;
    DELETE FROM grammar_progress;
    DELETE FROM daily_sessions;
    DELETE FROM user_state;
  `)
  console.log('✓ Cleared previous progress\n')
}

db.prepare(
  `
  INSERT INTO user_state (id, target_band, baseline_cefr, target_date, daily_minutes, daily_new_words, daily_new_grammar)
  VALUES (1, @targetBand, @baseline, @targetDate, @dailyMinutes, @dailyWords, @dailyGrammar)
  ON CONFLICT(id) DO UPDATE SET
    target_band = excluded.target_band,
    baseline_cefr = excluded.baseline_cefr,
    target_date = excluded.target_date,
    daily_minutes = excluded.daily_minutes,
    daily_new_words = excluded.daily_new_words,
    daily_new_grammar = excluded.daily_new_grammar,
    updated_at = CURRENT_TIMESTAMP
`
).run({ targetBand, baseline, targetDate, dailyMinutes, dailyWords, dailyGrammar })

// 计划计算
const startDate = new Date()
const targetDateObj = new Date(targetDate)
const totalDays = Math.ceil((targetDateObj.getTime() - startDate.getTime()) / 86400000)

let baselineFilter = ''
if (baseline === 'A1') baselineFilter = `AND (cefr_level NOT IN ('A1') OR cefr_level IS NULL)`
else if (baseline === 'A2') baselineFilter = `AND (cefr_level NOT IN ('A1','A2') OR cefr_level IS NULL)`
else if (baseline === 'B1') baselineFilter = `AND (cefr_level NOT IN ('A1','A2','B1') OR cefr_level IS NULL)`
else if (baseline === 'B2') baselineFilter = `AND (cefr_level NOT IN ('A1','A2','B1','B2') OR cefr_level IS NULL)`

const wordPool = (
  db
    .prepare(
      `SELECT COUNT(*) as c FROM words
       WHERE pos IN ('n','v','adj','adv')
         AND headword NOT LIKE '% %'
         ${baselineFilter}`
    )
    .get() as { c: number }
).c

const grammarPool = (db.prepare('SELECT COUNT(*) as c FROM grammar_points').get() as { c: number }).c

const projectedWords = Math.min(dailyWords * totalDays, wordPool)
const projectedGrammar = Math.min(dailyGrammar * totalDays, grammarPool)

console.log('=== 学习计划已创建 ===\n')
console.log(`目标 Band:  ${targetBand}`)
console.log(`基础水平:   ${baseline ?? '未指定（不排除任何 CEFR 级别）'}`)
console.log(`开始日期:   ${startDate.toISOString().split('T')[0]}`)
console.log(`目标日期:   ${targetDate}`)
console.log(`总天数:     ${totalDays}`)
console.log()
console.log(`每日量:     ${dailyWords} 词 + ${dailyGrammar} 语法点 (≈ ${dailyMinutes} 分钟)`)
console.log()
console.log(`词汇池:     ${wordPool} 词 (按 baseline 过滤后)`)
console.log(`语法池:     ${grammarPool} 点`)
console.log()
console.log(`计划学完:   ${projectedWords} 词 / ${projectedGrammar} 语法点`)

if (dailyWords * totalDays < wordPool) {
  const needDays = Math.ceil(wordPool / dailyWords)
  console.log(`\n⚠️  当前节奏覆盖不完整词汇池，会优先学高频/低 CEFR 词。`)
  console.log(`   覆盖完整需 ${needDays} 天 (约 ${Math.round(needDays / 30)} 个月)`)
}

if (dailyWords * totalDays > wordPool * 1.2) {
  console.log(`\n💡 词汇池将在 ${Math.ceil(wordPool / dailyWords)} 天内学完，剩余时间将以复习为主`)
}

db.close()
