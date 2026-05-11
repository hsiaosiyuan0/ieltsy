import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const DB_PATH = resolve('db/ieltsy.db')
const GRAMMAR_DIR = resolve('grammar')

function main(): void {
  const db = new Database(DB_PATH)
  db.pragma('foreign_keys = ON')

  const files = readdirSync(GRAMMAR_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()

  const insert = db.prepare(`
    INSERT INTO grammar_points (id, chapter, section, title, importance, description)
    VALUES (@id, @chapter, @section, @title, @importance, @description)
    ON CONFLICT(id) DO UPDATE SET
      chapter = excluded.chapter,
      section = excluded.section,
      title = excluded.title,
      importance = excluded.importance,
      description = excluded.description
  `)

  let total = 0

  const importAll = db.transaction(() => {
    for (const file of files) {
      const chapterMatch = file.match(/^(\d+)-/)
      if (!chapterMatch) continue
      const chapter = parseInt(chapterMatch[1]!, 10)

      const content = readFileSync(resolve(GRAMMAR_DIR, file), 'utf-8')
      const lines = content.split('\n')

      let currentSection: string | null = null

      for (const rawLine of lines) {
        const line = rawLine.trimEnd()

        // Section header: ## §1.2 状语从句
        const sectionMatch = line.match(/^##\s+(§[\d.]+.*)$/)
        if (sectionMatch) {
          currentSection = sectionMatch[1] ?? null
          continue
        }

        // Subsection: ### 时间 etc. (kept under last §)
        // Skip unless it's a §-style heading

        // Grammar point with description: "1. 一般现在时 ★★★ — 真理 / 习惯 / 状态"
        // or "234. Type 4 — 三词短语动词 ★★（look forward to / put up with）"
        const withDesc = line.match(/^(\d+)\.\s+(.+?)\s+(★+)\s*[—\-]\s*(.+)$/)
        if (withDesc) {
          insert.run({
            id: parseInt(withDesc[1]!, 10),
            chapter,
            section: currentSection,
            title: withDesc[2]!.trim(),
            importance: withDesc[3]!.length,
            description: withDesc[4]!.trim(),
          })
          total++
          continue
        }

        // Grammar point with parenthetical: "16. used to do ★★★（说明）"
        const withParen = line.match(/^(\d+)\.\s+(.+?)\s+(★+)\s*[（(](.+?)[)）]\s*$/)
        if (withParen) {
          insert.run({
            id: parseInt(withParen[1]!, 10),
            chapter,
            section: currentSection,
            title: withParen[2]!.trim(),
            importance: withParen[3]!.length,
            description: withParen[4]!.trim(),
          })
          total++
          continue
        }

        // Grammar point no description: "16. used to do ★★★"
        const titleOnly = line.match(/^(\d+)\.\s+(.+?)\s+(★+)\s*$/)
        if (titleOnly) {
          insert.run({
            id: parseInt(titleOnly[1]!, 10),
            chapter,
            section: currentSection,
            title: titleOnly[2]!.trim(),
            importance: titleOnly[3]!.length,
            description: '',
          })
          total++
          continue
        }
      }
    }
  })

  importAll()

  console.log(`✓ Grammar imported: ${total} points`)

  // Stats by chapter
  const byChapter = db
    .prepare(`SELECT chapter, COUNT(*) as count FROM grammar_points GROUP BY chapter ORDER BY chapter`)
    .all() as { chapter: number; count: number }[]
  console.log('  By chapter:')
  for (const r of byChapter) {
    console.log(`    Ch.${r.chapter}: ${r.count}`)
  }

  const byImportance = db
    .prepare(`SELECT importance, COUNT(*) as count FROM grammar_points GROUP BY importance ORDER BY importance DESC`)
    .all() as { importance: number; count: number }[]
  console.log('  By importance:')
  for (const r of byImportance) {
    console.log(`    ${'★'.repeat(r.importance)}: ${r.count}`)
  }

  db.close()
}

main()
