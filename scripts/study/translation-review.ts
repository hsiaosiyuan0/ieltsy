import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DAYS_DIR = resolve('learning/days')
const ENGLISH_WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g
const MIN_ENGLISH_COVERAGE = 0.7
const MIN_CHINESE_COVERAGE = 0.65
const MAX_SINGLE_MAPPING_COVERAGE = 0.85
const DEFAULT_MIN_MAPPINGS = 2
const MAX_MAPPINGS = 8
const SHORT_SENTENCE_MAX_WORDS = 3

const ENGLISH_STOP_WORDS = new Set([
  'a', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being',
  'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'each', 'either',
  'every', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'here', 'hers',
  'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'may', 'me',
  'might', 'must', 'my', 'neither', 'no', 'nor', 'not', 'of', 'on', 'only', 'or',
  'our', 'ours', 'shall', 'she', 'should', 'so', 'some', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'under', 'up', 'us', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'why', 'will',
  'with', 'would', 'you', 'your', 'yours',
])

export const TRANSLATION_REVIEW_REQUIRED_SINCE = '2026-07-15'

export interface TranslationMapping {
  english: string
  chinese: string
}

export interface TranslationSentencePair {
  number: string
  english: string
  chinese: string
  mappings: TranslationMapping[]
}

export interface TranslationReview {
  schema_version: 1
  lesson_date: string
  sentence_pairs: TranslationSentencePair[]
}

export interface NumberedSentence {
  number: string
  text: string
}

export interface TranslationReviewResult {
  sentenceCount: number
  minimumEnglishCoverage: number
  minimumChineseCoverage: number
}

