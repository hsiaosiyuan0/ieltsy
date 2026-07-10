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
const DESIGN_PATTERN_CSS_PATH = resolve('design-system/ieltsy/pattern.css')
const DESIGN_RUNTIME_JS_PATH = resolve('design-system/ieltsy/runtime.js')
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

function displayText(value: string): string {
  return value.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
}

function audioAttr(prefix: string, audio?: string): string {
  return audio ? ` data-audio="${prefix}assets/audio/${escapeHtml(audio)}"` : ''
}

function highlightTargets(text: string, targets: TargetWord[], targetAudioByText: Map<string, string>): string {
  const sorted = targets.map((target) => target.word).sort((a, b) => b.length - a.length)
  const alternatives = sorted
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (alternatives.length === 0) return escapeHtml(text)

  const pattern = new RegExp(`\\b(?:${alternatives.join('|')})(?:s|es|ed|d|ing)?\\b`, 'gi')
  return escapeHtml(text).replace(pattern, (actual: string) => {
    const base = sorted.find((word) => {
      const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`^${safe}(?:s|es|ed|d|ing)?$`, 'i').test(actual)
    }) ?? actual
    const spoken = escapeHtml(actual)
    const audio = targetAudioByText.get(actual.toLowerCase()) ?? targetAudioByText.get(base.toLowerCase())
    return `<button class="target" type="button" data-speak="${spoken}"${audio ? ` data-audio="${escapeHtml(audio)}"` : ''} aria-label="朗读词汇 ${spoken}">${spoken}</button>`
  })
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
  return `<span class="cue-group">${words}<span class="cue-tone">${escapeHtml(tone)}</span></span>`
}

function renderFollowCue(text: string, cue?: ProsodyCue): string {
  if (cue?.groups?.length) {
    const renderedCue = cue.groups
      .filter((group) => group.tokens.length > 0)
      .map((group) => renderCueGroup(group.tokens, group.tone || '→'))
      .join('')
    return `<div class="follow-cue" data-prosody-source="${escapeHtml(cue.source)}">${renderedCue}</div>`
  }

  const groups = prosodyGroups(text)
  if (groups.length === 0) return ''
  const finalTone = text.trim().endsWith('?') ? '↗' : '↘'
  const rendered = groups.map((group, index) => {
    const tone = toneForGroup(group, index, groups, finalTone)
    return renderCueGroup(group.tokens, tone)
  }).join('')
  return `<div class="follow-cue" data-prosody-source="fallback">${rendered}</div>`
}

function renderRefs(refs: string): string {
  return refs.split(/\s+/).filter(Boolean).map((tok) => {
    const num = CIRCLED_NUM_TO_INT[tok]
    if (num) return `<a href="#sentence-${num}" class="sentence-ref" data-target="${num}" aria-label="跳到第 ${num} 句">${tok}</a>`
    return `<span class="ref-label">${escapeHtml(tok)}</span>`
  }).join(' ')
}

