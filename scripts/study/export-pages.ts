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

function renderFollowCue(text: string): string {
  const groups = prosodyGroups(text)
  if (groups.length === 0) return ''
  const finalTone = text.trim().endsWith('?') ? '↗' : '↘'
  const rendered = groups.map((group, index) => {
    const tone = toneForGroup(group, index, groups, finalTone)
    const words = group.tokens.map((word) => {
      const klass = isStressWord(word) ? 'stress' : 'weak'
      return `<span class="cue-word ${klass}">${escapeHtml(word)}</span>`
    }).join(' ')
    return `<span class="cue-group">${words}<span class="tone">${tone}</span></span>`
  }).join('<span class="pause">/</span>')
  return `<span class="follow-cue"><span class="follow-tag">跟读</span><span class="cue-line">${rendered}</span></span>`
}

function renderRefs(refs: string): string {
  return refs.split(/\s+/).filter(Boolean).map((tok) => {
    const num = CIRCLED_NUM_TO_INT[tok]
    if (num) return `<a href="#sentence-${num}" class="ref">${tok}</a>`
    return `<span class="ref">${escapeHtml(tok)}</span>`
  }).join(' ')
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

function audioCacheKey(text: string): string {
  return createHash('md5').update(`${AUDIO_VOICE}|${AUDIO_RATE}|${text}`).digest('hex').slice(0, 12)
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
  <meta name="theme-color" content="#0f766e">
  <title>${escapeHtml(opts.title)} · ${escapeHtml(SITE_TITLE)}</title>
  <link rel="stylesheet" href="${opts.prefix}assets/site.css">
  <link rel="manifest" href="${opts.prefix}manifest.webmanifest">
</head>
<body${opts.bodyAttrs ? ` ${opts.bodyAttrs}` : ''}>
  <a class="skip-link" href="#content">跳到正文</a>
  <div class="app-frame">
    <aside class="desk-rail" aria-label="应用导航">
      <a class="rail-brand" href="${homeHref}" aria-label="IELTSY 首页">
        <span class="brand-mark">${icon('book')}</span>
        <span class="brand-word">IELTSY</span>
      </a>
      <nav class="rail-nav" aria-label="主导航">
        <a class="rail-link" href="${homeHref}" ${navHome}>${icon('home')}<span>学习日</span></a>
        <a class="rail-link" href="${opts.prefix}mistakes/" ${navMistakes}>${icon('archive')}<span>错题本</span></a>
      </nav>
      <span class="rail-status">Pages</span>
    </aside>
${opts.body}
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
    return `        <a class="timeline-row" href="days/${article.date}/">
          <span class="date-rail">${escapeHtml(article.date)}</span>
          <span class="row-main">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(article.genre)} · ${article.targetWords.length} 词 · ${escapeHtml(article.grammarTitle || '语法点')}</span>
          </span>
          <span class="row-cue">${icon('arrow-right')}</span>
        </a>`
  }).join('\n')

  const body = `    <main id="content" class="desk-surface desk-home">
      <section class="today-panel">
        <div class="today-copy">
          <p class="eyebrow">Current desk</p>
          <h1>${escapeHtml(latestTitle)}</h1>
          <div class="today-meta">
            <span>${icon('calendar')}${escapeHtml(latest?.date ?? '-')}</span>
            <span>${icon('layers')}${escapeHtml(latest?.genre ?? 'lesson')}</span>
            <span>${latest?.targetWords.length ?? 0} 词</span>
          </div>
        </div>
        <div class="today-actions">
          <a class="desk-command primary" href="${latestHref}">${icon('play')}<span>继续学习</span></a>
          <a class="desk-command" href="mistakes/">${icon('archive')}<span>错题本</span></a>
        </div>
      </section>

      <section class="desk-grid">
        <div class="metric-strip" aria-label="学习统计">
          <div><span>${articles.length}</span><small>学习日</small></div>
          <div><span>${totalWords}</span><small>目标词</small></div>
          <div><span>${escapeHtml(latest?.date ?? '-')}</span><small>最近更新</small></div>
        </div>

        <section class="timeline-section">
          <div class="section-head">
            <h2>Learning timeline</h2>
            <p>${escapeHtml(latestTitle)}</p>
          </div>
          <div class="timeline-list">
${lessonItems || '            <p class="empty">还没有可发布的 article.md。</p>'}
          </div>
        </section>
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
              ${renderFollowCue(sentence.text)}
              ${sentence.zh ? `<span class="zh">${escapeHtml(sentence.zh)}</span>` : ''}
            </span>
          </p>`).join('\n')

  const wordsHtml = article.targetWords.map((word) => `            <li>
              <button type="button" class="word-button" data-speak="${escapeHtml(word.word)}"${audioAttr('../../', word.audio)}>${escapeHtml(word.word)}</button>
              <span class="pos">${escapeHtml(word.pos)}</span>
              ${word.zh ? `<span class="word-zh">${escapeHtml(word.zh)}</span>` : '<span class="word-zh missing">未收录中文释义</span>'}
              <span class="refs"><span class="refs-label">出现</span>${renderRefs(word.refs)}</span>
            </li>`).join('\n')

  const grammarHtml = article.grammarExamples.map((example) => `            <li>
              <span class="sent-num">${CIRCLED[example.sentenceNum - 1]}</span>
              <code>${escapeHtml(example.excerpt)}</code>
              ${example.note ? `<span class="note">${escapeHtml(example.note)}</span>` : ''}
            </li>`).join('\n')

  const body = `    <main id="content" class="desk-surface lesson-desk">
    <section class="lesson-cover">
      <a class="back-link" href="../../">${icon('arrow-left')}<span>学习日</span></a>
      <div class="cover-grid">
        <div>
          <p class="eyebrow">${escapeHtml(article.date)} · ${escapeHtml(article.genre)}</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <div class="meta-stack">
          ${metaParts.map((part) => `<span>${escapeHtml(part)}</span>`).join('\n          ')}
        </div>
      </div>
    </section>

    <div class="lesson-workbench">
      <aside class="study-dock" aria-label="学习工具">
        <button class="desk-command primary" type="button" data-action="play-all">${icon('play')}<span>全文</span></button>
        <button class="desk-command" type="button" data-action="toggle-zh" aria-pressed="false">${icon('translate')}<span>译文</span></button>
        <button class="desk-command" type="button" data-action="toggle-follow" aria-pressed="true">${icon('wave')}<span>跟读</span></button>
        <button class="desk-command" type="button" data-action="toggle-practice" aria-pressed="false">${icon('eye')}<span>遮词</span></button>
        <label class="done-toggle">
          <input type="checkbox" data-action="mark-done">
          ${icon('check')}
          <span>完成</span>
        </label>
      </aside>

      <article class="reading-paper" aria-label="短文">
${sentencesHtml}
      </article>

      <aside class="notes-tray" aria-label="目标词和语法点">
        <section class="note-panel prosody-panel">
          <h2>跟读规律</h2>
          <div class="prosody-legend">
            <span><strong>粗体</strong> 重读信息词</span>
            <span><span class="cue-word weak">浅色</span> 弱读功能词</span>
            <span><b>/</b> 意群停顿</span>
            <span><b>↗</b> 话没说完，轻轻托住</span>
            <span><b>↘</b> 句子结束，声音落下</span>
          </div>
        </section>

        <section class="note-panel">
          <h2>目标词</h2>
          <ol class="word-list">
${wordsHtml}
          </ol>
        </section>

        <section class="note-panel">
          <h2>语法点</h2>
          <p class="grammar-title">${escapeHtml(article.grammarTitle || '未记录')}</p>
          ${article.grammarDescription ? `<p class="grammar-desc">${escapeHtml(article.grammarDescription)}</p>` : ''}
          <ul class="grammar-list">
${grammarHtml}
          </ul>
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
  const body = `    <main id="content" class="desk-surface mistakes-desk">
    <section class="lesson-cover compact">
      <a class="back-link" href="../">${icon('arrow-left')}<span>学习日</span></a>
      <p class="eyebrow">Mistakes</p>
      <h1>${title}</h1>
    </section>
    <article class="markdown-paper">
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
  const body = `    <main id="content" class="desk-surface mistakes-desk">
    <section class="lesson-cover compact">
      <a class="back-link" href="../">${icon('arrow-left')}<span>学习日</span></a>
      <p class="eyebrow">Mistakes</p>
      <h1>错题本</h1>
    </section>
    <div class="timeline-list mistakes-list">
      <a class="timeline-row" href="words.html">
        <span class="date-rail">Words</span>
        <span class="row-main"><strong>单词错题</strong><span>最近答错的目标词</span></span>
        <span class="row-cue">${icon('arrow-right')}</span>
      </a>
      <a class="timeline-row" href="grammar.html">
        <span class="date-rail">Grammar</span>
        <span class="row-main"><strong>语法错题</strong><span>需要回看的语法点</span></span>
        <span class="row-cue">${icon('arrow-right')}</span>
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
    body: `    <main id="content" class="desk-surface desk-home">
    <section class="today-panel">
      <p class="eyebrow">404</p>
      <h1>页面不存在</h1>
      <div class="today-actions"><a class="desk-command primary" href="./">${icon('home')}<span>返回首页</span></a></div>
    </section>
  </main>`,
  })
}

function discoverArticles(): ParsedArticle[] {
  const daysDir = resolve('learning/days')
  if (!existsSync(daysDir)) return []

  const glossary = loadStaticGlossary()
  const dbLookup = createDbGlossaryLookup()
  const articles: ParsedArticle[] = []
  try {
    for (const entry of readdirSync(daysDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
      const articlePath = join(daysDir, entry.name, 'article.md')
      if (!existsSync(articlePath)) continue
      const parsed = parseArticleMd(entry.name, readFileSync(articlePath, 'utf-8'))
      enrichTargetWords(parsed.targetWords, glossary, dbLookup)
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
  --desk: #edefe8;
  --surface: #f8f7f1;
  --paper: #fffdf7;
  --ink: #111318;
  --ink-2: #3f4652;
  --ink-3: #767d86;
  --line: #d4d8ce;
  --line-2: #9fa79c;
  --accent: #0f766e;
  --accent-2: #0b4f4a;
  --study: #4338ca;
  --target: #a45c00;
  --target-bg: #ffe8a3;
  --done: #157f3b;
  --radius: 8px;
  --rail: 72px;
  --transition: 140ms ease-out;
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
  background: var(--desk);
  color: var(--ink);
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
  z-index: 50;
  translate: 0 -160%;
  border: 2px solid var(--accent);
  border-radius: var(--radius);
  background: var(--paper);
  color: var(--accent-2);
  padding: 10px 12px;
  font-weight: 900;
}
.skip-link:focus { translate: 0 0; }

.icon {
  width: 1.05em;
  height: 1.05em;
  flex: 0 0 auto;
}

.app-frame {
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--rail) minmax(0, 1fr);
}
.desk-rail {
  position: sticky;
  top: 0;
  height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 18px;
  border-right: 2px solid var(--ink);
  background: var(--paper);
  padding: 14px 10px;
  z-index: 20;
}
.rail-brand, .rail-link {
  display: grid;
  justify-items: center;
  gap: 6px;
  min-height: 54px;
  border-radius: var(--radius);
  color: var(--ink);
  text-decoration: none;
}
.rail-brand {
  align-content: center;
  font-weight: 950;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 2px solid var(--ink);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--accent-2);
}
.brand-word {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
}
.rail-nav {
  display: grid;
  align-content: start;
  gap: 10px;
}
.rail-link {
  border: 1px solid var(--line);
  background: var(--paper);
  color: var(--ink-2);
  padding: 8px 4px;
  font-size: 0.72rem;
  font-weight: 850;
  transition: background var(--transition), border-color var(--transition), color var(--transition);
}
.rail-link:hover {
  border-color: var(--ink);
  background: var(--surface);
  color: var(--ink);
}
.rail-link[aria-current="page"] {
  border-color: var(--accent);
  background: #e4f3ef;
  color: var(--accent-2);
}
.rail-status {
  justify-self: center;
  writing-mode: vertical-rl;
  color: var(--ink-3);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.desk-surface {
  min-width: 0;
  width: min(1240px, calc(100% - 32px));
  margin: 0 auto;
  padding: clamp(18px, 3vw, 34px) 0 64px;
}

.today-panel {
  min-width: 0;
  max-width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, auto);
  gap: 18px;
  align-items: end;
  min-height: min(44vh, 420px);
  border: 2px solid var(--ink);
  border-radius: var(--radius);
  background: var(--surface);
  padding: clamp(18px, 4vw, 42px);
  position: relative;
}
.today-panel::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 12px;
  background: var(--accent);
  border-radius: 6px 0 0 6px;
}
.today-copy {
  min-width: 0;
  max-width: 100%;
}
.eyebrow {
  margin: 0 0 12px;
  color: var(--accent-2);
  font-size: 0.78rem;
  font-weight: 950;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  color: var(--ink);
  font-size: clamp(2.25rem, 6.5vw, 5.8rem);
  line-height: 0.92;
  letter-spacing: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.today-meta {
  min-width: 0;
  max-width: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}
.today-meta span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  background: var(--paper);
  color: var(--ink-2);
  padding: 0 11px;
  font-size: 0.88rem;
  font-weight: 850;
}
.today-actions {
  display: grid;
  gap: 10px;
}

.desk-command, .done-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  min-height: 44px;
  border: 2px solid var(--ink);
  border-radius: var(--radius);
  background: var(--paper);
  color: var(--ink);
  padding: 0 13px;
  font-weight: 900;
  line-height: 1;
  text-decoration: none;
  transition: background var(--transition), border-color var(--transition), color var(--transition);
}
.desk-command:hover, .done-toggle:hover {
  background: var(--surface);
}
.desk-command.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: white;
}
.desk-command[aria-pressed="true"] {
  border-color: var(--accent);
  background: #e4f3ef;
  color: var(--accent-2);
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
  border-color: var(--done);
  background: #eaf7ee;
  color: var(--done);
}

.desk-grid {
  min-width: 0;
  max-width: 100%;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 16px;
  margin-top: 16px;
}
.metric-strip {
  min-width: 0;
  max-width: 100%;
  display: grid;
  gap: 10px;
}
.metric-strip div {
  min-height: 118px;
  border: 2px solid var(--ink);
  border-radius: var(--radius);
  background: var(--paper);
  padding: 14px;
}
.metric-strip span {
  display: block;
  font-size: clamp(1.8rem, 4vw, 3.2rem);
  font-weight: 950;
  line-height: 1;
}
.metric-strip small {
  display: block;
  margin-top: 8px;
  color: var(--ink-3);
  font-size: 0.8rem;
  font-weight: 900;
}
.timeline-section {
  min-width: 0;
  max-width: 100%;
  border: 2px solid var(--ink);
  border-radius: var(--radius);
  background: var(--paper);
  padding: 14px;
}
.section-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  align-items: end;
  margin: 0 0 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.section-head h2 {
  margin: 0;
  font-size: 1rem;
}
.section-head p {
  margin: 0;
  color: var(--ink-3);
  overflow-wrap: anywhere;
}
.timeline-list {
  min-width: 0;
  max-width: 100%;
  display: grid;
  gap: 8px;
}
.timeline-row {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr) 44px;
  gap: 12px;
  align-items: center;
  min-height: 76px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 10px 12px;
  text-decoration: none;
  cursor: pointer;
  transition: background var(--transition), border-color var(--transition);
}
.timeline-row:hover {
  border-color: var(--ink);
  background: var(--paper);
}
.date-rail {
  color: var(--accent-2);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.86rem;
  font-weight: 950;
}
.row-main {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.row-main strong {
  color: var(--ink);
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.row-main span {
  color: var(--ink-3);
  font-size: 0.9rem;
}
.row-cue {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  color: var(--ink-2);
}
.empty {
  color: var(--ink-3);
}

.lesson-cover {
  min-width: 0;
  max-width: 100%;
  display: grid;
  gap: 14px;
  border: 2px solid var(--ink);
  border-radius: var(--radius);
  background: var(--surface);
  padding: clamp(16px, 3vw, 28px);
}
.lesson-cover.compact {
  max-width: 860px;
}
.cover-grid {
  min-width: 0;
  max-width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 340px);
  gap: 20px;
  align-items: end;
}
.lesson-cover h1 {
  font-size: clamp(2rem, 4.8vw, 4.6rem);
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  width: fit-content;
  color: var(--ink-2);
  font-weight: 900;
  text-decoration: none;
}
.back-link:hover {
  color: var(--accent-2);
}
.meta-stack {
  display: grid;
  gap: 8px;
}
.meta-stack span {
  border-left: 5px solid var(--accent);
  background: var(--paper);
  color: var(--ink-2);
  padding: 8px 10px;
  font-size: 0.9rem;
  font-weight: 850;
}

.lesson-workbench {
  min-width: 0;
  max-width: 100%;
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) 340px;
  gap: 16px;
  align-items: start;
  margin-top: 16px;
}
.study-dock {
  position: sticky;
  top: 16px;
  display: grid;
  gap: 10px;
}
.study-dock .desk-command, .study-dock .done-toggle {
  min-height: 64px;
  flex-direction: column;
  padding: 8px 4px;
  font-size: 0.78rem;
}
.reading-paper, .note-panel, .markdown-paper {
  min-width: 0;
  border: 2px solid var(--ink);
  border-radius: var(--radius);
  background: var(--paper);
}
.reading-paper {
  padding: clamp(14px, 3vw, 30px);
}
.sentence {
  display: grid;
  grid-template-columns: 44px 34px minmax(0, 1fr);
  gap: 9px;
  align-items: start;
  margin: 0;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}
.sentence:last-child { border-bottom: 0; }
.sentence-play {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 2px solid var(--line-2);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--accent-2);
  transition: background var(--transition), border-color var(--transition);
}
.sentence-play:hover {
  border-color: var(--accent);
  background: #e4f3ef;
}
.num {
  color: var(--study);
  font-weight: 950;
  line-height: 44px;
}
.sentence-text {
  min-width: 0;
  display: grid;
  gap: 5px;
}
.en {
  color: var(--ink);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.2rem;
  line-height: 1.82;
  overflow-wrap: anywhere;
}
.zh {
  color: var(--ink-2);
  font-size: 0.96rem;
  line-height: 1.7;
}
body.hide-zh .zh { display: none; }
.follow-cue {
  display: grid;
  gap: 5px;
  border-left: 4px solid var(--study);
  border-radius: var(--radius);
  background: #f4f6ec;
  padding: 9px 11px;
  color: var(--ink-2);
  font-size: 0.9rem;
  line-height: 1.55;
}
body.hide-follow .follow-cue { display: none; }
.follow-tag {
  color: var(--accent-2);
  font-size: 0.72rem;
  font-weight: 950;
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
  color: var(--ink);
  font-weight: 950;
}
.cue-word.weak {
  color: var(--ink-3);
  font-weight: 750;
}
.tone {
  color: var(--study);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-weight: 950;
  margin-left: 2px;
}
.pause {
  color: var(--target);
  font-weight: 950;
  padding: 0 2px;
}
.prosody-panel {
  background: #fbfbf5;
}
.prosody-legend {
  display: grid;
  gap: 7px;
  color: var(--ink-2);
  font-size: 0.86rem;
  line-height: 1.45;
}
.prosody-legend strong, .prosody-legend b {
  color: var(--ink);
  font-weight: 950;
}
.target {
  border-radius: 5px;
  background: var(--target-bg);
  color: var(--target);
  cursor: pointer;
  font-weight: 900;
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

.notes-tray {
  min-width: 0;
  max-width: 100%;
  position: sticky;
  top: 16px;
  display: grid;
  gap: 12px;
}
.note-panel {
  padding: 14px;
}
.note-panel h2 {
  margin: 0 0 12px;
  font-size: 1rem;
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
  gap: 4px 8px;
  align-items: center;
  border-bottom: 1px solid var(--line);
  padding: 0 0 8px;
}
.word-list li:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}
.word-button {
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  overflow-wrap: anywhere;
  padding: 5px 0;
  text-align: left;
  font-weight: 900;
}
.word-button:hover { color: var(--target); }
.pos {
  border: 1px solid #c9c8ff;
  border-radius: 999px;
  background: #f0f0ff;
  color: #3730a3;
  padding: 0.08rem 0.42rem;
  font-size: 0.76rem;
  font-weight: 950;
}
.refs {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.refs-label {
  color: var(--ink-3);
  font-size: 0.76rem;
  font-weight: 900;
}
.word-zh {
  grid-column: 1 / -1;
  color: var(--ink-2);
  font-size: 0.86rem;
  line-height: 1.45;
}
.word-zh.missing {
  color: var(--ink-3);
}
.ref {
  color: var(--accent-2);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.78rem;
  font-weight: 950;
  text-decoration: none;
}
.ref:hover { text-decoration: underline; }
.grammar-title {
  margin: 0 0 4px;
  font-weight: 950;
}
.grammar-desc {
  margin: 0 0 10px;
  color: var(--ink-2);
}
.grammar-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding-left: 18px;
}
.grammar-list code, .markdown-paper code {
  border: 1px solid var(--line-2);
  border-radius: 5px;
  background: var(--surface);
  padding: 0.08rem 0.25rem;
}
.grammar-list .note {
  display: block;
  color: var(--ink-2);
  font-size: 0.92rem;
}

.mistakes-desk {
  display: grid;
  gap: 16px;
}
.mistakes-list, .markdown-paper {
  max-width: 860px;
}
.markdown-paper {
  padding: clamp(16px, 3vw, 30px);
}
.markdown-paper h2, .markdown-paper h3, .markdown-paper h4 {
  margin: 1.25rem 0 0.5rem;
}
.markdown-paper h2:first-child { margin-top: 0; }
.markdown-paper p { margin: 0.7rem 0; }
.markdown-paper blockquote {
  margin: 0.9rem 0;
  border-left: 5px solid var(--accent);
  color: var(--ink-2);
  padding-left: 12px;
}
.markdown-paper a {
  color: var(--accent-2);
  font-weight: 900;
}

:where(a, button, label, [tabindex]):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 1120px) {
  .lesson-workbench {
    grid-template-columns: 76px minmax(0, 1fr);
  }
  .notes-tray {
    grid-column: 2;
    position: static;
  }
}

@media (max-width: 820px) {
  .app-frame {
    display: block;
  }
  .desk-rail {
    position: fixed;
    inset: auto 10px 10px;
    height: 64px;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    border: 2px solid var(--ink);
    border-radius: var(--radius);
    padding: 6px;
    box-shadow: 0 10px 30px rgba(17, 19, 24, 0.14);
  }
  .rail-brand {
    min-width: 52px;
    min-height: 48px;
  }
  .brand-mark {
    width: 38px;
    height: 38px;
  }
  .brand-word, .rail-status {
    display: none;
  }
  .rail-nav {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .rail-link {
    min-height: 48px;
    grid-auto-flow: column;
    align-content: center;
    justify-content: center;
    gap: 6px;
    font-size: 0.82rem;
  }
  .desk-surface {
    width: min(100% - 16px, 720px);
    padding: 12px 0 92px;
  }
  .today-panel {
    grid-template-columns: 1fr;
    min-height: 0;
    overflow: hidden;
    padding: 16px 14px 18px 24px;
  }
  .today-actions {
    grid-template-columns: 1fr;
  }
  .desk-grid {
    grid-template-columns: 1fr;
  }
  .metric-strip {
    grid-template-columns: 1fr;
  }
  .metric-strip div {
    min-height: 86px;
  }
  .section-head {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  .timeline-row {
    grid-template-columns: minmax(0, 1fr) 44px;
  }
  .date-rail {
    grid-column: 1 / -1;
  }
  .row-cue {
    grid-column: 2;
    grid-row: 2;
  }
  .cover-grid {
    grid-template-columns: 1fr;
  }
  .lesson-workbench {
    grid-template-columns: 1fr;
  }
  .study-dock {
    position: sticky;
    top: 0;
    z-index: 10;
    grid-template-columns: repeat(5, minmax(56px, 1fr));
    gap: 8px;
    overflow-x: auto;
    background: var(--desk);
    padding: 8px 0;
  }
  .study-dock .desk-command, .study-dock .done-toggle {
    min-height: 56px;
  }
  .reading-paper {
    order: 2;
  }
  .notes-tray {
    order: 3;
    grid-column: auto;
  }
  .sentence {
    grid-template-columns: 44px minmax(0, 1fr);
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
    font-size: 1.1rem;
  }
  h1 {
    font-size: clamp(1.85rem, 8vw, 2.65rem);
    line-height: 1;
  }
}

@media (max-width: 480px) {
  h1 {
    font-size: clamp(1.75rem, 7.6vw, 2.05rem);
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
  .desk-rail, .study-dock, .sentence-play, .back-link {
    display: none !important;
  }
  body { background: white; }
  .app-frame, .lesson-workbench {
    display: block;
  }
  .desk-surface {
    width: auto;
    padding: 0;
  }
  .today-panel, .lesson-cover, .reading-paper, .note-panel, .markdown-paper {
    border: 0;
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
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(join(OUT_DIR, 'assets'), { recursive: true })
  prepareAudioAssets(articles)

  writePage(join(OUT_DIR, '.nojekyll'), '')
  writePage(join(OUT_DIR, 'assets/site.css'), SITE_CSS)
  writePage(join(OUT_DIR, 'assets/site.js'), SITE_JS)
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
