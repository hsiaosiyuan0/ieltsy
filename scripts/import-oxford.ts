import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DB_PATH = resolve('db/ieltsy.db')
const OXFORD_5000_PATH = resolve('data/oxford_5000.csv')
const OXFORD_3000_PATH = resolve('data/oxford_3000.csv')

interface OxfordRow {
  word: string
  type: string
  cefr: string
  phon_br: string
  phon_n_am: string
  definition: string
  example: string
}

function normalizePos(type: string): string {
  const t = type.trim().toLowerCase()
  if (t === 'noun') return 'n'
  if (t === 'verb' || t === 'modal verb' || t === 'auxiliary verb' || t === 'linking verb') return 'v'
  if (t === 'adjective') return 'adj'
  if (t === 'adverb') return 'adv'
  if (t === 'pronoun') return 'pron'
  if (t === 'preposition') return 'prep'
  if (t === 'conjunction') return 'conj'
  if (t === 'determiner') return 'det'
  if (t === 'number' || t === 'ordinal number') return 'num'
  if (t === 'exclamation') return 'excl'
  if (t.includes('article')) return 'art'
  if (t === 'infinitive marker') return 'marker'
  return 'unknown'
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  let i = 0
  while (i < line.length) {
    const c = line[i]!
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
      } else {
        current += c
        i++
      }
    } else {
      if (c === '"') {
        inQuotes = true
        i++
      } else if (c === ',') {
        result.push(current)
        current = ''
        i++
      } else {
        current += c
        i++
      }
    }
  }
  result.push(current)
  return result
}

function parseCsv(content: string): OxfordRow[] {
  const rows: OxfordRow[] = []
  const lines = content.split(/\r?\n/)
  if (lines.length < 2) return rows
  const headers = parseCsvLine(lines[0]!)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim()) continue
    const fields = parseCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => {
      row[h] = fields[idx] ?? ''
    })
    rows.push(row as unknown as OxfordRow)
  }
  return rows
}

function main(): void {
  const db = new Database(DB_PATH)
  db.pragma('foreign_keys = ON')

  const ox5000 = parseCsv(readFileSync(OXFORD_5000_PATH, 'utf-8'))
  const ox3000 = parseCsv(readFileSync(OXFORD_3000_PATH, 'utf-8'))

  const ox3000Set = new Set(ox3000.map((r) => r.word.toLowerCase().trim()))

  console.log(`Oxford 5000: ${ox5000.length} rows`)
  console.log(`Oxford 3000: ${ox3000.length} rows`)

  const insertWord = db.prepare(`
    INSERT INTO words (
      headword, pos, pronunciation_uk, pronunciation_us,
      definition_en, cefr_level, oxford_3000, oxford_5000
    ) VALUES (
      @headword, @pos, @pronUk, @pronUs, @defEn, @cefr, @ox3000, @ox5000
    )
    ON CONFLICT(headword, pos) DO UPDATE SET
      pronunciation_uk = COALESCE(excluded.pronunciation_uk, pronunciation_uk),
      pronunciation_us = COALESCE(excluded.pronunciation_us, pronunciation_us),
      definition_en    = COALESCE(excluded.definition_en, definition_en),
      cefr_level       = COALESCE(excluded.cefr_level, cefr_level),
      oxford_3000      = max(excluded.oxford_3000, oxford_3000),
      oxford_5000      = max(excluded.oxford_5000, oxford_5000)
    RETURNING id
  `)

  const insertExample = db.prepare(`
    INSERT INTO examples (word_id, sentence, source)
    VALUES (@wordId, @sentence, 'oxford-5000')
  `)

  let upserted = 0
  let exampleCount = 0
  let skipped = 0

  const importAll = db.transaction(() => {
    for (const row of ox5000) {
      const headword = row.word?.trim()
      if (!headword) {
        skipped++
        continue
      }

      const pos = normalizePos(row.type)
      const rawCefr = row.cefr?.trim().toUpperCase()
      const cefr = rawCefr && /^[ABC][12]$/.test(rawCefr) ? rawCefr : null
      const isOx3000 = ox3000Set.has(headword.toLowerCase()) ? 1 : 0

      const result = insertWord.get({
        headword,
        pos,
        pronUk: row.phon_br?.trim() || null,
        pronUs: row.phon_n_am?.trim() || null,
        defEn: row.definition?.trim() || null,
        cefr,
        ox3000: isOx3000,
        ox5000: 1,
      }) as { id: number } | undefined

      if (result?.id) {
        upserted++
        const example = row.example?.trim()
        if (example) {
          insertExample.run({ wordId: result.id, sentence: example })
          exampleCount++
        }
      }
    }
  })

  importAll()

  console.log()
  console.log(`✓ Oxford import:`)
  console.log(`  - ${upserted} word entries upserted`)
  console.log(`  - ${exampleCount} examples added`)
  console.log(`  - ${skipped} skipped (no headword)`)

  db.close()
}

main()
