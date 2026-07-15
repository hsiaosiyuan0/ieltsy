import Database from 'better-sqlite3'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { toAmericanEnglish, toAmericanHeadword } from './study-profile'

/**
 * 从 db 重新生成错题本 md 文件。
 * mistakes/*.md 是 db 的"视图"，不应手工编辑（每次 render 会覆盖）。
 */

const DB_PATH = resolve('db/ieltsy.db')
const WORDS_MD_PATH = resolve('learning/mistakes/words.md')
const GRAMMAR_MD_PATH = resolve('learning/mistakes/grammar.md')

const db = new Database(DB_PATH, { readonly: true })

interface WordMistakeRow {
  id: number
  word_id: number
  session_date: string
  context: string
  user_answer: string
  correct_answer: string
  error_type: string
  headword: string
  pos: string
  cefr_level: string | null
  awl_sublist: number | null
  definition_en: string | null
}

interface GrammarMistakeRow {
  id: number
  grammar_id: number | null
  session_date: string
  context: string
  user_answer: string
  correct_answer: string
  error_note: string | null
  grammar_title: string | null
  grammar_chapter: number | null
  grammar_importance: number | null
}

function renderWords(): void {
  const rows = db
    .prepare(
      `
    SELECT
      wm.id, wm.word_id, wm.context, wm.user_answer, wm.correct_answer, wm.error_type,
      ds.session_date,
      w.headword, w.pos, w.cefr_level, w.awl_sublist, w.definition_en
    FROM word_mistakes wm
    JOIN daily_sessions ds ON ds.id = wm.session_id
    JOIN words w ON w.id = wm.word_id
    ORDER BY ds.session_date DESC, wm.id DESC
  `
    )
    .all() as WordMistakeRow[]

  const lines: string[] = []
  lines.push('# 单词错题本')
  lines.push('')
  lines.push('> 由 db 自动生成（`pnpm study:render-mistakes`），勿手动编辑。')
  lines.push('> 按时间倒序：最新答错的在最上面。')
  lines.push('')

  if (rows.length === 0) {
    lines.push('_暂无错题。_')
    writeFileSync(WORDS_MD_PATH, lines.join('\n') + '\n')
    console.log(`✓ ${WORDS_MD_PATH} (0 mistakes)`)
    return
  }

  // Group by date
  const byDate = new Map<string, WordMistakeRow[]>()
  for (const r of rows) {
    if (!byDate.has(r.session_date)) byDate.set(r.session_date, [])
    byDate.get(r.session_date)!.push(r)
  }

  for (const [date, dateRows] of byDate) {
    lines.push(`---`)
    lines.push('')
    lines.push(`## ${date}`)
    lines.push('')
    dateRows.forEach((r, idx) => {
      const meta = [r.pos, r.cefr_level, r.awl_sublist ? `AWL${r.awl_sublist}` : null].filter(Boolean).join(' · ')
      lines.push(`### ${idx + 1}. \`${toAmericanHeadword(r.headword)}\` (${meta})`)
      if (r.definition_en) lines.push(`- **定义**: ${toAmericanEnglish(r.definition_en)}`)
      lines.push(`- **上下文**: ${r.context}`)
      lines.push(`- **你的答案**: \`${r.user_answer}\``)
      lines.push(`- **正确答案**: \`${r.correct_answer}\``)
      lines.push(`- **错误类型**: ${r.error_type}`)
      lines.push('')
    })
  }

  writeFileSync(WORDS_MD_PATH, lines.join('\n'))
  console.log(`✓ ${WORDS_MD_PATH} (${rows.length} mistakes across ${byDate.size} days)`)
}

function renderGrammar(): void {
  const rows = db
    .prepare(
      `
    SELECT
      gm.id, gm.grammar_id, gm.context, gm.user_answer, gm.correct_answer, gm.error_note,
      ds.session_date,
      gp.title as grammar_title, gp.chapter as grammar_chapter, gp.importance as grammar_importance
    FROM grammar_mistakes gm
    JOIN daily_sessions ds ON ds.id = gm.session_id
    LEFT JOIN grammar_points gp ON gp.id = gm.grammar_id
    ORDER BY ds.session_date DESC, gm.id DESC
  `
    )
    .all() as GrammarMistakeRow[]

  const lines: string[] = []
  lines.push('# 语法错题本')
  lines.push('')
  lines.push('> 由 db 自动生成（`pnpm study:render-mistakes`），勿手动编辑。')
  lines.push('')

  if (rows.length === 0) {
    lines.push('_暂无错题。_')
    writeFileSync(GRAMMAR_MD_PATH, lines.join('\n') + '\n')
    console.log(`✓ ${GRAMMAR_MD_PATH} (0 mistakes)`)
    return
  }

  const byDate = new Map<string, GrammarMistakeRow[]>()
  for (const r of rows) {
    if (!byDate.has(r.session_date)) byDate.set(r.session_date, [])
    byDate.get(r.session_date)!.push(r)
  }

  for (const [date, dateRows] of byDate) {
    lines.push(`---`)
    lines.push('')
    lines.push(`## ${date}`)
    lines.push('')
    dateRows.forEach((r, idx) => {
      const title = r.grammar_title
        ? `${r.grammar_title} (Ch.${r.grammar_chapter} ${'★'.repeat(r.grammar_importance ?? 0)})`
        : '(未关联语法点)'
      lines.push(`### ${idx + 1}. ${title}`)
      lines.push(`- **上下文**: ${r.context}`)
      lines.push(`- **你的答案**: ${r.user_answer}`)
      lines.push(`- **正确答案**: ${r.correct_answer}`)
      if (r.error_note) lines.push(`- **错误**: ${r.error_note}`)
      lines.push('')
    })
  }

  writeFileSync(GRAMMAR_MD_PATH, lines.join('\n'))
  console.log(`✓ ${GRAMMAR_MD_PATH} (${rows.length} mistakes across ${byDate.size} days)`)
}

renderWords()
renderGrammar()

db.close()