interface Span {
  start: number
  end: number
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function findRanges(haystack: string, needle: string, caseInsensitive = false): Span[] {
  const source = caseInsensitive ? haystack.toLocaleLowerCase('en-US') : haystack
  const query = caseInsensitive ? needle.toLocaleLowerCase('en-US') : needle
  const ranges: Span[] = []
  let start = source.indexOf(query)

  while (start >= 0) {
    ranges.push({ start, end: start + query.length })
    start = source.indexOf(query, start + 1)
  }

  return ranges
}

function isInsideAnyRange(start: number, end: number, ranges: Span[]): boolean {
  return ranges.some((range) => start >= range.start && end <= range.end)
}

function measuredEnglishWords(sentence: string): RegExpMatchArray[] {
  const words = [...sentence.matchAll(ENGLISH_WORD)]
  const contentWords = words.filter((word) => !ENGLISH_STOP_WORDS.has(word[0].toLocaleLowerCase('en-US')))
  return contentWords.length > 0 ? contentWords : words
}

function englishCoverage(sentence: string, ranges: Span[]): number {
  const measuredWords = measuredEnglishWords(sentence)
  if (measuredWords.length === 0) return 1

  const covered = measuredWords.filter((word) => {
    const start = word.index ?? 0
    return isInsideAnyRange(start, start + word[0].length, ranges)
  }).length
  return covered / measuredWords.length
}

function meaningfulCharacterPositions(sentence: string): number[] {
  const meaningfulPositions: number[] = []
  for (let index = 0; index < sentence.length; index += 1) {
    if (/[\p{L}\p{N}]/u.test(sentence[index]!)) meaningfulPositions.push(index)
  }
  return meaningfulPositions
}

function chineseCoverage(sentence: string, ranges: Span[]): number {
  const meaningfulPositions = meaningfulCharacterPositions(sentence)
  if (meaningfulPositions.length === 0) return 1

  const covered = meaningfulPositions.filter((index) => isInsideAnyRange(index, index + 1, ranges)).length
  return covered / meaningfulPositions.length
}

function percentage(value: number): string {
  return `${Math.round(value * 100)}%`
}

function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}(?:s|es|ed|d|ing)?\\b`, 'i')
}

export function readTranslationReview(
  date: string,
  required = date >= TRANSLATION_REVIEW_REQUIRED_SINCE
): TranslationReview | null {
  const path = join(DAYS_DIR, date, 'translation-review.json')
  if (!existsSync(path)) {
    assert(!required, `${date}: translation-review.json is required for bilingual alignment`)
    return null
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TranslationReview
  } catch (error) {
    throw new Error(
      `${date}: invalid translation-review.json: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function validateTranslationReview(
  date: string,
  review: TranslationReview,
  englishSentences: NumberedSentence[],
  chineseSentences: NumberedSentence[],
  targetWordsBySentence: Record<string, string[]>
): TranslationReviewResult {
  assert(review && typeof review === 'object', `${date}: translation review must be an object`)
  assert(review.schema_version === 1, `${date}: translation review schema_version must be 1`)
  assert(review.lesson_date === date, `${date}: translation review lesson_date must match directory date`)
  assert(Array.isArray(review.sentence_pairs), `${date}: translation review sentence_pairs must be an array`)
  assert(
    review.sentence_pairs.length === englishSentences.length,
    `${date}: translation review must contain ${englishSentences.length} sentence pairs`
  )

  let minimumEnglishCoverage = 1
  let minimumChineseCoverage = 1

  for (const [index, englishSentence] of englishSentences.entries()) {
    const chineseSentence = chineseSentences[index]!
    const pair = review.sentence_pairs[index]
    assert(pair, `${date}: translation review is missing sentence ${englishSentence.number}`)
    assert(
      pair.number === englishSentence.number && pair.number === chineseSentence.number,
      `${date}: translation review numbering is not aligned at ${englishSentence.number}`
    )
    assert(
      pair.english === englishSentence.text,
      `${date} ${pair.number}: English review snapshot is stale; review the changed sentence again`
    )
    assert(
      pair.chinese === chineseSentence.text,
      `${date} ${pair.number}: Chinese review snapshot is stale; review the changed translation again`
    )
    const sentenceWordCount = (pair.english.match(ENGLISH_WORD) ?? []).length
    const minimumMappings = sentenceWordCount <= SHORT_SENTENCE_MAX_WORDS ? 1 : DEFAULT_MIN_MAPPINGS
    assert(
      Array.isArray(pair.mappings)
        && pair.mappings.length >= minimumMappings
        && pair.mappings.length <= MAX_MAPPINGS,
      `${date} ${pair.number}: translation review needs ${minimumMappings}-${MAX_MAPPINGS} key mappings`
    )

    const seenMappings = new Set<string>()
    const englishRanges: Span[] = []
    const chineseRanges: Span[] = []

    for (const [mappingIndex, mapping] of pair.mappings.entries()) {
      const label = `${date} ${pair.number} mapping ${mappingIndex + 1}`
      assert(mapping && typeof mapping === 'object', `${label}: mapping must be an object`)
      assert(
        typeof mapping.english === 'string' && mapping.english.trim() === mapping.english && mapping.english.length > 0,
        `${label}: English phrase must be non-empty and trimmed`
      )
      assert(
        typeof mapping.chinese === 'string' && mapping.chinese.trim() === mapping.chinese && mapping.chinese.length > 0,
        `${label}: Chinese phrase must be non-empty and trimmed`
      )
      assert(
        (mapping.english.match(ENGLISH_WORD) ?? []).length >= Math.min(2, Math.max(1, sentenceWordCount)),
        `${label}: English phrase must contain at least two words unless the sentence itself has one word`
      )
      assert(meaningfulCharacterPositions(mapping.chinese).length >= 1, `${label}: Chinese phrase is too short`)
      if (sentenceWordCount > SHORT_SENTENCE_MAX_WORDS) {
        assert(
          mapping.english.toLocaleLowerCase('en-US') !== pair.english.toLocaleLowerCase('en-US'),
          `${label}: split the sentence into semantic units instead of mapping the whole English sentence`
        )
        assert(
          mapping.chinese !== pair.chinese,
          `${label}: split the sentence into semantic units instead of mapping the whole Chinese sentence`
        )
      }

      const key = `${mapping.english.toLocaleLowerCase('en-US')}\u0000${mapping.chinese}`
      assert(!seenMappings.has(key), `${label}: duplicate mapping`)
      seenMappings.add(key)

      const sourceRanges = findRanges(pair.english, mapping.english, true)
      const targetRanges = findRanges(pair.chinese, mapping.chinese)
      assert(sourceRanges.length > 0, `${label}: English phrase does not occur in sentence`)
      assert(targetRanges.length > 0, `${label}: Chinese phrase does not occur in translation`)
      const sourceUnitCoverage = englishCoverage(pair.english, sourceRanges)
      const targetUnitCoverage = chineseCoverage(pair.chinese, targetRanges)
      if (measuredEnglishWords(pair.english).length > SHORT_SENTENCE_MAX_WORDS) {
        assert(
          sourceUnitCoverage <= MAX_SINGLE_MAPPING_COVERAGE,
          `${label}: one English mapping covers ${percentage(sourceUnitCoverage)} of the sentence; split it into smaller semantic units`
        )
      }
      if (
        sentenceWordCount > SHORT_SENTENCE_MAX_WORDS
        && meaningfulCharacterPositions(pair.chinese).length >= 8
      ) {
        assert(
          targetUnitCoverage <= MAX_SINGLE_MAPPING_COVERAGE,
          `${label}: one Chinese mapping covers ${percentage(targetUnitCoverage)} of the sentence; split it into smaller semantic units`
        )
      }
      englishRanges.push(...sourceRanges)
      chineseRanges.push(...targetRanges)
    }

    const sourceCoverage = englishCoverage(pair.english, englishRanges)
    const targetCoverage = chineseCoverage(pair.chinese, chineseRanges)
    assert(
      sourceCoverage >= MIN_ENGLISH_COVERAGE,
      `${date} ${pair.number}: English mapping coverage is ${percentage(sourceCoverage)}; expected at least ${percentage(MIN_ENGLISH_COVERAGE)}`
    )
    assert(
      targetCoverage >= MIN_CHINESE_COVERAGE,
      `${date} ${pair.number}: Chinese mapping coverage is ${percentage(targetCoverage)}; expected at least ${percentage(MIN_CHINESE_COVERAGE)}`
    )

    for (const targetWord of targetWordsBySentence[pair.number] ?? []) {
      const pattern = wordPattern(targetWord)
      assert(
        pair.mappings.some((mapping) => pattern.test(mapping.english)),
        `${date} ${pair.number}: target word "${targetWord}" needs an explicit Chinese mapping`
      )
    }

    minimumEnglishCoverage = Math.min(minimumEnglishCoverage, sourceCoverage)
    minimumChineseCoverage = Math.min(minimumChineseCoverage, targetCoverage)
  }

  return {
    sentenceCount: review.sentence_pairs.length,
    minimumEnglishCoverage,
    minimumChineseCoverage,
  }
}
