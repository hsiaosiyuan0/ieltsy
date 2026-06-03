import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const CIRCLED_NUM_TO_INT: Record<string, number> = Object.fromEntries(
  CIRCLED.split('').map((c, i) => [c, i + 1])
)

const AUDIO_CACHE_DIR = resolve('learning/audio-cache')
const OUT_PATH = resolve('learning/prosody.json')
const SAMPLE_RATE = 16_000
const FRAME_SIZE = 640
const HOP_SIZE = 160
const MIN_GROUP_SECONDS = 0.32
const AUDIO_VOICE = process.env.IELTSY_AUDIO_VOICE || 'en-US-EmmaMultilingualNeural'
const AUDIO_RATE = process.env.IELTSY_AUDIO_RATE || '+0%'

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

interface Sentence {
  date: string
  num: number
  text: string
}

interface TextGroup {
  tokens: string[]
  boundary: 'soft' | 'comma' | 'major' | 'end'
}

interface RmsFrame {
  start: number
  end: number
  rms: number
}

interface Silence {
  start: number
  end: number
  mid: number
}

interface PitchPoint {
  time: number
  f0: number
  confidence: number
}

interface AnalyzedGroup {
  tokens: string[]
  tone: string
  start: number
  end: number
  pitchStart?: number
  pitchEnd?: number
  confidence: number
}

