import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'

const DB_PATH = resolve('db/ieltsy.db')
const TOPICS_DIR = resolve('vocabulary/topics')

type Category = 'writing-task2' | 'speaking-daily'

interface ParsedItem {
  text: string
  section: string
  isCollocation: boolean
}

interface ParsedTopic {
  slug: string
  nameEn: string
  nameZh: string
  category: Category
  displayOrder: number
  items: ParsedItem[]
}

function parseTopicFile(filename: string, content: string): ParsedTopic {
  const lines = content.split('\n')

  const titleLine = lines.find((l) => l.startsWith('# '))
  if (!titleLine) throw new Error(`No title in ${filename}`)

  // # Topic NN — NameEn 中文名
  const titleMatch = titleLine.match(/^# Topic (\d+) — (.+?)\s+([一-鿿].*)$/)
  if (!titleMatch) throw new Error(`Bad title format in ${filename}: ${titleLine}`)

  const num = parseInt(titleMatch[1]!, 10)
  const nameEn = titleMatch[2]!.trim()
  const nameZh = titleMatch[3]!.trim()

  const category: Category = num <= 15 ? 'writing-task2' : 'speaking-daily'
  const slug = basename(filename, '.md').replace(/^\d+-/, '')

  const items: ParsedItem[] = []
  let currentSection = '其他'
  let currentSubsection: string | null = null
  let inCollocationSection = false

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (line === '---') break // hit footer
    if (!line) continue

    // ## Section
    if (line.startsWith('## ')) {
      currentSection = line.slice(3).trim()
      currentSubsection = null
      inCollocationSection = /搭配|习语|短语/.test(currentSection)
      continue
    }

    // ### Subsection
    if (line.startsWith('### ')) {
      currentSubsection = line.slice(4).trim()
      continue
    }

    // Skip top-level title and nav links
    if (line.startsWith('# ')) continue
    if (line.startsWith('[') || line.startsWith('>')) continue

    // Strip leading bullet
    let textLine = line
    if (textLine.startsWith('- ')) textLine = textLine.slice(2)
    else if (textLine.startsWith('* ')) textLine = textLine.slice(2)

    // Strip "**Bold**: " prefix used in body-appearance / clothing files
    textLine = textLine.replace(/^\*\*[^*]+\*\*[:：]\s*/, '')

    // Split by ' / '
    const tokens = textLine.split(/\s*\/\s*/).map((t) => t.trim()).filter(Boolean)

    const sectionLabel = currentSubsection
      ? `${currentSection} / ${currentSubsection}`
      : currentSection

    for (const rawToken of tokens) {
      // Cleanup
      let token = rawToken
        .replace(/\*\*/g, '') // bold
        .replace(/`/g, '') // code
        .replace(/（[^）]*）/g, '') // chinese parens
        .replace(/\([^)]*\)/g, '') // english parens
        .trim()

      if (!token) continue
      if (token.includes('[') || token.includes(']')) continue
      if (/[一-鿿]/.test(token)) continue // skip if has chinese after cleanup
      if (token.length < 2 || token.length > 80) continue

      items.push({
        text: token,
        section: sectionLabel,
        isCollocation: inCollocationSection,
      })
    }
  }

  return { slug, nameEn, nameZh, category, displayOrder: num, items }
}

function inferPos(section: string): string {
  if (section.includes('名词') || section.includes('身体部位') || section.includes('元素')) return 'n'
  if (section.includes('动词')) return 'v'
  if (section.includes('形容词')) return 'adj'
  if (section.includes('副词')) return 'adv'
  if (section.includes('搭配') || section.includes('习语') || section.includes('短语')) return 'phrase'
  return 'unknown'
}

function main(): void {
  const db = new Database(DB_PATH)
  db.pragma('foreign_keys = ON')

  const files = readdirSync(TOPICS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()

  console.log(`Found ${files.length} topic files\n`)

  const insertTopic = db.prepare(`
    INSERT INTO topics (slug, name_en, name_zh, category, display_order)
    VALUES (@slug, @nameEn, @nameZh, @category, @displayOrder)
    ON CONFLICT(slug) DO UPDATE SET
      name_en = excluded.name_en,
      name_zh = excluded.name_zh,
      category = excluded.category,
      display_order = excluded.display_order
    RETURNING id
  `)

  const insertWord = db.prepare(`
    INSERT INTO words (headword, pos)
    VALUES (@headword, @pos)
    ON CONFLICT(headword, pos) DO UPDATE SET headword = excluded.headword
    RETURNING id
  `)

  const insertWordTopic = db.prepare(`
    INSERT INTO word_topics (word_id, topic_id, section)
    VALUES (@wordId, @topicId, @section)
    ON CONFLICT(word_id, topic_id) DO UPDATE SET section = excluded.section
  `)

  const insertCollocation = db.prepare(`
    INSERT INTO collocations (collocation, topic_id)
    VALUES (@collocation, @topicId)
  `)

  let topicCount = 0
  let wordCount = 0
  let collocationCount = 0

  const importAll = db.transaction(() => {
    for (const filename of files) {
      const content = readFileSync(resolve(TOPICS_DIR, filename), 'utf-8')
      const topic = parseTopicFile(filename, content)

      const topicRow = insertTopic.get(topic) as { id: number }
      topicCount++

      for (const item of topic.items) {
        const pos = inferPos(item.section)

        if (item.isCollocation || pos === 'phrase') {
          insertCollocation.run({ collocation: item.text, topicId: topicRow.id })
          collocationCount++
        } else {
          const wordRow = insertWord.get({ headword: item.text, pos }) as { id: number }
          insertWordTopic.run({
            wordId: wordRow.id,
            topicId: topicRow.id,
            section: item.section,
          })
          wordCount++
        }
      }
    }
  })

  importAll()

  console.log(`✓ Imported:`)
  console.log(`  - ${topicCount} topics`)
  console.log(`  - ${wordCount} word→topic links`)
  console.log(`  - ${collocationCount} collocations`)

  db.close()
}

main()
