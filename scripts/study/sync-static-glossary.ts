import Database from 'better-sqlite3'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sourceHeadwordCandidates } from './study-profile'

const DB_PATH = resolve('db/ieltsy.db')
const GLOSSARY_PATH = resolve('learning/glossary.zh.json')
const DAYS_DIR = resolve('learning/days')

interface TargetWord {
  word: string
  pos: string
}

interface DefinitionRow {
  definition_zh: string
}

function normalizePos(pos: string): string {
  return pos.trim().toLowerCase().replace(/\*/g, '')
}

function posCandidates(pos: string): string[] {
  const candidates = pos.split('/').map((part) => part.trim()).filter(Boolean)
  return candidates.length > 0 ? candidates : [pos]
}

function definitionParts(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function compactZh(raw: string): string {
  return definitionParts(raw).join('；').replace(/\s+/g, ' ')
}

function definitionZhForPos(raw: string, pos: string): string {
  const parts = definitionParts(raw)
  const prefixes = posCandidates(normalizePos(pos)).flatMap((candidate) => {
    if (candidate === 'v') return ['v.', 'vt.', 'vi.']
    if (candidate === 'adj') return ['adj.', 'a.']
    if (candidate === 'adv') return ['adv.', 'ad.']
    return [`${candidate}.`]
  })
  const selected = parts.filter((part) => prefixes.some((prefix) => part.toLowerCase().startsWith(prefix)))
  return compactZh((selected.length > 0 ? selected : parts).join('\n'))
}

function discoverTargets(): TargetWord[] {
  if (!existsSync(DAYS_DIR)) return []

  const targets = new Map<string, TargetWord>()
  for (const entry of readdirSync(DAYS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
    const articlePath = join(DAYS_DIR, entry.name, 'article.md')
    if (!existsSync(articlePath)) continue

    let inWords = false
    for (const raw of readFileSync(articlePath, 'utf-8').split('\n')) {
      const line = raw.trim()
      if (line.startsWith('## 目标词覆盖')) {
        inWords = true
        continue
      }
      if (inWords && line.startsWith('## ')) {
        inWords = false
        continue
      }
      if (!inWords || line.includes('---') || line.includes('| 词 |') || line.includes('| # |')) continue

      const match = line.match(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/)
      if (!match) continue
      const target = { word: match[1]!.trim(), pos: match[2]!.trim() }
      targets.set(`${target.word.toLowerCase()}|${target.pos.toLowerCase()}`, target)
    }
  }
  return [...targets.values()]
}

function main(): void {
  if (!existsSync(DB_PATH)) {
    throw new Error(`SQLite database not found at ${DB_PATH}. Run pnpm db:reset first.`)
  }

  const glossary = existsSync(GLOSSARY_PATH)
    ? JSON.parse(readFileSync(GLOSSARY_PATH, 'utf-8')) as Record<string, string>
    : {}
  const targets = discoverTargets()
  const db = new Database(DB_PATH, { readonly: true })
  const byWordAndPos = db.prepare(`
    SELECT definition_zh FROM words
    WHERE lower(headword) = ? AND pos = ? AND definition_zh IS NOT NULL AND definition_zh <> ''
    LIMIT 1
  `)
  const byWord = db.prepare(`
    SELECT definition_zh FROM words
    WHERE lower(headword) = ? AND definition_zh IS NOT NULL AND definition_zh <> ''
    ORDER BY CASE pos WHEN 'n' THEN 1 WHEN 'v' THEN 2 WHEN 'adj' THEN 3 WHEN 'adv' THEN 4 ELSE 9 END
    LIMIT 1
  `)

  let added = 0
  const missing: string[] = []
  try {
    for (const target of targets) {
      const key = `${target.word.toLowerCase()}|${target.pos.toLowerCase()}`
      const normalizedKey = `${target.word.toLowerCase()}|${normalizePos(target.pos)}`
      if (glossary[key] || glossary[normalizedKey]) continue

      const normalizedPos = normalizePos(target.pos)
      let definition: string | undefined
      for (const sourceWord of sourceHeadwordCandidates(target.word)) {
        for (const candidate of posCandidates(normalizedPos)) {
          const row = byWordAndPos.get(sourceWord, candidate) as DefinitionRow | undefined
          if (row?.definition_zh) {
            definition = definitionZhForPos(row.definition_zh, normalizedPos)
            break
          }
        }
        if (definition) break
        const row = byWord.get(sourceWord) as DefinitionRow | undefined
        if (row?.definition_zh) {
          definition = definitionZhForPos(row.definition_zh, normalizedPos)
          break
        }
      }

      if (definition) {
        glossary[key] = definition
        added += 1
      } else {
        missing.push(key)
      }
    }
  } finally {
    db.close()
  }

  const sorted = Object.fromEntries(
    Object.entries(glossary).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  )
  writeFileSync(GLOSSARY_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf-8')

  console.log(`✓ Static glossary: ${Object.keys(sorted).length} entries (${added} added)`)
  console.log(`  Published targets: ${targets.length - missing.length}/${targets.length} resolved`)
  if (missing.length > 0) {
    console.error(`  Missing: ${missing.join(', ')}`)
    process.exitCode = 1
  }
}

main()
