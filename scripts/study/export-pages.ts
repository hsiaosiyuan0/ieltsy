import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const CIRCLED_NUM_TO_INT: Record<string, number> = Object.fromEntries(
  CIRCLED.split('').map((c, i) => [c, i + 1])
)

interface Sentence {
  num: number
  text: string
  zh?: string
  audio?: string
  prosody?: ProsodyCue
}

interface TargetWord {
  word: string
  pos: string
  refs: string
  zh?: string
  audio?: string
}

interface GrammarExample {
  sentenceNum: number
  excerpt: string
  note: string
}

interface ParsedArticle {
  date: string
  title: string
  meta: string
  genre: string
  sentences: Sentence[]
  targetWords: TargetWord[]
  targetAudioByText?: Map<string, string>
  grammarTitle: string
  grammarDescription: string
  grammarExamples: GrammarExample[]
}

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'dist' },
    title: { type: 'string', default: 'IELTSY' },
  },
})

const OUT_DIR = resolve(values.out!)
const SITE_TITLE = values.title!
const STATIC_GLOSSARY_PATH = resolve('learning/glossary.zh.json')
const STATIC_PROSODY_PATH = resolve('learning/prosody.json')
const DB_PATH = resolve('db/ieltsy.db')
const AUDIO_CACHE_DIR = resolve('learning/audio-cache')
const AUDIO_VOICE = process.env.IELTSY_AUDIO_VOICE || 'en-US-EmmaMultilingualNeural'
const AUDIO_RATE = process.env.IELTSY_AUDIO_RATE || '+0%'
const SKIP_AUDIO = process.env.IELTSY_SKIP_AUDIO === '1'
const WEAK_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'that', 'which', 'who', 'whom', 'whose', 'when', 'where',
  'while', 'unless', 'because', 'as', 'than', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'from', 'with',
  'without', 'into', 'over', 'under', 'across', 'through', 'about', 'around', 'between', 'among', 'is',
  'are', 'am', 'was', 'were', 'be', 'been', 'being', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must', 'do', 'does', 'did', 'have', 'has', 'had', 'it', 'its', 'this', 'these', 'those',
  'they', 'them', 'their', 'he', 'him', 'his', 'she', 'her', 'we', 'us', 'our', 'you', 'your', 'i', 'my',
  'not', 'so', 'very', 'also', 'still', 'just',
])
const CLAUSE_STARTERS = new Set([
  'although', 'because', 'but', 'however', 'if', 'unless', 'when', 'where', 'which', 'while', 'who', 'that',
  'whether',
])
const SOFT_BREAKERS = new Set(['and', 'but', 'because', 'while', 'when', 'unless', 'which', 'that', 'to', 'for', 'of'])
const CONTRAST_STARTERS = new Set(['but', 'however', 'yet'])

interface ProsodyGroup {
  tokens: string[]
  boundary: 'soft' | 'comma' | 'major' | 'end'
}

interface ProsodyCueGroup {
  tokens: string[]
  tone: string
  start?: number
  end?: number
  pitchStart?: number
  pitchEnd?: number
  confidence?: number
}