function renderZhDefinition(word: TargetWord): string {
  const definition = word.zh?.trim()
  if (!definition) {
    return '<p class="vocab-definition definition-missing">未收录中文释义</p>'
  }

  return `<p class="vocab-definition">${escapeHtml(definition)}</p>`
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

function icon(name: 'book' | 'home' | 'archive' | 'arrow-left' | 'arrow-right' | 'play' | 'pause' | 'translate' | 'eye' | 'check' | 'calendar' | 'layers' | 'wave'): string {
  const paths: Record<typeof name, string> = {
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3Z"/><path d="M21 18a1 1 0 0 0 1-1V5a2 2 0 0 0-2-2h-5a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3Z"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
    archive: '<path d="M3 5h18"/><path d="M5 5v14h14V5"/><path d="M9 9h6"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow-right': '<path d="m12 5 7 7-7 7"/><path d="M5 12h14"/>',
    play: '<path d="m8 5 11 7-11 7V5z"/>',
    pause: '<path d="M9 5v14"/><path d="M15 5v14"/>',
    translate: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
    wave: '<path d="M2 12h2"/><path d="M6 9v6"/><path d="M10 5v14"/><path d="M14 8v8"/><path d="M18 10v4"/><path d="M22 12h-2"/>',
  }
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`
}

function issueNumber(value: number): string {
  return String(Math.max(1, value)).padStart(2, '0')
}

function renderShell(opts: {
  title: string
  description: string
  prefix: string
  page: 'home' | 'lesson' | 'mistakes' | 'mistake-detail' | 'not-found'
  current?: 'home' | 'mistakes'
  bodyClass?: string
  date?: string
  body: string
}): string {
  const navHome = opts.current === 'home' ? ' aria-current="page"' : ''
  const navMistakes = opts.current === 'mistakes' ? ' aria-current="page"' : ''
  const homeHref = opts.prefix || './'
  const bodyClass = opts.bodyClass ? ` class="${escapeHtml(opts.bodyClass)}"` : ''
  const dateAttr = opts.date ? ` data-date="${escapeHtml(opts.date)}"` : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHtml(opts.description)}">
  <meta name="theme-color" content="#c74632">
  <title>${escapeHtml(opts.title)} · ${escapeHtml(SITE_TITLE)}</title>
  <link rel="icon" href="${opts.prefix}favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${opts.prefix}assets/site.css">
  <link rel="manifest" href="${opts.prefix}manifest.webmanifest">
</head>
<body${bodyClass} data-page="${opts.page}"${dateAttr}>
  <a class="skip-link" href="#content">跳到正文</a>
  <div class="site-shell">
    <header class="masthead">
      <a class="brand" href="${homeHref}" aria-label="IELTSY 首页">
        <span class="brand__mark">${icon('book')}</span>
        <span class="brand__copy"><strong>IELTSY</strong><small>READING SYSTEM · BAND 7</small></span>
      </a>
      <nav class="masthead__nav" aria-label="主导航">
        <a class="nav-tab" href="${homeHref}"${navHome}><span class="nav-tab__index">01</span><span>学习日</span></a>
        <a class="nav-tab" href="${opts.prefix}mistakes/"${navMistakes}><span class="nav-tab__index">02</span><span>错题本</span></a>
      </nav>
      <div class="masthead__status"><span class="status-dot" aria-hidden="true"></span><span>Local archive</span></div>
    </header>
${opts.body}
    <footer class="site-footer">
      <span><strong>IELTSY</strong> · Local-first IELTS study loop</span>
      <span>READ · RECALL · REVIEW</span>
    </footer>
  </div>
  <span class="sr-only" aria-live="polite" data-reader-status></span>
  <script src="${opts.prefix}assets/site.js" defer></script>
</body>
</html>
`
}

function renderIndex(articles: ParsedArticle[]): string {
  const latest = articles[0]
  const totalWords = articles.reduce((sum, article) => sum + article.targetWords.length, 0)
  const latestTitle = latest ? articleDisplayTitle(latest) : '今天还没有学习短文'
  const latestHref = latest ? `days/${latest.date}/` : ''
  const latestIssue = issueNumber(articles.length)
  const lessonItems = articles.map((article, index) => {
    const title = articleDisplayTitle(article)
    const number = issueNumber(articles.length - index)
    return `        <a class="archive-entry" href="days/${article.date}/">
          <time class="archive-entry__date" datetime="${escapeHtml(article.date)}">${escapeHtml(article.date)}<span>${escapeHtml(article.genre)}</span></time>
          <div class="archive-entry__main">
            <span class="archive-entry__number">LESSON ${number}</span>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(article.grammarTitle || '语法点待补充')}</p>
          </div>
          <span class="archive-entry__count"><strong>${article.targetWords.length}</strong>targets</span>
          <span class="archive-entry__arrow">${icon('arrow-right')}</span>
        </a>`
  }).join('\n')

  const latestActions = latest
    ? `          <div class="home-lead__actions">
            <a class="button button--primary" href="${latestHref}">${icon('play')}<span>继续学习</span></a>
            <a class="button" href="mistakes/">${icon('archive')}<span>查看错题</span></a>
          </div>`
    : ''

  const latestDeck = latest
    ? escapeHtml('本课聚焦 ' + (latest.grammarTitle || '核心语法') + (latest.grammarDescription ? '：' + displayText(latest.grammarDescription) : '') + '，在完整语境中复习目标词。')
    : '运行每日学习流程后，最新短文会出现在这里。'

  const body = `
    <main id="content" class="page page--home">
      <section class="home-lead" aria-labelledby="latest-lesson-title">
        <div class="home-lead__story">
          <p class="kicker">Latest lesson</p>
          <h1 id="latest-lesson-title">${escapeHtml(latestTitle)}</h1>
          <p class="home-lead__deck">${latestDeck}</p>
          <div class="home-lead__meta">
            <span class="meta-chip">${icon('calendar')}${escapeHtml(latest?.date ?? '尚未开始')}</span>
            <span class="meta-chip">${icon('layers')}${escapeHtml(latest?.genre ?? 'lesson')}</span>
            <span class="meta-chip">${latest?.sentences.length ?? 0} sentences</span>
          </div>
${latestActions}
        </div>

        <aside class="lesson-brief" aria-label="最新课程摘要">
          <div>
            <div class="lesson-brief__folio"><span>Current issue</span><strong>${latestIssue}</strong></div>
            <dl>
              <div><dt>发布日期</dt><dd>${escapeHtml(latest?.date ?? '—')}</dd></div>
              <div><dt>文章体裁</dt><dd>${escapeHtml((latest?.genre ?? '—').toUpperCase())}</dd></div>
              <div><dt>目标词</dt><dd>${latest?.targetWords.length ?? 0}</dd></div>
              <div><dt>句子</dt><dd>${latest?.sentences.length ?? 0}</dd></div>
            </dl>
          </div>
          <div class="lesson-brief__note">
            <span>Grammar focus</span>
            <p>${escapeHtml(latest?.grammarTitle || '等待下一课')}${latest?.grammarDescription ? ' · ' + escapeHtml(displayText(latest.grammarDescription)) : ''}</p>
          </div>
        </aside>
      </section>

      <section class="archive-section" aria-labelledby="archive-title">
        <header class="archive-overview">
          <p class="kicker">Study archive</p>
          <h2 id="archive-title">学习课程账簿</h2>
          <p>按学习日期倒序排列，每一课都保留原文、目标词、语法和跟读标记。</p>
          <div class="archive-metrics" aria-label="学习统计">
            <div class="archive-metric"><strong>${articles.length}</strong><span>Lessons</span></div>
            <div class="archive-metric"><strong>${totalWords}</strong><span>Target words</span></div>
          </div>
        </header>
        <div class="archive-ledger">
${lessonItems || '          <p class="archive-empty">还没有可发布的 article.md。</p>'}
        </div>
      </section>
    </main>`

  return renderShell({
    title: '学习日',
    description: 'IELTSY 双语阅读学习档案',
    prefix: '',
    page: 'home',
    current: 'home',
    body,
  })
}

function renderDay(article: ParsedArticle, number: number): string {
  const title = articleDisplayTitle(article)
  const metaParts = article.meta.split('|').map((part) => displayText(part)).filter(Boolean)
  const targetAudioByText = article.targetAudioByText ?? new Map()
  const sentencesHtml = article.sentences.map((sentence) => `        <div class="sentence" id="sentence-${sentence.num}" data-number="${sentence.num}" data-text="${escapeHtml(sentence.text)}"${audioAttr('../../', sentence.audio)}>
          <div class="sentence__gutter">
            <button class="sentence__play" type="button" data-action="play-sentence" aria-label="朗读第 ${sentence.num} 句">${icon('play')}</button>
            <span class="sentence__number">${String(sentence.num).padStart(2, '0')}</span>
          </div>
          <div class="sentence__copy">
            <p class="sentence__english">${highlightTargets(sentence.text, article.targetWords, targetAudioByText)}</p>
            ${renderFollowCue(sentence.text, sentence.prosody)}
            ${sentence.zh ? '<p class="sentence__translation"><span class="translation-label">译</span><span>' + escapeHtml(sentence.zh) + '</span></p>' : ''}
          </div>
        </div>`).join('\n')

  const wordsHtml = article.targetWords.map((word) => `            <li class="vocab-entry">
              <div class="vocab-entry__term">
                <button type="button" class="word-button" data-speak="${escapeHtml(word.word)}"${audioAttr('../../', word.audio)} aria-label="朗读 ${escapeHtml(word.word)}">${escapeHtml(word.word)}</button>
                <span class="word-pos">${escapeHtml(word.pos)}</span>
              </div>
              ${renderZhDefinition(word)}
              <div class="vocab-entry__refs"><span class="vocab-entry__refs-label">句子</span>${renderRefs(word.refs)}</div>
            </li>`).join('\n')

  const grammarHtml = article.grammarExamples.map((example) => `            <li class="grammar-example">
              <span class="grammar-example__number">${String(example.sentenceNum).padStart(2, '0')}</span>
              <div><code>${escapeHtml(example.excerpt)}</code>${example.note ? '<p>' + escapeHtml(example.note) + '</p>' : ''}</div>
            </li>`).join('\n')

  const body = `
    <main id="content" class="page page--lesson">
      <header class="lesson-intro">
        <div class="lesson-intro__back"><a class="text-link" href="../../">${icon('arrow-left')}<span>返回学习日</span></a></div>
        <div class="lesson-intro__grid">
          <div class="lesson-folio"><span>Lesson</span><strong>${issueNumber(number)}</strong><span>${escapeHtml(article.genre)}</span></div>
          <div class="lesson-title-block">
            <p class="kicker">${escapeHtml(article.date)} · ${escapeHtml(article.genre)}</p>
            <h1 id="article-title">${escapeHtml(title)}</h1>
            <p class="lesson-title-block__deck">${escapeHtml(article.grammarTitle || '语法点')}${article.grammarDescription ? ' · ' + escapeHtml(displayText(article.grammarDescription)) : ''}</p>
            <div class="lesson-title-block__meta">
              ${metaParts.map((part) => '<span class="meta-chip">' + escapeHtml(part) + '</span>').join('\n              ')}
            </div>
          </div>
        </div>
      </header>

      <nav class="study-toolbar" aria-label="阅读工具">
        <div class="study-toolbar__group">
          <span class="study-toolbar__label">Reader tools</span>
          <button class="button button--primary" type="button" data-action="play-all" aria-pressed="false" aria-label="朗读全文">
            <span class="when-idle">${icon('play')}</span><span class="when-playing">${icon('pause')}</span><span>全文</span>
          </button>
          <button class="button" type="button" data-action="toggle-zh" aria-controls="reading-content" aria-pressed="false" aria-label="显示或隐藏译文" title="译文">${icon('translate')}<span>译文</span></button>
          <button class="button" type="button" data-action="toggle-follow" aria-controls="reading-content" aria-pressed="true" aria-label="显示或隐藏跟读标记" title="跟读">${icon('wave')}<span>跟读</span></button>
          <button class="button" type="button" data-action="toggle-practice" aria-controls="reading-content" aria-pressed="false" aria-label="开启或关闭遮词练习" title="遮词">${icon('eye')}<span>遮词</span></button>
        </div>
        <div class="study-toolbar__group">
          <button class="button" type="button" data-action="mark-done" aria-pressed="false" aria-label="标记本课完成" title="完成">${icon('check')}<span>完成</span></button>
        </div>
      </nav>

      <div class="lesson-layout">
        <article class="reading-sheet" aria-labelledby="article-title">
          <header class="reading-sheet__header"><strong>Reading passage</strong><span>${article.sentences.length} sentences</span></header>
          <div id="reading-content">
${sentencesHtml}
          </div>
          <footer class="reading-sheet__footer"><span>End of passage</span><span>${article.targetWords.length} target words</span></footer>
        </article>

        <aside class="annotation-rail" aria-label="课程注释">
          <div class="annotation-sticky">
            <div class="annotation-tabs" role="tablist" aria-label="注释类型">
              <button class="annotation-tab" id="tab-words" type="button" role="tab" data-tab="words" aria-controls="panel-words" aria-selected="true">词汇</button>
              <button class="annotation-tab" id="tab-grammar" type="button" role="tab" data-tab="grammar" aria-controls="panel-grammar" aria-selected="false" tabindex="-1">语法</button>
              <button class="annotation-tab" id="tab-prosody" type="button" role="tab" data-tab="prosody" aria-controls="panel-prosody" aria-selected="false" tabindex="-1">跟读</button>
            </div>

            <section class="annotation-panel" id="panel-words" role="tabpanel" aria-labelledby="tab-words" data-panel="words">
              <header class="annotation-panel__header"><h2>目标词</h2><span>${article.targetWords.length} WORDS</span></header>
              <ol class="vocab-index">
${wordsHtml}
              </ol>
            </section>

            <section class="annotation-panel" id="panel-grammar" role="tabpanel" aria-labelledby="tab-grammar" data-panel="grammar" hidden>
              <header class="annotation-panel__header"><h2>语法点</h2><span>FOCUS</span></header>
              <div class="grammar-summary">
                <strong>${escapeHtml(article.grammarTitle || '未记录')}</strong>
                ${article.grammarDescription ? '<p>' + escapeHtml(displayText(article.grammarDescription)) + '</p>' : ''}
              </div>
              <ol class="grammar-examples">
${grammarHtml || '                <li class="grammar-example"><span class="grammar-example__number">—</span><div><p>暂无语法例句。</p></div></li>'}
              </ol>
            </section>

            <section class="annotation-panel" id="panel-prosody" role="tabpanel" aria-labelledby="tab-prosody" data-panel="prosody" hidden>
              <header class="annotation-panel__header"><h2>跟读标记</h2><span>RHYTHM</span></header>
              <div class="prosody-guide">
                <div class="prosody-guide__item"><span class="prosody-guide__sample">BOLD</span><p>重读信息词</p></div>
                <div class="prosody-guide__item"><span class="prosody-guide__sample cue-word weak">light</span><p>弱读功能词</p></div>
                <div class="prosody-guide__item"><span class="prosody-guide__sample">/</span><p>意群停顿</p></div>
                <div class="prosody-guide__item"><span class="prosody-guide__sample">↗ ↘</span><p>语调承接与收束</p></div>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </main>`

  return renderShell({
    title,
    description: `${article.date} IELTSY lesson`,
    prefix: '../../',
    page: 'lesson',
    current: 'home',
    bodyClass: 'hide-zh',
    date: article.date,
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
  const label = kind === 'words' ? 'WORD REVIEW' : 'GRAMMAR REVIEW'
  const description = kind === 'words'
    ? '集中回看答错的目标词、原句和作答记录。'
    : '集中回看需要再次确认的语法点和上下文。'
  const body = `
    <main id="content" class="page page--mistake-detail">
      <header class="page-intro">
        <div>
          <a class="text-link" href="./">${icon('arrow-left')}<span>返回错题本</span></a>
          <p class="kicker">${label}</p>
          <h1>${title}</h1>
        </div>
        <p class="page-intro__aside">${description}</p>
      </header>

      <div class="mistake-detail-layout">
        <aside class="mistake-detail__rail">
          <strong>Review file</strong>
          <p>内容由学习记录自动生成，完成下一轮练习后会同步更新。</p>
        </aside>
        <article class="markdown-sheet">
${renderMarkdown(markdown)}
        </article>
      </div>
    </main>`

  return renderShell({
    title,
    description: `${SITE_TITLE} ${title}`,
    prefix: '../',
    page: 'mistake-detail',
    current: 'mistakes',
    body,
  })
}

function renderMistakesIndex(): string {
  const body = `
    <main id="content" class="page page--archive">
      <header class="page-intro">
        <div>
          <p class="kicker">Review archive</p>
          <h1>错题本</h1>
        </div>
        <p class="page-intro__aside">把错误留在语境里复习。词汇和语法分开归档，但都回到原句中确认。</p>
      </header>

      <section class="mistake-directory" aria-label="错题分类">
        <a class="directory-entry" href="words.html">
          <span class="directory-entry__index">01</span>
          <div class="directory-entry__main"><h2>单词错题</h2><p>最近答错、混淆或尚未掌握的目标词。</p></div>
          <span class="directory-entry__arrow">${icon('arrow-right')}</span>
        </a>
        <a class="directory-entry" href="grammar.html">
          <span class="directory-entry__index">02</span>
          <div class="directory-entry__main"><h2>语法错题</h2><p>需要回到句子里重新理解的语法结构。</p></div>
          <span class="directory-entry__arrow">${icon('arrow-right')}</span>
        </a>
      </section>
    </main>`

  return renderShell({
    title: '错题本',
    description: `${SITE_TITLE} mistake archive`,
    prefix: '../',
    page: 'mistakes',
    current: 'mistakes',
    body,
  })
}

function renderNotFound(): string {
  const body = `
    <main id="content" class="page page--not-found">
      <section class="not-found">
        <p class="not-found__code">404</p>
        <div class="not-found__copy">
          <p class="kicker">Page not found</p>
          <h1>这一页不在学习档案里</h1>
          <p>地址可能已经变化，回到课程账簿继续学习。</p>
          <a class="button button--primary" href="./">${icon('home')}<span>返回首页</span></a>
        </div>
      </section>
    </main>`

  return renderShell({
    title: '页面不存在',
    description: `${SITE_TITLE} not found`,
    prefix: '',
    page: 'not-found',
    body,
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

const SITE_CSS = readFileSync(DESIGN_PATTERN_CSS_PATH, 'utf-8')
const SITE_JS = readFileSync(DESIGN_RUNTIME_JS_PATH, 'utf-8')

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
  <rect width="64" height="64" rx="32" fill="#c74632"/>
  <path d="M18 17h21a7 7 0 0 1 7 7v25H24a7 7 0 0 0-7 7V24a7 7 0 0 1 7-7Z" fill="none" stroke="#fffdf8" stroke-width="4" stroke-linejoin="round"/>
  <path d="M24 28h15M24 37h12" stroke="#fffdf8" stroke-width="3" stroke-linecap="round"/>
</svg>
`)
  writePage(join(OUT_DIR, 'manifest.webmanifest'), JSON.stringify({
    name: SITE_TITLE,
    short_name: SITE_TITLE,
    start_url: './',
    display: 'standalone',
    background_color: '#e8ece8',
    theme_color: '#c74632',
  }, null, 2))

  writePage(join(OUT_DIR, 'index.html'), renderIndex(articles))
  writePage(join(OUT_DIR, '404.html'), renderNotFound())

  for (const [index, article] of articles.entries()) {
    writePage(join(OUT_DIR, 'days', article.date, 'index.html'), renderDay(article, articles.length - index))
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
