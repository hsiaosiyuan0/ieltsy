import Database from 'better-sqlite3'
import { createReadStream, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const DB_PATH = resolve('db/ieltsy.db')
const ECDICT_PATH = resolve('data/ecdict.csv')

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

function normalizeTranslation(raw: string): string {
  return raw.replace(/\\n/g, '\n').trim()
}

async function main(): Promise<void> {
  if (!existsSync(ECDICT_PATH)) {
    console.error(`× ECDICT not found at ${ECDICT_PATH}`)
    console.error('  Download from https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv')
    process.exit(1)
  }

  const db = new Database(DB_PATH)
  db.pragma('foreign_keys = ON')

  const targetSet = new Set<string>()
  for (const row of db.prepare('SELECT DISTINCT lower(headword) AS h FROM words').all() as { h: string }[]) {
    targetSet.add(row.h)
  }
  console.log(`Loaded ${targetSet.size} distinct headwords from db`)

  const updateZh = db.prepare(`
    UPDATE words SET definition_zh = @zh
    WHERE lower(headword) = @hw AND (definition_zh IS NULL OR definition_zh = '')
  `)

  let header: string[] | null = null
  let wordIdx = -1
  let translationIdx = -1
  const matches = new Map<string, string>()

  const rl = createInterface({
    input: createReadStream(ECDICT_PATH, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line) continue
    const fields = parseCsvLine(line)
    if (!header) {
      header = fields
      wordIdx = header.indexOf('word')
      translationIdx = header.indexOf('translation')
      if (wordIdx < 0 || translationIdx < 0) {
        console.error('× ecdict.csv missing required columns "word" and "translation"')
        process.exit(1)
      }
      continue
    }
    const word = fields[wordIdx]?.trim().toLowerCase()
    const translation = fields[translationIdx]
    if (!word || !translation) continue
    if (!targetSet.has(word)) continue
    if (matches.has(word)) continue
    matches.set(word, normalizeTranslation(translation))
  }

  console.log(`Matched ${matches.size} / ${targetSet.size} headwords in ECDICT`)

  let updated = 0
  const writeAll = db.transaction(() => {
    for (const [hw, zh] of matches) {
      const r = updateZh.run({ hw, zh })
      if (r.changes > 0) updated += r.changes
    }
  })
  writeAll()

  console.log(`✓ Updated definition_zh for ${updated} word rows`)

  const filled = db.prepare("SELECT COUNT(*) AS n FROM words WHERE definition_zh IS NOT NULL AND definition_zh <> ''").get() as { n: number }
  const total = db.prepare('SELECT COUNT(*) AS n FROM words').get() as { n: number }
  console.log(`Total coverage: ${filled.n} / ${total.n} (${((filled.n / total.n) * 100).toFixed(1)}%)`)

  db.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