interface ProsodyCue {
  source: string
  groups: ProsodyCueGroup[]
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

function parseArticleMd(date: string, md: string): ParsedArticle {
  const lines = md.split('\n')
  let title = ''
  let meta = ''
  let genre = ''
  const sentences: Sentence[] = []
  const targetWords: TargetWord[] = []
  let grammarTitle = ''
  let grammarDescription = ''
  const grammarExamples: GrammarExample[] = []

  let section: 'header' | 'article' | 'zh' | 'words' | 'grammar' | 'other' = 'header'

  for (const raw of lines) {
    const line = raw.trim()

    if (!title && line.startsWith('# ')) {
      title = line.slice(2).trim()
      continue
    }
    if (!meta && line.startsWith('> ')) {
      meta = line.slice(2).trim()
      const genreMatch = meta.match(/体裁:\s*([^|（(]+)/)
      if (genreMatch?.[1]) genre = genreMatch[1].trim()
      continue
    }

    if (line.startsWith('## 短文')) { section = 'article'; continue }
    if (line.startsWith('## 中文翻译') || line.startsWith('## 翻译')) { section = 'zh'; continue }
    if (line.startsWith('## 目标词覆盖')) { section = 'words'; continue }
    if (line.startsWith('## 语法点')) { section = 'grammar'; continue }
    if (line.startsWith('## ')) { section = 'other'; continue }

    if (section === 'article') {
      const m = line.match(/^([①-⑳])\s+(.+)$/)
      if (m) {
        sentences.push({ num: CIRCLED_NUM_TO_INT[m[1]!]!, text: m[2]!.trim() })
      }
    }

    if (section === 'zh') {
      const m = line.match(/^([①-⑳])\s+(.+)$/)
      if (m) {
        const found = sentences.find((s) => s.num === CIRCLED_NUM_TO_INT[m[1]!]!)
        if (found) found.zh = m[2]!.trim()
      }
    }

    if (section === 'words') {
      if (line.includes('---') || line.includes('| 词 |') || line.includes('| # |')) continue
      const m = line.match(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/)
      if (m) {
        targetWords.push({ word: m[1]!.trim(), pos: m[2]!.trim(), refs: m[3]!.trim() })
      }
    }

    if (section === 'grammar') {
      if (!grammarTitle && line.startsWith('**') && line.endsWith('**')) {
        const inner = line.slice(2, -2).trim()
        const dot = inner.indexOf('·')
        if (dot > 0) {
          grammarTitle = inner.slice(0, dot).replace(/[★]+/g, '').trim()
          grammarDescription = inner.slice(dot + 1).trim()
        } else {
          grammarTitle = inner.replace(/[★]+/g, '').trim()
        }
        continue
      }

      const m = line.match(/^-\s*句\s*([①-⑳])\s*[:：·]?\s*`?([^`]+?)`?\s*(?:——|--)\s*(.*)$/)
      if (m) {
        grammarExamples.push({
          sentenceNum: CIRCLED_NUM_TO_INT[m[1]!]!,
          excerpt: m[2]!.trim(),
          note: m[3]!.trim(),
        })
      }
    }
  }

  const titleGenre = title.split('·')[1]?.trim().toLowerCase()
  return {
    date,
    title,
    meta,
    genre: genre || titleGenre || 'lesson',
    sentences,
    targetWords,
    grammarTitle,
    grammarDescription,
    grammarExamples,
  }
}

function articleDisplayTitle(article: ParsedArticle): string {
  return article.title.split('·').slice(2).join('·').trim() || article.title.replace(/^#\s*/, '').trim() || article.date
}

function audioAttr(prefix: string, audio?: string): string {
  return audio ? ` data-audio="${prefix}assets/audio/${escapeHtml(audio)}"` : ''
}

function highlightTargets(text: string, targets: TargetWord[], targetAudioByText: Map<string, string>): string {
  let result = escapeHtml(text)
  const sorted = targets.map((target) => target.word).sort((a, b) => b.length - a.length)
  for (const word of sorted) {
    if (!word) continue
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`\\b(${safe}(?:s|es|ed|d|ing)?)\\b`, 'gi')
    result = result.replace(pattern, (_m, actual: string) => {
      const spoken = escapeHtml(actual)
      const audio = targetAudioByText.get(actual.toLowerCase()) ?? targetAudioByText.get(word.toLowerCase())
      return `<span class="target" role="button" tabindex="0" data-speak="${spoken}"${audio ? ` data-audio="${escapeHtml(audio)}"` : ''} title="显示 / 朗读">${spoken}</span>`
    })
  }
  return result
}

function targetFormsInText(text: string, targets: TargetWord[]): string[] {
  const forms = new Map<string, string>()
  const sorted = targets.map((target) => target.word).sort((a, b) => b.length - a.length)
  for (const word of sorted) {
    if (!word) continue
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`\\b(${safe}(?:s|es|ed|d|ing)?)\\b`, 'gi')
    for (const match of text.matchAll(pattern)) {
      const actual = match[1]?.trim()
      if (actual) forms.set(actual.toLowerCase(), actual)
    }
  }
  return [...forms.values()]
}

function normalizeSpeechWord(raw: string): string {
  return raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase()
}

function splitSpeechWords(text: string): string[] {
  return text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*|[.,;:!?—]/g) ?? []
}

function isPauseToken(token: string): boolean {
  return /^[,;:—]$/.test(token)
}

function isEndToken(token: string): boolean {
  return /^[.!?]$/.test(token)
}

function isStressWord(token: string): boolean {
  const word = normalizeSpeechWord(token)
  if (!word) return false
  if (word === 'ai') return true
  return !WEAK_WORDS.has(word) && word.length > 2
}

function prosodyGroups(text: string): ProsodyGroup[] {
  const rawGroups: ProsodyGroup[] = []
  let current: string[] = []

  function pushGroup(boundary: ProsodyGroup['boundary']): void {
    if (current.length > 0) {
      rawGroups.push({ tokens: current, boundary })
      current = []
    }
  }

  for (const token of splitSpeechWords(text)) {
    if (isEndToken(token)) {
      pushGroup('end')
      continue
    }
    if (isPauseToken(token)) {
      pushGroup(token === ',' ? 'comma' : 'major')
      continue
    }

    const word = normalizeSpeechWord(token)
    if (current.length >= 3 && CLAUSE_STARTERS.has(word)) pushGroup('soft')
    current.push(token)
  }

  pushGroup('end')
  return rawGroups.flatMap(splitLongProsodyGroup)
}

function splitLongProsodyGroup(group: ProsodyGroup): ProsodyGroup[] {
  if (group.tokens.length <= 9) return [group]

  const chunks: ProsodyGroup[] = []
  let remaining = group.tokens
  while (remaining.length > 9) {
    const limit = Math.min(9, remaining.length - 3)
    let cut = 0

    for (let i = limit; i >= 4; i -= 1) {
      const prev = normalizeSpeechWord(remaining[i - 1]!)
      const next = normalizeSpeechWord(remaining[i]!)
      if (SOFT_BREAKERS.has(next) && prev !== 'a' && prev !== 'an' && prev !== 'the') {
        cut = i
        break
      }
    }

    if (cut === 0) {
      for (let i = limit; i >= 5; i -= 1) {
        if (isStressWord(remaining[i - 1]!)) {
          cut = i
          break
        }
      }
    }

    chunks.push({ tokens: remaining.slice(0, cut || limit), boundary: 'soft' })
    remaining = remaining.slice(cut || limit)
  }
  chunks.push({ tokens: remaining, boundary: group.boundary })
  return chunks
}

function firstWord(group: ProsodyGroup | undefined): string {
  return normalizeSpeechWord(group?.tokens[0] ?? '')
}

function looksComplete(group: ProsodyGroup): boolean {
  const stressCount = group.tokens.filter(isStressWord).length
  const last = group.tokens[group.tokens.length - 1] ?? ''
  return group.tokens.length >= 4 && stressCount >= 2 && isStressWord(last)
}

function toneForGroup(group: ProsodyGroup, index: number, groups: ProsodyGroup[], finalTone: string): string {
  if (index === groups.length - 1 || group.boundary === 'end') return finalTone
  if (group.boundary === 'major') return '↘'
  if (group.boundary === 'comma' && CONTRAST_STARTERS.has(firstWord(groups[index + 1])) && looksComplete(group)) return '↘'
  return '↗'
}

function renderCueGroup(tokens: string[], tone: string): string {
  const words = tokens.map((word) => {
    const klass = isStressWord(word) ? 'stress' : 'weak'
    return `<span class="cue-word ${klass}">${escapeHtml(word)}</span>`
  }).join(' ')
  return `<span class="cue-group">${words}<span class="tone">${escapeHtml(tone)}</span></span>`
}

function renderFollowCue(text: string, cue?: ProsodyCue): string {
  if (cue?.groups?.length) {
    const renderedCue = cue.groups
      .filter((group) => group.tokens.length > 0)
      .map((group) => renderCueGroup(group.tokens, group.tone || '→'))
      .join('<span class="pause">/</span>')
    return `<span class="follow-cue" data-prosody-source="${escapeHtml(cue.source)}"><span class="follow-tag">跟读</span><span class="cue-line">${renderedCue}</span></span>`
  }

  const groups = prosodyGroups(text)
  if (groups.length === 0) return ''
  const finalTone = text.trim().endsWith('?') ? '↗' : '↘'
  const rendered = groups.map((group, index) => {
    const tone = toneForGroup(group, index, groups, finalTone)
    return renderCueGroup(group.tokens, tone)
  }).join('<span class="pause">/</span>')
  return `<span class="follow-cue" data-prosody-source="fallback"><span class="follow-tag">跟读</span><span class="cue-line">${rendered}</span></span>`
}

function renderRefs(refs: string): string {
  return refs.split(/\s+/).filter(Boolean).map((tok) => {
    const num = CIRCLED_NUM_TO_INT[tok]
    if (num) return `<a href="#sentence-${num}" class="ref">${tok}</a>`
    return `<span class="ref">${escapeHtml(tok)}</span>`
  }).join(' ')
}

function renderZhDefinition(word: TargetWord): string {
  const definition = word.zh?.trim()
  if (!definition) {
    return `<span class="word-zh missing"><span class="word-zh-label">中文释义</span><span>未收录中文释义</span></span>`
  }

  return `<span class="word-zh"><span class="word-zh-label">中文释义</span><span>${escapeHtml(definition)}</span></span>`
}

function glossaryKey(word: string, pos: string): string {
  return `${word.trim().toLowerCase()}|${pos.trim().toLowerCase()}`
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

function loadStaticGlossary(): Map<string, string> {
  const glossary = new Map<string, string>()
  if (!existsSync(STATIC_GLOSSARY_PATH)) return glossary

  const raw = JSON.parse(readFileSync(STATIC_GLOSSARY_PATH, 'utf-8')) as Record<string, string>
  for (const [key, value] of Object.entries(raw)) {
    if (value) glossary.set(key.toLowerCase(), compactZh(value))
  }
  return glossary
}

function createDbGlossaryLookup(): { lookup: (word: string, pos: string) => string | undefined; close: () => void } | null {
  if (!existsSync(DB_PATH)) return null
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
  return {
    lookup(word: string, pos: string): string | undefined {
      const normalizedWord = word.trim().toLowerCase()
      const normalizedPos = normalizePos(pos)
      for (const candidatePos of posCandidates(normalizedPos)) {
        const exact = byWordAndPos.get(normalizedWord, candidatePos) as { definition_zh: string } | undefined
        if (exact?.definition_zh) return definitionZhForPos(exact.definition_zh, normalizedPos)
      }
      const fallback = byWord.get(normalizedWord) as { definition_zh: string } | undefined
      return fallback?.definition_zh ? definitionZhForPos(fallback.definition_zh, normalizedPos) : undefined
    },
    close() {
      db.close()
    },
  }
}

function normalizePos(pos: string): string {
  return pos.trim().toLowerCase().replace(/\*/g, '')
}

function posCandidates(pos: string): string[] {
  const candidates = pos.split('/').map((part) => part.trim()).filter(Boolean)
  return candidates.length > 0 ? candidates : [pos]
}

function enrichTargetWords(
  targetWords: TargetWord[],
  glossary: Map<string, string>,
  dbLookup: { lookup: (word: string, pos: string) => string | undefined } | null
): void {
  for (const target of targetWords) {
    const staticZh = glossary.get(glossaryKey(target.word, target.pos)) ?? glossary.get(glossaryKey(target.word, normalizePos(target.pos)))
    target.zh = staticZh ?? dbLookup?.lookup(target.word, target.pos)
  }
}

function reportDefinitionCoverage(articles: ParsedArticle[]): void {
  const targets = articles.flatMap((article) => article.targetWords.map((word) => ({ article, word })))
  const missing = targets.filter(({ word }) => !word.zh?.trim())
  if (missing.length === 0) {
    console.log(`  Definitions: ${targets.length}/${targets.length} target words have Chinese definitions`)
    return
  }

  const sample = missing
    .slice(0, 8)
    .map(({ article, word }) => `${article.date}:${word.word}/${word.pos}`)
    .join(', ')
  console.warn(`  Definitions: ${targets.length - missing.length}/${targets.length} target words have Chinese definitions`)
  console.warn(`  Missing Chinese definitions: ${sample}${missing.length > 8 ? ', ...' : ''}`)
}

function audioCacheKey(text: string): string {
  return createHash('md5').update(`${AUDIO_VOICE}|${AUDIO_RATE}|${text}`).digest('hex').slice(0, 12)
}

function loadStaticProsody(): Map<string, ProsodyCue> {
  const prosody = new Map<string, ProsodyCue>()
  if (!existsSync(STATIC_PROSODY_PATH)) return prosody

  const raw = JSON.parse(readFileSync(STATIC_PROSODY_PATH, 'utf-8')) as {
    sentences?: Record<string, ProsodyCue>
  }
  for (const [key, cue] of Object.entries(raw.sentences ?? {})) {
    if (cue?.groups?.length) prosody.set(key, cue)
  }
  return prosody
}

function enrichSentencesWithProsody(sentences: Sentence[], prosody: Map<string, ProsodyCue>): void {
  for (const sentence of sentences) {
    sentence.prosody = prosody.get(audioCacheKey(sentence.text))
  }
}

function ensureAudio(text: string): string | undefined {
  const normalized = text.trim()
  if (!normalized || SKIP_AUDIO) return undefined

  mkdirSync(AUDIO_CACHE_DIR, { recursive: true })
  const key = audioCacheKey(normalized)
  const fileName = `${key}.mp3`
  const cachePath = join(AUDIO_CACHE_DIR, fileName)
  const outputPath = join(OUT_DIR, 'assets', 'audio', fileName)

  if (!existsSync(cachePath)) {
    const result = spawnSync(
      'edge-tts',
      ['--voice', AUDIO_VOICE, '--rate', AUDIO_RATE, '--text', normalized, '--write-media', cachePath],
      { encoding: 'utf-8' }
    )
    if (result.status !== 0) {
      throw new Error(`edge-tts failed for "${normalized.slice(0, 80)}": ${result.stderr || result.stdout || 'unknown error'}`)
    }
  }

  copyFileSync(cachePath, outputPath)
  return fileName
}

function prepareAudioAssets(articles: ParsedArticle[]): void {
  mkdirSync(join(OUT_DIR, 'assets', 'audio'), { recursive: true })
  const seen = new Map<string, string | undefined>()

  function ensureOnce(text: string): string | undefined {
    const normalized = text.trim()
    if (!seen.has(normalized)) seen.set(normalized, ensureAudio(normalized))
    return seen.get(normalized)
  }

  for (const article of articles) {
    article.targetAudioByText = new Map()
    for (const sentence of article.sentences) {
      sentence.audio = ensureOnce(sentence.text)
      for (const form of targetFormsInText(sentence.text, article.targetWords)) {
        const audio = ensureOnce(form)
        if (audio) article.targetAudioByText.set(form.toLowerCase(), `../../assets/audio/${audio}`)
      }
    }
    for (const target of article.targetWords) {
      target.audio = ensureOnce(target.word)
      if (target.audio) article.targetAudioByText.set(target.word.toLowerCase(), `../../assets/audio/${target.audio}`)
    }
  }

  if (SKIP_AUDIO) {
    console.log('  Audio: skipped via IELTSY_SKIP_AUDIO=1')
  } else {
    console.log(`  Audio: ${[...seen.values()].filter(Boolean).length} mp3 assets (${AUDIO_VOICE}, ${AUDIO_RATE})`)
  }
}

function icon(name: 'book' | 'home' | 'archive' | 'arrow-left' | 'arrow-right' | 'play' | 'translate' | 'eye' | 'check' | 'calendar' | 'layers' | 'wave'): string {
  const paths: Record<typeof name, string> = {
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
    archive: '<path d="M3 5h18"/><path d="M5 5v14h14V5"/><path d="M9 9h6"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow-right': '<path d="m12 5 7 7-7 7"/><path d="M5 12h14"/>',
    play: '<path d="m8 5 11 7-11 7V5z"/>',
    translate: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    wave: '<path d="M2 12h2"/><path d="M6 9v6"/><path d="M10 5v14"/><path d="M14 8v8"/><path d="M18 10v4"/><path d="M22 12h-2"/>',
  }
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`
}

function renderShell(opts: {
  title: string
  description: string
  prefix: string
  current?: 'home' | 'mistakes'
  bodyAttrs?: string
  body: string
}): string {
  const navHome = opts.current === 'home' ? 'aria-current="page"' : ''
  const navMistakes = opts.current === 'mistakes' ? 'aria-current="page"' : ''
  const homeHref = opts.prefix || './'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHtml(opts.description)}">
  <meta name="theme-color" content="#4f46e5">
  <title>${escapeHtml(opts.title)} · ${escapeHtml(SITE_TITLE)}</title>
  <link rel="icon" href="${opts.prefix}favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${opts.prefix}assets/site.css">
  <link rel="manifest" href="${opts.prefix}manifest.webmanifest">
</head>
<body${opts.bodyAttrs ? ` ${opts.bodyAttrs}` : ''}>
  <a class="skip-link" href="#content">跳到正文</a>
  <div class="app-shell">
    <aside class="sh-sidebar" aria-label="应用导航">
      <a class="brand" href="${homeHref}" aria-label="IELTSY 首页">
        <span class="brand-mark">${icon('book')}</span>
        <span class="brand-copy"><strong>IELTSY</strong><span>Band 7 loop</span></span>
      </a>
      <nav class="sidebar-nav" aria-label="主导航">
        <a class="nav-item" href="${homeHref}" ${navHome}>${icon('home')}<span>学习日</span></a>
        <a class="nav-item" href="${opts.prefix}mistakes/" ${navMistakes}>${icon('archive')}<span>错题本</span></a>
      </nav>
      <div class="sidebar-meta">
        <span>Static Pages</span>
        <span>Local first</span>
      </div>
    </aside>
    <div class="app-main">
${opts.body}
    </div>
  </div>
  <script src="${opts.prefix}assets/site.js" defer></script>
</body>
</html>
`
}

function renderIndex(articles: ParsedArticle[]): string {
  const latest = articles[0]
  const totalWords = articles.reduce((sum, article) => sum + article.targetWords.length, 0)
  const latestTitle = latest ? articleDisplayTitle(latest) : '暂无学习日'
  const latestHref = latest ? `days/${latest.date}/` : '#'
  const lessonItems = articles.map((article) => {
    const title = articleDisplayTitle(article)
    return `            <a class="lesson-row" href="days/${article.date}/">
          <span class="lesson-date">${escapeHtml(article.date)}</span>
          <span class="lesson-row-main">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(article.genre)} · ${article.targetWords.length} 词 · ${escapeHtml(article.grammarTitle || '语法点')}</span>
          </span>
          <span class="row-icon">${icon('arrow-right')}</span>
        </a>`
  }).join('\n')

  const body = `      <main id="content" class="page-shell home-page">
      <section class="sh-card home-hero">
        <div class="hero-copy">
          <p class="eyebrow">Current lesson</p>
          <h1>${escapeHtml(latestTitle)}</h1>
          <div class="badge-row">
            <span class="sh-badge secondary">${icon('calendar')}${escapeHtml(latest?.date ?? '-')}</span>
            <span class="sh-badge secondary">${icon('layers')}${escapeHtml(latest?.genre ?? 'lesson')}</span>
            <span class="sh-badge outline">${latest?.targetWords.length ?? 0} 词</span>
          </div>
        </div>
        <div class="hero-actions">
          <a class="sh-button primary" href="${latestHref}">${icon('play')}<span>继续学习</span></a>
          <a class="sh-button outline" href="mistakes/">${icon('archive')}<span>错题本</span></a>
        </div>
      </section>

      <section class="stats-grid" aria-label="学习统计">
        <div class="sh-card stat-card"><span>${articles.length}</span><small>学习日</small></div>
        <div class="sh-card stat-card"><span>${totalWords}</span><small>目标词</small></div>
        <div class="sh-card stat-card"><span>${escapeHtml(latest?.date ?? '-')}</span><small>最近更新</small></div>
      </section>

      <section class="sh-card lessons-card">
        <div class="card-header">
            <h2>Learning timeline</h2>
            <p>${escapeHtml(latestTitle)}</p>
        </div>
        <div class="lesson-list">
${lessonItems || '            <p class="empty">还没有可发布的 article.md。</p>'}
        </div>
      </section>
    </main>`

  return renderShell({
    title: '学习日',
    description: 'IELTSY mobile study archive',
    prefix: '',
    current: 'home',
    body,
  })
}

function renderDay(article: ParsedArticle): string {
  const title = articleDisplayTitle(article)
  const metaParts = article.meta.split('|').map((part) => part.trim()).filter(Boolean)
  const targetAudioByText = article.targetAudioByText ?? new Map()
  const sentencesHtml = article.sentences.map((sentence) => `          <p class="sentence" id="sentence-${sentence.num}" data-text="${escapeHtml(sentence.text)}"${audioAttr('../../', sentence.audio)}>
            <button class="sentence-play" type="button" data-action="play-sentence" aria-label="朗读第 ${sentence.num} 句">${icon('play')}</button>
            <span class="num">${CIRCLED[sentence.num - 1]}</span>
            <span class="sentence-text">
              <span class="en">${highlightTargets(sentence.text, article.targetWords, targetAudioByText)}</span>
              ${renderFollowCue(sentence.text, sentence.prosody)}
              ${sentence.zh ? `<span class="zh">${escapeHtml(sentence.zh)}</span>` : ''}
            </span>
          </p>`).join('\n')

  const wordsHtml = article.targetWords.map((word) => `            <li>
              <button type="button" class="word-button" data-speak="${escapeHtml(word.word)}"${audioAttr('../../', word.audio)}>${escapeHtml(word.word)}</button>
              <span class="sh-badge secondary pos">${escapeHtml(word.pos)}</span>
              ${renderZhDefinition(word)}
              <span class="refs"><span class="refs-label">出现</span>${renderRefs(word.refs)}</span>
            </li>`).join('\n')

  const grammarHtml = article.grammarExamples.map((example) => `            <li>
              <span class="sent-num">${CIRCLED[example.sentenceNum - 1]}</span>
              <code>${escapeHtml(example.excerpt)}</code>
              ${example.note ? `<span class="note">${escapeHtml(example.note)}</span>` : ''}
            </li>`).join('\n')

  const body = `      <main id="content" class="page-shell lesson-page">
    <section class="sh-card lesson-hero">
      <div class="lesson-hero-top">
        <a class="sh-button ghost back-link" href="../../">${icon('arrow-left')}<span>学习日</span></a>
      </div>
      <div class="lesson-hero-grid">
        <div>
          <p class="eyebrow">${escapeHtml(article.date)} · ${escapeHtml(article.genre)}</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <div class="badge-row hero-badges">
          ${metaParts.map((part) => `<span class="sh-badge outline">${escapeHtml(part)}</span>`).join('\n          ')}
        </div>
      </div>
    </section>

    <section class="command-bar" aria-label="学习工具">
        <button class="sh-button primary tool-button" type="button" data-action="play-all">${icon('play')}<span>全文</span></button>
        <button class="sh-button outline tool-button" type="button" data-action="toggle-zh" aria-pressed="false">${icon('translate')}<span>译文</span></button>
        <button class="sh-button outline tool-button" type="button" data-action="toggle-follow" aria-pressed="true">${icon('wave')}<span>跟读</span></button>
        <button class="sh-button outline tool-button" type="button" data-action="toggle-practice" aria-pressed="false">${icon('eye')}<span>遮词</span></button>
        <label class="sh-button outline done-toggle">
          <input type="checkbox" data-action="mark-done">
          ${icon('check')}
          <span>完成</span>
        </label>
    </section>

    <div class="lesson-grid">
      <article class="sh-card reader-card" aria-label="短文">
${sentencesHtml}
      </article>

      <aside class="side-stack" aria-label="目标词和语法点">
        <section class="sh-card vocab-card">
          <div class="card-header compact">
            <h2>目标词</h2>
            <span class="sh-badge secondary">${article.targetWords.length} words</span>
          </div>
          <ol class="word-list">
${wordsHtml}
          </ol>
        </section>

        <section class="sh-card grammar-card">
          <div class="card-header compact">
            <h2>语法点</h2>
          </div>
          <p class="grammar-title">${escapeHtml(article.grammarTitle || '未记录')}</p>
          ${article.grammarDescription ? `<p class="grammar-desc">${escapeHtml(article.grammarDescription)}</p>` : ''}
          <ul class="grammar-list">
${grammarHtml}
          </ul>
        </section>

        <section class="sh-card prosody-card">
          <div class="card-header compact"><h2>跟读规律</h2></div>
          <div class="prosody-legend">
            <span><strong>粗体</strong> 重读信息词</span>
            <span><span class="cue-word weak">浅色</span> 弱读功能词</span>
            <span><b>/</b> 意群停顿</span>
            <span><b>↗</b> 话没说完，轻轻托住</span>
            <span><b>↘</b> 句子结束，声音落下</span>
          </div>
        </section>
      </aside>
    </div>
  </main>`

  return renderShell({
    title,
    description: `${article.date} IELTSY lesson`,
    prefix: '../../',
    bodyAttrs: `data-date="${escapeHtml(article.date)}"`,
    body,
  })
}

function renderInlineMd(raw: string): string {
  let html = escapeHtml(raw)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return html
}

function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let listOpen = false

  function flushParagraph(): void {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInlineMd(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }

  function closeList(): void {
    if (listOpen) {
      html.push('</ul>')
      listOpen = false
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      flushParagraph()
      closeList()
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      closeList()
      const level = heading[1]!.length + 1
      html.push(`<h${level}>${renderInlineMd(heading[2]!)}</h${level}>`)
      continue
    }

    if (trimmed.startsWith('> ')) {
      flushParagraph()
      closeList()
      html.push(`<blockquote>${renderInlineMd(trimmed.slice(2))}</blockquote>`)
      continue
    }

    if (trimmed.startsWith('- ')) {
      flushParagraph()
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      html.push(`<li>${renderInlineMd(trimmed.slice(2))}</li>`)
      continue
    }

    paragraph.push(trimmed)
  }

  flushParagraph()
  closeList()
  return html.join('\n')
}

function renderMistakesPage(kind: 'words' | 'grammar', markdown: string): string {
  const title = kind === 'words' ? '单词错题' : '语法错题'
  const body = `      <main id="content" class="page-shell mistakes-page">
    <section class="sh-card page-hero compact">
      <a class="sh-button ghost back-link" href="../">${icon('arrow-left')}<span>学习日</span></a>
      <p class="eyebrow">Mistakes</p>
      <h1>${title}</h1>
    </section>
    <article class="sh-card markdown-card">
${renderMarkdown(markdown)}
    </article>
  </main>`

  return renderShell({
    title,
    description: `${SITE_TITLE} ${title}`,
    prefix: '../',
    current: 'mistakes',
    body,
  })
}

function renderMistakesIndex(): string {
  const body = `      <main id="content" class="page-shell mistakes-page">
    <section class="sh-card page-hero compact">
      <a class="sh-button ghost back-link" href="../">${icon('arrow-left')}<span>学习日</span></a>
      <p class="eyebrow">Mistakes</p>
      <h1>错题本</h1>
    </section>
    <div class="lesson-list mistakes-list">
      <a class="lesson-row" href="words.html">
        <span class="lesson-date">Words</span>
        <span class="lesson-row-main"><strong>单词错题</strong><span>最近答错的目标词</span></span>
        <span class="row-icon">${icon('arrow-right')}</span>
      </a>
      <a class="lesson-row" href="grammar.html">
        <span class="lesson-date">Grammar</span>
        <span class="lesson-row-main"><strong>语法错题</strong><span>需要回看的语法点</span></span>
        <span class="row-icon">${icon('arrow-right')}</span>
      </a>
    </div>
  </main>`

  return renderShell({
    title: '错题本',
    description: `${SITE_TITLE} mistake archive`,
    prefix: '../',
    current: 'mistakes',
    body,
  })
}

function renderNotFound(): string {
  return renderShell({
    title: '页面不存在',
    description: `${SITE_TITLE} not found`,
    prefix: '',
    body: `      <main id="content" class="page-shell home-page">
    <section class="sh-card home-hero">
      <p class="eyebrow">404</p>
      <h1>页面不存在</h1>
      <div class="hero-actions"><a class="sh-button primary" href="./">${icon('home')}<span>返回首页</span></a></div>
    </section>
  </main>`,
  })
}

function discoverArticles(): ParsedArticle[] {
  const daysDir = resolve('learning/days')
  if (!existsSync(daysDir)) return []

  const glossary = loadStaticGlossary()
  const prosody = loadStaticProsody()
  const dbLookup = createDbGlossaryLookup()
  const articles: ParsedArticle[] = []
  try {
    for (const entry of readdirSync(daysDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
      const articlePath = join(daysDir, entry.name, 'article.md')
      if (!existsSync(articlePath)) continue
      const parsed = parseArticleMd(entry.name, readFileSync(articlePath, 'utf-8'))
      enrichTargetWords(parsed.targetWords, glossary, dbLookup)
      enrichSentencesWithProsody(parsed.sentences, prosody)
      articles.push(parsed)
    }
  } finally {
    dbLookup?.close()
  }

  return articles.sort((a, b) => b.date.localeCompare(a.date))
}

function writePage(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

const SITE_CSS = `:root {
  color-scheme: light;
  --background: 236 100% 98%;
  --foreground: 240 31% 12%;
  --card: 0 0% 100%;
  --card-foreground: 240 31% 12%;
  --muted: 236 48% 96%;
  --muted-foreground: 235 12% 43%;
  --primary: 243 75% 59%;
  --primary-foreground: 0 0% 100%;
  --secondary: 238 84% 96%;
  --secondary-foreground: 244 47% 32%;
  --accent: 142 71% 45%;
  --accent-foreground: 144 61% 15%;
  --warning: 34 92% 50%;
  --border: 229 30% 88%;
  --ring: 243 75% 59%;
  --radius: 8px;
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.05);
  --shadow-md: 0 18px 40px rgba(49, 46, 129, 0.10);
  --shadow-lg: 0 24px 60px rgba(49, 46, 129, 0.14);
  --target: hsl(32 95% 37%);
  --target-bg: hsl(39 100% 92%);
  --transition: 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

* { box-sizing: border-box; }
html {
  min-width: 320px;
  font-size: 16px;
  scroll-padding-top: 24px;
}
body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(180deg, hsl(236 100% 98%) 0%, hsl(236 88% 97%) 48%, hsl(220 43% 97%) 100%);
  color: hsl(var(--foreground));
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.55;
  text-rendering: optimizeLegibility;
  overflow-x: hidden;
  overscroll-behavior: contain;
}
a { color: inherit; }
button, input { font: inherit; }
button, a, label { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
button { cursor: pointer; }

.skip-link {
  position: fixed;
  left: 16px;
  top: 12px;
  z-index: 80;
  translate: 0 -160%;
  border: 1px solid hsl(var(--ring));
  border-radius: var(--radius);
  background: hsl(var(--card));
  color: hsl(var(--primary));
  padding: 10px 12px;
  font-weight: 700;
  box-shadow: var(--shadow-md);
}
.skip-link:focus { translate: 0 0; }

.icon {
  width: 1.05em;
  height: 1.05em;
  flex: 0 0 auto;
}

.sh-card {
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  background: hsl(var(--card));
  color: hsl(var(--card-foreground));
  box-shadow: var(--shadow-sm);
}
.sh-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  min-height: 40px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  padding: 0 14px;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1;
  text-decoration: none;
  cursor: pointer;
  transition: background var(--transition), border-color var(--transition), color var(--transition), box-shadow var(--transition);
}
.sh-button:hover { box-shadow: var(--shadow-sm); }
.sh-button.primary {
  border-color: hsl(var(--primary));
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}
.sh-button.primary:hover { background: hsl(243 75% 54%); }
.sh-button.outline {
  border-color: hsl(var(--border));
  background: hsl(var(--card));
  color: hsl(var(--foreground));
}
.sh-button.outline:hover {
  background: hsl(var(--secondary));
  color: hsl(var(--secondary-foreground));
}
.sh-button.ghost {
  background: transparent;
  color: hsl(var(--muted-foreground));
}
.sh-button.ghost:hover {
  background: hsl(var(--secondary));
  color: hsl(var(--secondary-foreground));
}
.sh-button[aria-pressed="true"] {
  border-color: hsl(var(--primary) / 0.28);
  background: hsl(var(--secondary));
  color: hsl(var(--primary));
}
.sh-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: fit-content;
  min-height: 24px;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0 9px;
  font-size: 0.76rem;
  font-weight: 750;
  line-height: 1;
  white-space: nowrap;
}
.sh-badge.secondary {
  border-color: hsl(var(--secondary));
  background: hsl(var(--secondary));
  color: hsl(var(--secondary-foreground));
}
.sh-badge.outline {
  border-color: hsl(var(--border));
  background: hsl(var(--card));
  color: hsl(var(--muted-foreground));
}

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
}
.app-main {
  min-width: 0;
}
.sh-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 24px;
  border-right: 1px solid hsl(var(--border));
  background: hsl(var(--card) / 0.86);
  backdrop-filter: blur(18px);
  padding: 20px 14px;
  z-index: 30;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 8px;
  color: hsl(var(--foreground));
  text-decoration: none;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid hsl(var(--primary) / 0.24);
  border-radius: var(--radius);
  background: hsl(var(--secondary));
  color: hsl(var(--primary));
}
.brand-copy {
  min-width: 0;
  display: grid;
  gap: 1px;
}
.brand-copy strong {
  font-size: 0.95rem;
  line-height: 1;
}
.brand-copy span {
  color: hsl(var(--muted-foreground));
  font-size: 0.76rem;
  font-weight: 650;
}
.sidebar-nav {
  display: grid;
  align-content: start;
  gap: 6px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  border-radius: var(--radius);
  color: hsl(var(--muted-foreground));
  padding: 0 10px;
  font-size: 0.9rem;
  font-weight: 700;
  text-decoration: none;
  transition: background var(--transition), color var(--transition);
}
.nav-item:hover,
.nav-item[aria-current="page"] {
  background: hsl(var(--secondary));
  color: hsl(var(--primary));
}
.sidebar-meta {
  display: grid;
  gap: 4px;
  border-top: 1px solid hsl(var(--border));
  color: hsl(var(--muted-foreground));
  padding: 14px 10px 0;
  font-size: 0.76rem;
  font-weight: 650;
}

