import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ENGLISH_VARIANT, findBritishSpelling, preferredContextRegion } from './study-profile'

const DAYS_DIR = resolve('learning/days')
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const GENRES = new Set(['narrative', 'argumentative', 'descriptive', 'expository', 'dialogue'])

export const REAL_WORLD_CONTEXT_REQUIRED_SINCE = '2026-07-15'

export type ContextKind = 'current_event' | 'contemporary_issue' | 'recent_history' | 'modern_life'

export interface ContextSource {
  title: string
  publisher: string
  url: string
  published_date?: string
}

export interface ArticleContext {
  schema_version: 1
  lesson_date: string
  context_kind: ContextKind
  english_variant: typeof ENGLISH_VARIANT
  region_focus: string
  reference_year: number
  topic: string
  fact_summary: string
  present_connection: string
  adaptation_note: string
  sources: ContextSource[]
}

export interface ArticleHarnessResult {
  date: string
  genre: string
  wordCount: number
  sentenceCount: number
  targetCount: number
  context: ArticleContext | null
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function parseIsoDate(value: string, field: string): void {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(value), `${field} must use YYYY-MM-DD`)
  assert(!Number.isNaN(Date.parse(`${value}T00:00:00Z`)), `${field} is not a valid date`)
}

function articleWords(body: string): string[] {
  return body.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []
}

function extractSection(md: string, heading: string, nextHeadings?: string[]): string {
  const start = md.indexOf(`## ${heading}`)
  if (start < 0) return ''
  const contentStart = md.indexOf('\n', start)
  if (contentStart < 0) return ''
  const candidates = (nextHeadings ?? [])
    .map((next) => md.indexOf(`\n## ${next}`, contentStart + 1))
    .filter((index) => index >= 0)
  const genericNext = md.indexOf('\n## ', contentStart + 1)
  if (genericNext >= 0) candidates.push(genericNext)
  const end = candidates.length > 0 ? Math.min(...candidates) : md.length
  return md.slice(contentStart + 1, end).trim()
}

