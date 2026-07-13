import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  AUDIO_RATE,
  AUDIO_VOICE,
  PROSODY_SCHEMA_VERSION,
  PROSODY_SOURCE,
  sentenceAudioCacheKey,
} from './speech-config'

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const CIRCLED_NUM_TO_INT: Record<string, number> = Object.fromEntries(
  CIRCLED.split('').map((c, i) => [c, i + 1])
)

const AUDIO_CACHE_DIR = resolve('learning/audio-cache')
const OUT_PATH = resolve('learning/prosody.json')
const BOUNDARY_AUDIO_HELPER = resolve('scripts/study/generate-boundary-audio.py')
const SAMPLE_RATE = 16_000
const FRAME_SIZE = 640
const HOP_SIZE = 160
const MIN_AUDIBLE_PAUSE = 0.055
const MIN_PITCH_CONFIDENCE = 0.42
const TONE_THRESHOLD_SEMITONES = 0.9

const WEAK_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'that', 'which', 'who', 'whom', 'whose', 'when', 'where',
  'while', 'unless', 'because', 'as', 'than', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'from', 'with',
  'without', 'into', 'over', 'under', 'across', 'through', 'about', 'around', 'between', 'among', 'is',
  'are', 'am', 'was', 'were', 'be', 'been', 'being', 'will', 'would', 'shall', 'should', 'can', 'could',
  'may', 'might', 'must', 'do', 'does', 'did', 'have', 'has', 'had', 'it', 'its', 'this', 'these', 'those',
  'they', 'them', 'their', 'he', 'him', 'his', 'she', 'her', 'we', 'us', 'our', 'you', 'your', 'i', 'my',
  'not', 'so', 'very', 'also', 'still', 'just',
])
interface Sentence {
  date: string
  num: number
  text: string
}

interface TextGroup {
  tokens: string[]
  starts: number[]
  ends: number[]
  stress: boolean[]
  boundary: 'soft' | 'comma' | 'major' | 'end'
}

interface TextWord {
  text: string
  boundary: TextGroup['boundary'] | 'none'
}

interface WordTiming {
  text: string
  start: number
  end: number
}

interface AlignedWord extends TextWord, WordTiming {}

interface BoundaryFile {
  version: number
  voice: string
  rate: string
  text: string
  words: WordTiming[]
}

interface RmsFrame {
  rms: number
}

interface PitchPoint {
  time: number
  f0: number
  confidence: number
}

interface AnalyzedGroup {
  tokens: string[]
  starts: number[]
  ends: number[]
  stress: boolean[]
  tone: string
  start: number
  end: number
  pitchStart?: number
  pitchEnd?: number
  confidence: number
}

interface ProsodyEntry {
  text: string
  date: string
  num: number
  source: string
  audioHash: string
  groups: AnalyzedGroup[]
}

interface ProsodyFile {
  version: number
  source: string
  voice: string
  rate: string
  sentences: Record<string, ProsodyEntry>
}

const { values } = parseArgs({
  options: {
    date: { type: 'string' },
    out: { type: 'string', default: OUT_PATH },
    force: { type: 'boolean', default: false },
  },
})

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits))
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

function parseSentences(date: string, md: string): Sentence[] {
  const sentences: Sentence[] = []
  let inArticle = false

  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('## 短文')) {
      inArticle = true
      continue
    }
    if (inArticle && line.startsWith('## ')) break

    const match = inArticle ? line.match(/^([①-⑳])\s+(.+)$/) : null
    if (match) {
      sentences.push({
        date,
        num: CIRCLED_NUM_TO_INT[match[1]!]!,
        text: match[2]!.trim(),
      })
    }
  }

  return sentences
}