.page-shell {
  width: min(1180px, calc(100% - 40px));
  margin: 0 auto;
  padding: 28px 0 72px;
}
.home-page, .mistakes-page {
  display: grid;
  gap: 16px;
}

.home-hero, .lesson-hero, .page-hero {
  padding: 28px;
  position: relative;
  overflow: hidden;
}
.home-hero::before, .lesson-hero::before, .page-hero::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 4px;
  background: linear-gradient(90deg, hsl(var(--primary)), hsl(var(--accent)), hsl(var(--warning)));
}
.home-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: end;
  min-height: 320px;
}
.hero-copy {
  min-width: 0;
}
.eyebrow {
  margin: 0 0 12px;
  color: hsl(var(--primary));
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  color: hsl(var(--foreground));
  font-size: 3.7rem;
  line-height: 1;
  letter-spacing: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.badge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}
.hero-actions {
  display: grid;
  gap: 10px;
  min-width: 180px;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.stat-card {
  display: grid;
  gap: 8px;
  min-height: 112px;
  padding: 18px;
}
.stat-card span {
  color: hsl(var(--primary));
  font-size: 2.6rem;
  font-weight: 850;
  line-height: 1;
}
.stat-card small {
  color: hsl(var(--muted-foreground));
  font-size: 0.84rem;
  font-weight: 750;
}
.lessons-card, .markdown-card {
  padding: 18px;
}
.card-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid hsl(var(--border));
  margin-bottom: 12px;
  padding-bottom: 12px;
}
.card-header.compact {
  align-items: center;
}
.card-header h2 {
  margin: 0;
  font-size: 1rem;
}
.card-header p {
  margin: 0;
  color: hsl(var(--muted-foreground));
}
.lesson-list {
  display: grid;
  gap: 8px;
}
.lesson-row {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr) 40px;
  gap: 12px;
  align-items: center;
  min-height: 72px;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  background: hsl(var(--card));
  padding: 10px 12px;
  text-decoration: none;
  transition: border-color var(--transition), box-shadow var(--transition), translate var(--transition);
}
.lesson-row:hover {
  border-color: hsl(var(--primary) / 0.32);
  box-shadow: var(--shadow-md);
  translate: 0 -1px;
}
.lesson-date {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 24px;
  width: fit-content;
  border: 1px solid hsl(var(--border));
  border-radius: 999px;
  color: hsl(var(--muted-foreground));
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.78rem;
  font-weight: 750;
  padding: 0 9px;
}
.lesson-row-main {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.lesson-row-main strong {
  color: hsl(var(--foreground));
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.lesson-row-main span {
  color: hsl(var(--muted-foreground));
  font-size: 0.9rem;
}
.row-icon {
  display: grid;
  place-items: center;
  color: hsl(var(--muted-foreground));
}
.empty {
  color: hsl(var(--muted-foreground));
}

.lesson-page {
  display: grid;
  gap: 16px;
}
.lesson-hero {
  display: grid;
  gap: 20px;
}
.lesson-hero-top {
  display: flex;
}
.back-link {
  width: fit-content;
}
.lesson-hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 360px);
  gap: 24px;
  align-items: end;
}
.lesson-hero h1 {
  font-size: 3.2rem;
}
.hero-badges {
  justify-content: flex-end;
  margin-top: 0;
}
.command-bar {
  position: sticky;
  top: 12px;
  z-index: 20;
  display: flex;
  gap: 8px;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  background: hsl(var(--card) / 0.92);
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(16px);
  padding: 8px;
}
.tool-button {
  min-width: 92px;
}
.done-toggle {
  cursor: pointer;
}
.done-toggle input {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  overflow: hidden;
}
.done-toggle:has(input:checked) {
  border-color: hsl(var(--accent) / 0.42);
  background: hsl(142 76% 94%);
  color: hsl(var(--accent-foreground));
}
.lesson-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 16px;
  align-items: start;
}
.reader-card {
  padding: 30px;
}
.side-stack {
  position: sticky;
  top: 80px;
  display: grid;
  gap: 12px;
}
.vocab-card, .grammar-card, .prosody-card {
  padding: 16px;
}