export function readArticleContext(
  date: string,
  required = date >= REAL_WORLD_CONTEXT_REQUIRED_SINCE
): ArticleContext | null {
  const path = join(DAYS_DIR, date, 'context.json')
  if (!existsSync(path)) {
    assert(!required, `${date}: context.json is required for real-world lesson context`)
    return null
  }

  let context: ArticleContext
  try {
    context = JSON.parse(readFileSync(path, 'utf-8')) as ArticleContext
  } catch (error) {
    throw new Error(`${date}: invalid context.json: ${error instanceof Error ? error.message : String(error)}`)
  }

  assert(context.schema_version === 1, `${date}: context.json schema_version must be 1`)
  assert(context.lesson_date === date, `${date}: context.json lesson_date must match directory date`)
  parseIsoDate(context.lesson_date, `${date}: lesson_date`)
  assert(
    ['current_event', 'contemporary_issue', 'recent_history', 'modern_life'].includes(context.context_kind),
    `${date}: unsupported context_kind`
  )
  assert(context.english_variant === ENGLISH_VARIANT, `${date}: english_variant must be ${ENGLISH_VARIANT}`)
  assert(context.region_focus?.trim(), `${date}: region_focus is required`)
  if (preferredContextRegion(date) === 'United States') {
    assert(context.region_focus === 'United States', `${date}: this lesson is scheduled for a United States context`)
  }
  const lessonYear = Number.parseInt(date.slice(0, 4), 10)
  assert(Number.isInteger(context.reference_year), `${date}: reference_year must be an integer`)
  assert(context.reference_year >= 1900, `${date}: reference_year must be 1900 or later`)
  assert(context.reference_year <= lessonYear, `${date}: reference_year cannot be later than the lesson year`)
  assert(context.topic.trim().length >= 8, `${date}: context topic is too short`)
  assert(context.fact_summary.trim().length >= 30, `${date}: fact_summary is too short`)
  assert(context.present_connection.trim().length >= 30, `${date}: present_connection is too short`)
  assert(context.adaptation_note.trim().length >= 20, `${date}: adaptation_note is too short`)
  assert(Array.isArray(context.sources) && context.sources.length >= 1, `${date}: at least one context source is required`)

  const urls = new Set<string>()
  for (const [index, source] of context.sources.entries()) {
    assert(source.title?.trim(), `${date}: source ${index + 1} needs a title`)
    assert(source.publisher?.trim(), `${date}: source ${index + 1} needs a publisher`)
    assert(/^https:\/\//.test(source.url ?? ''), `${date}: source ${index + 1} must use an HTTPS URL`)
    assert(!urls.has(source.url), `${date}: duplicate source URL ${source.url}`)
    urls.add(source.url)
    if (source.published_date) {
      parseIsoDate(source.published_date, `${date}: source ${index + 1} published_date`)
      assert(source.published_date <= date, `${date}: source ${index + 1} published_date cannot be later than the lesson`)
    }
  }

  return context
}

export function validateArticle(date: string): ArticleHarnessResult {
  parseIsoDate(date, 'lesson date')
  const path = join(DAYS_DIR, date, 'article.md')
  assert(existsSync(path), `${date}: article.md is missing`)
  const md = readFileSync(path, 'utf-8')
  const heading = md.match(/^#\s+(\d{4}-\d{2}-\d{2})\s+·\s+([A-Z]+)\s+·\s+(.+)$/m)
  assert(heading, `${date}: article heading must be "# YYYY-MM-DD · GENRE · Title"`)
  assert(heading[1] === date, `${date}: heading date does not match directory`)
  const genre = heading[2]!.toLowerCase()
  assert(GENRES.has(genre), `${date}: unsupported genre ${heading[2]}`)

  const meta = md.match(/^>\s+(.+)$/m)?.[1] ?? ''
  assert(meta.includes(`体裁: ${genre}`), `${date}: metadata genre must be ${genre}`)
  const targetMeta = meta.match(/新词:\s*(\d+)\/(\d+)/)
  assert(targetMeta, `${date}: metadata must include 新词: N/N`)
  assert(targetMeta[1] === targetMeta[2], `${date}: metadata reports incomplete target coverage`)
  assert(/语法点:.*#\d+/.test(meta), `${date}: metadata must include a canonical grammar id`)

  const articleBody = extractSection(md, '短文', ['中文翻译'])
  const translationBody = extractSection(md, '中文翻译', ['目标词覆盖'])
  assert(articleBody, `${date}: ## 短文 is empty or missing`)
  assert(translationBody, `${date}: ## 中文翻译 is empty or missing`)
  const englishSentences = [...articleBody.matchAll(/^([①-⑳])\s+(.+)$/gm)]
  const translatedSentences = [...translationBody.matchAll(/^([①-⑳])\s+(.+)$/gm)]
  assert(englishSentences.length > 0, `${date}: no circled English sentences found`)
  assert(englishSentences.length === translatedSentences.length, `${date}: English and Chinese sentence counts differ`)
  for (const [index, sentence] of englishSentences.entries()) {
    const expected = CIRCLED[index]
    assert(sentence[1] === expected, `${date}: English sentence numbering is not contiguous at ${expected}`)
    assert(translatedSentences[index]?.[1] === expected, `${date}: translation numbering is not contiguous at ${expected}`)
  }

  const wordCount = articleWords(articleBody).length
  assert(wordCount >= 200 && wordCount <= 300, `${date}: article has ${wordCount} words; expected 200-300`)
  const britishSpelling = findBritishSpelling(articleBody)
  assert(!britishSpelling, `${date}: use American English; found British spelling "${britishSpelling}"`)

  const targetRows = [...md.matchAll(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm)]
    .filter((match) => match[1]!.trim() !== '词')
  const targetCount = Number.parseInt(targetMeta[1]!, 10)
  assert(targetRows.length === targetCount, `${date}: expected ${targetCount} target rows, found ${targetRows.length}`)
  for (const row of targetRows) {
    const word = row[1]!.trim()
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const wordPattern = new RegExp(`\\b${escaped}(?:s|es|ed|d|ing)?\\b`, 'i')
    assert(wordPattern.test(articleBody), `${date}: target word "${word}" does not appear in the English article`)
  }
  assert(/^##\s+语法点示例\s*$/m.test(md), `${date}: ## 语法点示例 is missing`)
  assert(/^-\s*句\s*[①-⑳]/m.test(md), `${date}: at least one grammar example is required`)

  const contextRequired = date >= REAL_WORLD_CONTEXT_REQUIRED_SINCE
  const context = readArticleContext(date, contextRequired)
  if (context) {
    const contextSection = extractSection(md, '现实背景')
    assert(contextSection, `${date}: article.md must include ## 现实背景`)
    assert(contextSection.includes(String(context.reference_year)), `${date}: 现实背景 must state the reference year`)
    for (const source of context.sources) {
      assert(contextSection.includes(source.url), `${date}: 现实背景 must link source ${source.url}`)
    }
  }

  return {
    date,
    genre,
    wordCount,
    sentenceCount: englishSentences.length,
    targetCount,
    context,
  }
}

export function discoverArticleDates(): string[] {
  if (!existsSync(DAYS_DIR)) return []
  return readdirSync(DAYS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((date) => existsSync(join(DAYS_DIR, date, 'article.md')))
    .sort()
}