function discoverSentences(): Sentence[] {
  const daysDir = resolve('learning/days')
  const sentences: Sentence[] = []
  if (!existsSync(daysDir)) return sentences

  for (const entry of readdirSync(daysDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
    const articlePath = join(daysDir, entry.name, 'article.md')
    if (!existsSync(articlePath)) continue
    sentences.push(...parseSentences(entry.name, readFileSync(articlePath, 'utf-8')))
  }

  return sentences.sort((a, b) => a.date.localeCompare(b.date) || a.num - b.num)
}

function audioPath(text: string): string {
  return join(AUDIO_CACHE_DIR, `${sentenceAudioCacheKey(text)}.mp3`)
}

function boundaryPath(text: string): string {
  return join(AUDIO_CACHE_DIR, `${sentenceAudioCacheKey(text)}.words.json`)
}

function readBoundaryFile(path: string, text: string): BoundaryFile | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BoundaryFile
    if (
      parsed.version !== 1
      || parsed.voice !== AUDIO_VOICE
      || parsed.rate !== AUDIO_RATE
      || parsed.text !== text
      || !Array.isArray(parsed.words)
      || parsed.words.length === 0
    ) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function ensureBoundaryAudio(text: string): { path: string; words: WordTiming[] } {
  mkdirSync(AUDIO_CACHE_DIR, { recursive: true })
  const path = audioPath(text)
  const timingsPath = boundaryPath(text)
  const cached = existsSync(path) ? readBoundaryFile(timingsPath, text) : undefined
  if (cached) return { path, words: cached.words }

  if (!existsSync(BOUNDARY_AUDIO_HELPER)) {
    throw new Error(`Word-boundary audio helper is missing: ${BOUNDARY_AUDIO_HELPER}`)
  }

  const result = spawnSync(
    'python3',
    [
      BOUNDARY_AUDIO_HELPER,
      '--voice', AUDIO_VOICE,
      '--rate', AUDIO_RATE,
      '--write-media', path,
      '--write-boundaries', timingsPath,
    ],
    { encoding: 'utf-8', input: text }
  )
  if (result.status !== 0) {
    throw new Error(`Word-boundary TTS failed for "${text.slice(0, 80)}": ${result.stderr || result.stdout || 'unknown error'}`)
  }

  const generated = readBoundaryFile(timingsPath, text)
  if (!existsSync(path) || !generated) {
    throw new Error(`Word-boundary TTS returned incomplete output for "${text.slice(0, 80)}"`)
  }
  return { path, words: generated.words }
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function decodeMp3(path: string): Float32Array {
  const raw = execFileSync('ffmpeg', [
    '-v', 'error',
    '-i', path,
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    '-f', 's16le',
    'pipe:1',
  ], { maxBuffer: 64 * 1024 * 1024 })
  const out = new Float32Array(raw.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = raw.readInt16LE(i * 2) / 32768
  }
  return out
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))
  return sorted[idx] ?? 0
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid]
}

function rmsFrames(samples: Float32Array, frameSize = 320, hopSize = 160): RmsFrame[] {
  const frames: RmsFrame[] = []
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    let sum = 0
    for (let i = 0; i < frameSize; i += 1) {
      const value = samples[start + i] ?? 0
      sum += value * value
    }
    frames.push({
      rms: Math.sqrt(sum / frameSize),
    })
  }
  return frames
}

function silenceThreshold(frames: RmsFrame[]): number {
  const values = frames.map((frame) => frame.rms)
  const max = Math.max(...values, 0)
  return Math.max(0.0025, max * 0.035, percentile(values, 0.18) * 1.8)
}

function compactWord(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function textWords(text: string): TextWord[] {
  const words: TextWord[] = []
  for (const token of splitSpeechWords(text)) {
    if (isPauseToken(token) || isEndToken(token)) {
      const previous = words[words.length - 1]
      if (previous) previous.boundary = isEndToken(token) ? 'end' : token === ',' ? 'comma' : 'major'
      continue
    }
    words.push({ text: token, boundary: 'none' })
  }
  const last = words[words.length - 1]
  if (last && last.boundary === 'none') last.boundary = 'end'
  return words
}

function alignWordTimings(text: string, timings: WordTiming[]): AlignedWord[] {
  const words = textWords(text)
  const aligned: AlignedWord[] = []
  let timingIndex = 0

  for (const word of words) {
    const expected = compactWord(word.text)
    let actual = ''
    let start = 0
    let end = 0

    while (timingIndex < timings.length && actual.length < expected.length) {
      const timing = timings[timingIndex]!
      const piece = compactWord(timing.text)
      const combined = actual + piece
      if (!piece || !expected.startsWith(combined)) break
      if (!actual) start = timing.start
      actual = combined
      end = timing.end
      timingIndex += 1
    }

    if (!expected || actual !== expected) {
      const received = timings.slice(Math.max(0, timingIndex - 1), timingIndex + 2).map((item) => item.text).join(' ')
      throw new Error(`Cannot align Edge TTS word boundaries near "${word.text}" (received: "${received}")`)
    }
    aligned.push({ ...word, start, end })
  }

  const remaining = timings.slice(timingIndex).filter((timing) => compactWord(timing.text))
  if (remaining.length > 0) {
    throw new Error(`Edge TTS returned unmatched words: ${remaining.map((word) => word.text).join(' ')}`)
  }
  return aligned
}

function prosodyGroups(words: AlignedWord[]): TextGroup[] {
  if (words.length === 0) return []
  const gaps = words.slice(0, -1).map((word, index) => Math.max(0, words[index + 1]!.start - word.end))
  const baselineGap = median(gaps) ?? 0
  const pauseThreshold = Math.max(MIN_AUDIBLE_PAUSE, baselineGap + 0.035)
  const punctuationThreshold = Math.max(0.035, baselineGap + 0.02)
  const groups: TextGroup[] = []
  let current: AlignedWord[] = []

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    const next = words[index + 1]
    current.push(word)

    const gap = next ? Math.max(0, next.start - word.end) : 0
    const punctuationPause = word.boundary !== 'none' && word.boundary !== 'end' && gap >= punctuationThreshold
    const audiblePause = Boolean(next) && gap >= pauseThreshold
    if (next && !punctuationPause && !audiblePause) continue

    groups.push({
      tokens: current.map((item) => item.text),
      starts: current.map((item) => round(item.start)),
      ends: current.map((item) => round(item.end)),
      stress: current.map((item) => isStressWord(item.text)),
      boundary: next ? (word.boundary === 'none' || word.boundary === 'end' ? 'soft' : word.boundary) : 'end',
    })
    current = []
  }
  return groups
}