.sentence {
  display: grid;
  grid-template-columns: 42px 34px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  margin: 0;
  padding: 17px 0;
  border-bottom: 1px solid hsl(var(--border));
}
.sentence:last-child { border-bottom: 0; }
.sentence-play {
  display: inline-grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  background: hsl(var(--card));
  color: hsl(var(--primary));
  transition: background var(--transition), border-color var(--transition), color var(--transition);
}
.sentence-play:hover {
  border-color: hsl(var(--primary) / 0.32);
  background: hsl(var(--secondary));
}
.num {
  color: hsl(var(--primary));
  font-weight: 850;
  line-height: 40px;
}
.sentence-text {
  min-width: 0;
  display: grid;
  gap: 7px;
}
.en {
  color: hsl(var(--foreground));
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.18rem;
  line-height: 1.82;
  overflow-wrap: anywhere;
}
.zh {
  color: hsl(var(--muted-foreground));
  font-size: 0.96rem;
  line-height: 1.7;
}
body.hide-zh .zh { display: none; }
.follow-cue {
  display: grid;
  gap: 5px;
  border: 1px solid hsl(var(--primary) / 0.16);
  border-left: 4px solid hsl(var(--primary));
  border-radius: var(--radius);
  background: hsl(var(--secondary));
  padding: 10px 12px;
  color: hsl(var(--secondary-foreground));
  font-size: 0.9rem;
  line-height: 1.55;
}
body.hide-follow .follow-cue { display: none; }
.follow-tag {
  color: hsl(var(--primary));
  font-size: 0.72rem;
  font-weight: 850;
  line-height: 1;
  text-transform: uppercase;
}
.cue-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 7px;
  align-items: baseline;
}
.cue-group {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 3px;
  align-items: baseline;
  min-width: 0;
}
.cue-word {
  overflow-wrap: anywhere;
}
.cue-word.stress {
  color: hsl(var(--foreground));
  font-weight: 850;
}
.cue-word.weak {
  color: hsl(var(--muted-foreground));
  font-weight: 650;
}
.tone {
  color: hsl(var(--primary));
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-weight: 850;
  margin-left: 2px;
}
.pause {
  color: var(--target);
  font-weight: 850;
  padding: 0 2px;
}
.target {
  border-radius: 5px;
  background: var(--target-bg);
  color: var(--target);
  cursor: pointer;
  font-weight: 850;
  padding: 0.04rem 0.18rem;
}
body.practice .target {
  color: transparent;
  text-shadow: none;
  border-bottom: 2px solid var(--target);
  background: transparent;
}
body.practice .target.revealed {
  color: var(--target);
  border-bottom-color: transparent;
  background: var(--target-bg);
}