const { values } = parseArgs({
  options: {
    date: { type: 'string' },
    out: { type: 'string', default: OUT_PATH },
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

function sentenceKey(text: string): string {
  return createHash('md5').update(`${AUDIO_VOICE}|${AUDIO_RATE}|${text}`).digest('hex').slice(0, 12)
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
    if (values.date && entry.name !== values.date) continue
    const articlePath = join(daysDir, entry.name, 'article.md')
    if (!existsSync(articlePath)) continue
    sentences.push(...parseSentences(entry.name, readFileSync(articlePath, 'utf-8')))
  }

  return sentences.sort((a, b) => a.date.localeCompare(b.date) || a.num - b.num)
}

function audioPath(text: string): string {
  return join(AUDIO_CACHE_DIR, `${sentenceKey(text)}.mp3`)
}

function ensureAudio(text: string): string {
  mkdirSync(AUDIO_CACHE_DIR, { recursive: true })
  const path = audioPath(text)
  if (existsSync(path)) return path

  const result = spawnSync(
    'edge-tts',
    ['--voice', AUDIO_VOICE, '--rate', AUDIO_RATE, '--text', text, '--write-media', path],
    { encoding: 'utf-8' }
  )
  if (result.status !== 0) {
    throw new Error(`edge-tts failed for "${text.slice(0, 80)}": ${result.stderr || result.stdout || 'unknown error'}`)
  }
  return path
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
      start: start / SAMPLE_RATE,
      end: (start + frameSize) / SAMPLE_RATE,
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

function speechBounds(frames: RmsFrame[], threshold: number, duration: number): { start: number; end: number } {
  const first = frames.find((frame) => frame.rms > threshold * 1.25)
  const last = [...frames].reverse().find((frame) => frame.rms > threshold * 1.25)
  return {
    start: Math.max(0, first?.start ?? 0),
    end: Math.min(duration, last?.end ?? duration),
  }
}

function detectSilences(frames: RmsFrame[], threshold: number, speechStart: number, speechEnd: number): Silence[] {
  const silences: Silence[] = []
  let runStart: number | null = null
  let runEnd = 0

  function flush(): void {
    if (runStart === null) return
    if (runEnd - runStart >= 0.075 && runEnd > speechStart + 0.06 && runStart < speechEnd - 0.06) {
      silences.push({ start: runStart, end: runEnd, mid: (runStart + runEnd) / 2 })
    }
    runStart = null
  }

  for (const frame of frames) {
    if (frame.rms <= threshold) {
      if (runStart === null) runStart = frame.start
      runEnd = frame.end
    } else {
      flush()
    }
  }
  flush()
  return silences
}

function prosodyGroups(text: string): TextGroup[] {
  const rawGroups: TextGroup[] = []
  let current: string[] = []

  function pushGroup(boundary: TextGroup['boundary']): void {
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

function splitLongProsodyGroup(group: TextGroup): TextGroup[] {
  if (group.tokens.length <= 9) return [group]
  const chunks: TextGroup[] = []
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

function firstWord(group: TextGroup | undefined): string {
  return normalizeSpeechWord(group?.tokens[0] ?? '')
}

function looksComplete(group: TextGroup): boolean {
  const stressCount = group.tokens.filter(isStressWord).length
  const last = group.tokens[group.tokens.length - 1] ?? ''
  return group.tokens.length >= 4 && stressCount >= 2 && isStressWord(last)
}

function fallbackTone(group: TextGroup, index: number, groups: TextGroup[], finalTone: string): string {
  if (index === groups.length - 1 || group.boundary === 'end') return finalTone
  if (group.boundary === 'major') return '↘'
  if (group.boundary === 'comma' && CONTRAST_STARTERS.has(firstWord(groups[index + 1])) && looksComplete(group)) return '↘'
  return '↗'
}

function groupWeight(group: TextGroup): number {
  return group.tokens.reduce((sum, token) => {
    const word = normalizeSpeechWord(token)
    if (!word) return sum
    return sum + Math.max(0.8, word.length * (WEAK_WORDS.has(word) ? 0.55 : 1))
  }, 0)
}

function alignBoundaries(groups: TextGroup[], silences: Silence[], speechStart: number, speechEnd: number): number[] {
  if (groups.length <= 1) return []
  const weights = groups.map(groupWeight)
  const total = weights.reduce((sum, weight) => sum + weight, 0) || groups.length
  const usableSilences = silences.filter((silence) => silence.mid > speechStart + 0.08 && silence.mid < speechEnd - 0.08)
  const boundaries: number[] = []
  let previous = speechStart
  let usedSilenceIndex = -1
  let cumulative = 0

  for (let i = 0; i < groups.length - 1; i += 1) {
    cumulative += weights[i] ?? 1
    const expected = speechStart + ((speechEnd - speechStart) * cumulative) / total
    let chosen: Silence | undefined
    let chosenIndex = -1
    const minBoundary = previous + MIN_GROUP_SECONDS
    const maxBoundary = speechEnd - MIN_GROUP_SECONDS * (groups.length - i - 1)

    for (let j = usedSilenceIndex + 1; j < usableSilences.length; j += 1) {
      const silence = usableSilences[j]!
      if (silence.mid <= minBoundary || silence.mid >= maxBoundary) continue
      const distance = Math.abs(silence.mid - expected)
      if (distance > 0.85) continue
      if (!chosen || distance < Math.abs(chosen.mid - expected)) {
        chosen = silence
        chosenIndex = j
      }
    }

    const boundary = chosen?.mid ?? expected
    boundaries.push(Math.min(maxBoundary, Math.max(minBoundary, boundary)))
    previous = boundaries[boundaries.length - 1]!
    if (chosenIndex >= 0) usedSilenceIndex = chosenIndex
  }

  return boundaries
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
    let lagEnergy = 0
    for (let i = 0; i < FRAME_SIZE - lag; i += 1) {
      const a = windowed[i] ?? 0
      const b = windowed[i + lag] ?? 0
      sum += a * b
      lagEnergy += b * b
    }
    const corr = lagEnergy > 0 ? sum / Math.sqrt(baseEnergy * lagEnergy) : 0
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

function toneFromAudio(
  group: TextGroup,
  index: number,
  groups: TextGroup[],
  start: number,
  end: number,
  pitch: PitchPoint[],
  finalTone: string
): { tone: string; pitchStart?: number; pitchEnd?: number; confidence: number } {
  const fallback = fallbackTone(group, index, groups, finalTone)
  const duration = Math.max(0.05, end - start)
  const points = pitch.filter((point) => point.time >= start + duration * 0.12 && point.time <= end - duration * 0.05)
  if (points.length < 4) return { tone: fallback, confidence: 0.25 }

  const headEnd = start + duration * 0.55
  const tailStart = start + duration * 0.62
  const head = points.filter((point) => point.time <= headEnd).map((point) => point.f0)
  const tail = points.filter((point) => point.time >= tailStart).map((point) => point.f0)
  const pitchStart = median(head)
  const pitchEnd = median(tail)
  if (!pitchStart || !pitchEnd) return { tone: fallback, confidence: 0.25 }

  const diff = pitchEnd - pitchStart
  const threshold = Math.max(9, pitchStart * 0.045)
  const tone = diff > threshold ? '↗' : diff < -threshold ? '↘' : (fallback === '↘' || fallback === '↗' ? fallback : '→')
  const confidence = Math.min(0.98, Math.max(0.35, Math.abs(diff) / (threshold * 2)))
  return {
    tone,
    pitchStart: round(pitchStart, 1),
    pitchEnd: round(pitchEnd, 1),
    confidence: round(confidence, 2),
  }
}

function analyzeSentence(sentence: Sentence): AnalyzedGroup[] {
  const path = ensureAudio(sentence.text)
  const samples = decodeMp3(path)
  const duration = samples.length / SAMPLE_RATE
  const frames = rmsFrames(samples)
  const threshold = silenceThreshold(frames)
  const bounds = speechBounds(frames, threshold, duration)
  const silences = detectSilences(frames, threshold, bounds.start, bounds.end)
  const pitch = pitchTrack(samples, threshold)
  const groups = prosodyGroups(sentence.text)
  const boundaries = alignBoundaries(groups, silences, bounds.start, bounds.end)
  const finalTone = sentence.text.trim().endsWith('?') ? '↗' : '↘'

  return groups.map((group, index) => {
    const start = index === 0 ? bounds.start : boundaries[index - 1] ?? bounds.start
    const end = index === groups.length - 1 ? bounds.end : boundaries[index] ?? bounds.end
    const tone = toneFromAudio(group, index, groups, start, end, pitch, finalTone)
    return {
      tokens: group.tokens,
      tone: tone.tone,
      start: round(start),
      end: round(end),
      pitchStart: tone.pitchStart,
      pitchEnd: tone.pitchEnd,
      confidence: tone.confidence,
    }
  })
}

function main(): void {
  const sentences = discoverSentences()
  const out: {
    version: number
    source: string
    voice: string
    rate: string
    sentences: Record<string, { text: string; date: string; num: number; source: string; groups: AnalyzedGroup[] }>
  } = {
    version: 1,
    source: 'edge-tts-audio-analysis-v1',
    voice: AUDIO_VOICE,
    rate: AUDIO_RATE,
    sentences: {},
  }

  for (const sentence of sentences) {
    const key = sentenceKey(sentence.text)
    const groups = analyzeSentence(sentence)
    out.sentences[key] = {
      text: sentence.text,
      date: sentence.date,
      num: sentence.num,
      source: out.source,
      groups,
    }
    console.log(`${sentence.date} ${CIRCLED[sentence.num - 1]} ${groups.map((group) => `${group.tokens.join(' ')}${group.tone}`).join(' / ')}`)
  }

  writeFileSync(resolve(values.out!), `${JSON.stringify(out, null, 2)}\n`, 'utf-8')
  console.log(`Wrote ${sentences.length} analyzed sentences to ${resolve(values.out!)}`)
}

main()