function estimateF0(samples: Float32Array, start: number): { f0: number; confidence: number } | undefined {
  const minLag = Math.floor(SAMPLE_RATE / 360)
  const maxLag = Math.floor(SAMPLE_RATE / 75)
  let mean = 0
  for (let i = 0; i < FRAME_SIZE; i += 1) mean += samples[start + i] ?? 0
  mean /= FRAME_SIZE

  const windowed = new Float32Array(FRAME_SIZE)
  let baseEnergy = 0
  for (let i = 0; i < FRAME_SIZE; i += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1))
    const value = ((samples[start + i] ?? 0) - mean) * hann
    windowed[i] = value
    baseEnergy += value * value
  }
  if (baseEnergy <= 1e-8) return undefined

  let bestLag = 0
  let bestCorr = 0
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0
    let currentEnergy = 0
    let lagEnergy = 0
    for (let i = 0; i < FRAME_SIZE - lag; i += 1) {
      const a = windowed[i] ?? 0
      const b = windowed[i + lag] ?? 0
      sum += a * b
      currentEnergy += a * a
      lagEnergy += b * b
    }
    const corr = currentEnergy > 0 && lagEnergy > 0 ? sum / Math.sqrt(currentEnergy * lagEnergy) : 0
    if (corr > bestCorr) {
      bestCorr = corr
      bestLag = lag
    }
  }

  if (bestCorr < 0.32 || bestLag === 0) return undefined
  return { f0: SAMPLE_RATE / bestLag, confidence: bestCorr }
}

function pitchTrack(samples: Float32Array, threshold: number): PitchPoint[] {
  const points: PitchPoint[] = []
  for (let start = 0; start + FRAME_SIZE <= samples.length; start += HOP_SIZE) {
    let sum = 0
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      const value = samples[start + i] ?? 0
      sum += value * value
    }
    const rms = Math.sqrt(sum / FRAME_SIZE)
    if (rms < threshold * 1.35) continue
    const estimated = estimateF0(samples, start)
    if (!estimated) continue
    points.push({
      time: (start + FRAME_SIZE / 2) / SAMPLE_RATE,
      f0: estimated.f0,
      confidence: estimated.confidence,
    })
  }
  return points
}

function contourPitchPoints(group: TextGroup, pitch: PitchPoint[]): PitchPoint[] {
  const groupStart = group.starts[0] ?? 0
  const groupEnd = group.ends[group.ends.length - 1] ?? groupStart
  let nuclearIndex = group.stress.length - 1
  while (nuclearIndex > 0 && !group.stress[nuclearIndex]) nuclearIndex -= 1

  const select = (start: number): PitchPoint[] => pitch.filter((point) => (
    point.time >= start
    && point.time <= groupEnd
    && point.confidence >= MIN_PITCH_CONFIDENCE
  ))

  const nuclearStart = group.starts[nuclearIndex] ?? groupStart
  const nuclearPoints = select(nuclearStart)
  if (nuclearPoints.length >= 6) return nuclearPoints

  const duration = Math.max(0.05, groupEnd - groupStart)
  const expandedStart = Math.max(groupStart, groupEnd - Math.min(1.1, Math.max(0.5, duration * 0.45)))
  const expandedPoints = select(expandedStart)
  return expandedPoints.length >= 4 ? expandedPoints : select(groupStart)
}