.word-list {
  list-style: none;
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
}
.word-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 8px;
  align-items: center;
  border-bottom: 1px solid hsl(var(--border));
  padding: 0 0 10px;
}
.word-list li:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}
.word-button {
  min-width: 0;
  border: 0;
  background: transparent;
  color: hsl(var(--foreground));
  cursor: pointer;
  overflow-wrap: anywhere;
  padding: 3px 0;
  text-align: left;
  font-weight: 850;
}
.word-button:hover { color: var(--target); }
.pos {
  text-transform: lowercase;
}
.refs {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.refs-label {
  color: hsl(var(--muted-foreground));
  font-size: 0.76rem;
  font-weight: 750;
}
.word-zh {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  color: hsl(var(--muted-foreground));
  font-size: 0.86rem;
  line-height: 1.48;
}
.word-zh-label {
  color: hsl(var(--primary));
  font-size: 0.74rem;
  font-weight: 850;
  white-space: nowrap;
}
.word-zh.missing {
  color: hsl(var(--muted-foreground));
}
.ref {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border-radius: 999px;
  background: hsl(var(--secondary));
  color: hsl(var(--primary));
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.76rem;
  font-weight: 750;
  padding: 0 7px;
  text-decoration: none;
}
.ref:hover { text-decoration: underline; }
.grammar-title {
  margin: 0 0 4px;
  font-weight: 850;
}
.grammar-desc {
  margin: 0 0 10px;
  color: hsl(var(--muted-foreground));
}
.grammar-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding-left: 18px;
}
.grammar-list code, .markdown-card code {
  border: 1px solid hsl(var(--border));
  border-radius: 5px;
  background: hsl(var(--muted));
  padding: 0.08rem 0.25rem;
}
.grammar-list .note {
  display: block;
  color: hsl(var(--muted-foreground));
  font-size: 0.92rem;
}
.prosody-card {
  background: hsl(142 76% 96%);
}
.prosody-legend {
  display: grid;
  gap: 7px;
  color: hsl(var(--muted-foreground));
  font-size: 0.86rem;
  line-height: 1.45;
}
.prosody-legend strong, .prosody-legend b {
  color: hsl(var(--foreground));
  font-weight: 850;
}

.mistakes-page {
  max-width: 900px;
}
.page-hero.compact {
  display: grid;
  gap: 12px;
}
.markdown-card {
  padding: 30px;
}
.markdown-card h2, .markdown-card h3, .markdown-card h4 {
  margin: 1.25rem 0 0.5rem;
}
.markdown-card h2:first-child { margin-top: 0; }
.markdown-card p { margin: 0.7rem 0; }
.markdown-card blockquote {
  margin: 0.9rem 0;
  border-left: 4px solid hsl(var(--primary));
  color: hsl(var(--muted-foreground));
  padding-left: 12px;
}
.markdown-card a {
  color: hsl(var(--primary));
  font-weight: 750;
}

:where(a, button, label, [tabindex]):focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}

@media (max-width: 1120px) {
  .app-shell {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .lesson-grid {
    grid-template-columns: 1fr;
  }
  .side-stack {
    position: static;
  }
  .vocab-card .word-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .vocab-card .word-list li {
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    padding: 10px;
  }
}

@media (max-width: 820px) {
  .app-shell {
    display: block;
  }
  .app-main {
    padding-bottom: 88px;
  }
  .sh-sidebar {
    position: fixed;
    inset: auto 10px 10px;
    height: 64px;
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 8px;
    border: 1px solid hsl(var(--border));
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
    padding: 6px;
  }
  .brand {
    width: 52px;
    padding: 0;
    justify-content: center;
  }
  .brand-mark {
    width: 38px;
    height: 38px;
  }
  .brand-copy, .sidebar-meta {
    display: none;
  }
  .sidebar-nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .nav-item {
    justify-content: center;
    min-height: 48px;
    font-size: 0.84rem;
  }
  .page-shell {
    width: min(100% - 20px, 720px);
    padding: 12px 0 20px;
  }
  .home-hero, .lesson-hero, .page-hero {
    padding: 22px;
  }
  .home-hero {
    grid-template-columns: 1fr;
    min-height: 0;
  }
  .hero-actions {
    grid-template-columns: 1fr;
  }
  .stats-grid {
    grid-template-columns: 1fr;
  }
  .lesson-row {
    grid-template-columns: minmax(0, 1fr) 40px;
  }
  .lesson-date {
    grid-column: 1 / -1;
  }
  .row-icon {
    grid-column: 2;
    grid-row: 2;
  }
  .lesson-hero-grid {
    grid-template-columns: 1fr;
  }
  .hero-badges {
    justify-content: flex-start;
  }
  .command-bar {
    top: 0;
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    overflow: visible;
  }
  .tool-button, .done-toggle {
    min-width: 0;
    min-height: 56px;
    flex-direction: column;
    gap: 5px;
    padding: 6px 4px;
    font-size: 0.78rem;
  }
  .reader-card {
    padding: 18px;
  }
  .sentence {
    grid-template-columns: 42px minmax(0, 1fr);
  }
  .sentence-play {
    grid-row: span 2;
  }
  .num {
    grid-column: 2;
    line-height: 1.2;
  }
  .sentence-text {
    grid-column: 2;
  }
  .en {
    font-size: 1.08rem;
  }
  .vocab-card .word-list {
    grid-template-columns: 1fr;
  }
  h1 {
    font-size: 2.4rem;
    line-height: 1;
  }
  .lesson-hero h1 {
    font-size: 2.24rem;
  }
}

@media (max-width: 480px) {
  .home-hero, .lesson-hero, .page-hero {
    padding: 18px;
  }
  h1 {
    font-size: 2rem;
  }
  .lesson-hero h1 {
    font-size: 1.95rem;
  }
  .word-zh {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}

@media print {
  .sh-sidebar, .command-bar, .sentence-play, .back-link {
    display: none !important;
  }
  body { background: white; }
  .app-shell, .lesson-grid {
    display: block;
  }
  .page-shell {
    width: auto;
    padding: 0;
  }
  .sh-card {
    border: 0;
    box-shadow: none;
  }
}
`

const SITE_JS = `(() => {
  const storage = {
    get(key) {
      try { return window.localStorage.getItem(key) } catch { return null }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value) } catch {}
    },
  }

  const audioCache = new Map()
  let currentAudio = null
  let stopCurrent = null
  let playbackToken = 0

  function cancelPlayback() {
    playbackToken += 1
    if (currentAudio) {
      currentAudio.pause()
      try { currentAudio.currentTime = 0 } catch {}
    }
    if (stopCurrent) stopCurrent()
    stopCurrent = null
    currentAudio = null
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }

  function getAudio(src) {
    if (audioCache.has(src)) return audioCache.get(src)
    const audio = new Audio(src)
    audio.preload = 'auto'
    audioCache.set(src, audio)
    return audio
  }

  function browserSpeak(text, token) {
    return new Promise((resolve) => {
      if (!text || token !== playbackToken || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
        resolve()
        return
      }
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'en-US'
      utterance.rate = 0.9
      utterance.onend = () => resolve()
      utterance.onerror = () => resolve()
      window.speechSynthesis.speak(utterance)
    })
  }

  function playOne(text, src, token) {
    if (!text || token !== playbackToken) return Promise.resolve()
    if (!src) return browserSpeak(text, token)

    return new Promise((resolve) => {
      const audio = getAudio(src)
      let settled = false

      function clear() {
        audio.onended = null
        audio.onerror = null
        if (currentAudio === audio) currentAudio = null
        if (stopCurrent === finish) stopCurrent = null
      }

      function finish() {
        if (settled) return
        settled = true
        clear()
        resolve()
      }

      function fallback() {
        if (settled) return
        clear()
        browserSpeak(text, token).then(finish)
      }

      currentAudio = audio
      stopCurrent = finish
      audio.onended = finish
      audio.onerror = fallback
      try { audio.currentTime = 0 } catch {}
      audio.play().catch(fallback)
    })
  }

  function speak(text, src) {
    if (!text) return
    cancelPlayback()
    const token = playbackToken
    void playOne(text, src, token)
  }

  function playSequence(items) {
    cancelPlayback()
    const token = playbackToken
    void (async () => {
      for (const item of items) {
        if (token !== playbackToken) return
        await playOne(item.text, item.audio, token)
      }
    })()
  }

  function setPressed(action, pressed) {
    document.querySelectorAll('[data-action="' + action + '"]').forEach((button) => {
      button.setAttribute('aria-pressed', String(pressed))
    })
  }

  function syncControls() {
    setPressed('toggle-zh', !document.body.classList.contains('hide-zh'))
    setPressed('toggle-follow', !document.body.classList.contains('hide-follow'))
    setPressed('toggle-practice', document.body.classList.contains('practice'))
  }

  const date = document.body.dataset.date
  const doneInput = document.querySelector('[data-action="mark-done"]')

  if (storage.get('ieltsy:show-zh') === '0') document.body.classList.add('hide-zh')
  if (storage.get('ieltsy:show-follow') === '0') document.body.classList.add('hide-follow')
  if (storage.get('ieltsy:practice') === '1') document.body.classList.add('practice')
  if (date && doneInput instanceof HTMLInputElement) {
    doneInput.checked = storage.get('ieltsy:done:' + date) === '1'
  }
  syncControls()

  document.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const speakable = target.closest('[data-speak]')
    if (speakable) {
      if (document.body.classList.contains('practice') && speakable.classList.contains('target')) {
        speakable.classList.add('revealed')
      }
      speak(speakable.getAttribute('data-speak') || speakable.textContent || '', speakable.getAttribute('data-audio'))
      event.stopPropagation()
      return
    }

    const action = target.closest('[data-action]')
    const actionName = action?.getAttribute('data-action')

    if (actionName === 'play-all') {
      const items = Array.from(document.querySelectorAll('.sentence')).map((node) => ({
        text: node.getAttribute('data-text') || '',
        audio: node.getAttribute('data-audio'),
      })).filter((item) => item.text)
      playSequence(items)
      return
    }

    if (actionName === 'play-sentence') {
      const sentence = action?.closest('.sentence')
      speak(sentence?.getAttribute('data-text') || '', sentence?.getAttribute('data-audio'))
      return
    }

    if (actionName === 'toggle-zh') {
      document.body.classList.toggle('hide-zh')
      storage.set('ieltsy:show-zh', document.body.classList.contains('hide-zh') ? '0' : '1')
      syncControls()
      return
    }

    if (actionName === 'toggle-follow') {
      document.body.classList.toggle('hide-follow')
      storage.set('ieltsy:show-follow', document.body.classList.contains('hide-follow') ? '0' : '1')
      syncControls()
      return
    }

    if (actionName === 'toggle-practice') {
      document.body.classList.toggle('practice')
      document.querySelectorAll('.target.revealed').forEach((node) => node.classList.remove('revealed'))
      storage.set('ieltsy:practice', document.body.classList.contains('practice') ? '1' : '0')
      syncControls()
      return
    }

    const sentence = target.closest('.sentence')
    if (sentence && !target.closest('a, button, input')) {
      speak(sentence.getAttribute('data-text') || '', sentence.getAttribute('data-audio'))
    }
  })

  document.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    if (target.getAttribute('data-action') === 'mark-done' && date) {
      storage.set('ieltsy:done:' + date, target.checked ? '1' : '0')
    }
  })

  document.addEventListener('keydown', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (!target.classList.contains('target')) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
})()
`

function main(): void {
  const articles = discoverArticles()
  reportDefinitionCoverage(articles)
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(join(OUT_DIR, 'assets'), { recursive: true })
  prepareAudioAssets(articles)

  writePage(join(OUT_DIR, '.nojekyll'), '')
  writePage(join(OUT_DIR, 'assets/site.css'), SITE_CSS)
  writePage(join(OUT_DIR, 'assets/site.js'), SITE_JS)
  writePage(join(OUT_DIR, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#4f46e5"/>
  <path d="M20 16h18a6 6 0 0 1 6 6v26H24a6 6 0 0 0-6 6V22a6 6 0 0 1 6-6Z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
  <path d="M24 26h14M24 34h12" stroke="#c7d2fe" stroke-width="4" stroke-linecap="round"/>
</svg>
`)
  writePage(join(OUT_DIR, 'manifest.webmanifest'), JSON.stringify({
    name: SITE_TITLE,
    short_name: SITE_TITLE,
    start_url: './',
    display: 'standalone',
    background_color: '#f6f8fb',
    theme_color: '#0f766e',
  }, null, 2))

  writePage(join(OUT_DIR, 'index.html'), renderIndex(articles))
  writePage(join(OUT_DIR, '404.html'), renderNotFound())

  for (const article of articles) {
    writePage(join(OUT_DIR, 'days', article.date, 'index.html'), renderDay(article))
  }

  writePage(join(OUT_DIR, 'mistakes', 'index.html'), renderMistakesIndex())
  for (const kind of ['words', 'grammar'] as const) {
    const file = resolve('learning/mistakes', `${kind}.md`)
    const markdown = existsSync(file) ? readFileSync(file, 'utf-8') : `# ${kind}\n\n_暂无错题。_`
    writePage(join(OUT_DIR, 'mistakes', `${kind}.html`), renderMistakesPage(kind, markdown))
  }

  const latest = articles[0]?.date ?? 'none'
  console.log(`✓ Exported ${articles.length} lessons to ${OUT_DIR}`)
  console.log(`  Latest: ${latest}`)
  console.log(`  Open: ${join(OUT_DIR, 'index.html')}`)
}

main()