function toneFromAudio(
  group: TextGroup,
  pitch: PitchPoint[]
): { tone: string; pitchStart?: number; pitchEnd?: number; confidence: number } {
  const points = contourPitchPoints(group, pitch)
  if (points.length < 4) return { tone: '→', confidence: 0.2 }

  const bucketSize = Math.max(2, Math.floor(points.length / 3))
  const head = points.slice(0, bucketSize).map((point) => point.f0)
  const tail = points.slice(-bucketSize).map((point) => point.f0)
  const pitchStart = median(head)
  const pitchEnd = median(tail)
  if (!pitchStart || !pitchEnd) return { tone: '→', confidence: 0.2 }

  const semitoneDelta = 12 * Math.log2(pitchEnd / pitchStart)
  const tone = semitoneDelta > TONE_THRESHOLD_SEMITONES
    ? '↗'
    : semitoneDelta < -TONE_THRESHOLD_SEMITONES ? '↘' : '→'
  const trackingConfidence = median(points.map((point) => point.confidence)) ?? 0
  const movementConfidence = Math.min(1, Math.abs(semitoneDelta) / (TONE_THRESHOLD_SEMITONES * 2))
  const confidence = Math.min(0.98, Math.max(0.3, trackingConfidence * (0.55 + movementConfidence * 0.45)))
  return {
    tone,
    pitchStart: round(pitchStart, 1),
    pitchEnd: round(pitchEnd, 1),
    confidence: round(confidence, 2),
  }
}

function analyzeSentence(sentence: Sentence): { audioHash: string; groups: AnalyzedGroup[] } {
  const media = ensureBoundaryAudio(sentence.text)
  const samples = decodeMp3(media.path)
  const frames = rmsFrames(samples)
  const threshold = silenceThreshold(frames)
  const pitch = pitchTrack(samples, threshold)
  const groups = prosodyGroups(alignWordTimings(sentence.text, media.words))

  return {
    audioHash: fileHash(media.path),
    groups: groups.map((group) => {
      const start = group.starts[0] ?? 0
      const end = group.ends[group.ends.length - 1] ?? start
      const tone = toneFromAudio(group, pitch)
      return {
        tokens: group.tokens,
        starts: group.starts,
        ends: group.ends,
        stress: group.stress,
        tone: tone.tone,
        start: round(start),
        end: round(end),
        pitchStart: tone.pitchStart,
        pitchEnd: tone.pitchEnd,
        confidence: tone.confidence,
      }
    }),
  }
}

function loadExisting(path: string): ProsodyFile | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ProsodyFile
    if (
      parsed.version !== PROSODY_SCHEMA_VERSION
      || parsed.source !== PROSODY_SOURCE
      || parsed.voice !== AUDIO_VOICE
      || parsed.rate !== AUDIO_RATE
      || !parsed.sentences
    ) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function reusableEntry(entry: ProsodyEntry | undefined, sentence: Sentence): entry is ProsodyEntry {
  if (
    values.force
    || !entry
    || entry.text !== sentence.text
    || entry.source !== PROSODY_SOURCE
    || !entry.audioHash
    || !entry.groups?.length
  ) return false
  const path = audioPath(sentence.text)
  return existsSync(path) && fileHash(path) === entry.audioHash
}

function main(): void {
  const sentences = discoverSentences()
  const outPath = resolve(values.out!)
  const existing = loadExisting(outPath)
  if (values.date && existsSync(outPath) && !existing) {
    throw new Error('Existing prosody data uses an incompatible schema; run pnpm study:prosody once without --date')
  }

  const out: ProsodyFile = {
    version: PROSODY_SCHEMA_VERSION,
    source: PROSODY_SOURCE,
    voice: AUDIO_VOICE,
    rate: AUDIO_RATE,
    sentences: {},
  }
  let analyzed = 0
  let reused = 0

  for (const sentence of sentences) {
    const key = sentenceAudioCacheKey(sentence.text)
    const previous = existing?.sentences[key]
    const selected = !values.date || sentence.date === values.date
    if (!selected && previous) {
      out.sentences[key] = { ...previous, date: sentence.date, num: sentence.num }
      continue
    }
    if (!selected) continue

    if (reusableEntry(previous, sentence)) {
      out.sentences[key] = { ...previous, date: sentence.date, num: sentence.num }
      reused += 1
      continue
    }

    const analysis = analyzeSentence(sentence)
    out.sentences[key] = {
      text: sentence.text,
      date: sentence.date,
      num: sentence.num,
      source: out.source,
      audioHash: analysis.audioHash,
      groups: analysis.groups,
    }
    analyzed += 1
    console.log(`${sentence.date} ${CIRCLED[sentence.num - 1]} ${analysis.groups.map((group) => `${group.tokens.join(' ')}${group.tone}`).join(' / ')}`)
  }

  if (values.date && !sentences.some((sentence) => sentence.date === values.date)) {
    throw new Error(`No article sentences found for ${values.date}`)
  }

  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf-8')
  console.log(`Wrote ${Object.keys(out.sentences).length} analyzed sentences to ${outPath}`)
  console.log(`  Reused: ${reused} · Analyzed: ${analyzed} · Voice: ${AUDIO_VOICE} ${AUDIO_RATE}`)
}

main()
