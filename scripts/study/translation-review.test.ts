import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateTranslationReview,
  type NumberedSentence,
  type TranslationReview,
} from './translation-review'

const date = '2026-07-15'
const english: NumberedSentence[] = [{
  number: '①',
  text: 'The museum combines a public ceremony with everyday activities.',
}]
const chinese: NumberedSentence[] = [{
  number: '①',
  text: '博物馆将一场公众典礼与日常活动结合起来。',
}]

function reviewWithMappings(
  mappings: TranslationReview['sentence_pairs'][number]['mappings']
): TranslationReview {
  return {
    schema_version: 1,
    lesson_date: date,
    sentence_pairs: [{
      number: '①',
      english: english[0]!.text,
      chinese: chinese[0]!.text,
      mappings,
    }],
  }
}

test('accepts a current, sufficiently covered bilingual review', () => {
  const review = reviewWithMappings([
    { english: 'The museum combines a public ceremony', chinese: '博物馆将一场公众典礼' },
    { english: 'with everyday activities', chinese: '与日常活动结合起来' },
  ])

  const result = validateTranslationReview(date, review, english, chinese, {
    '①': ['museum', 'ceremony'],
  })

  assert.equal(result.sentenceCount, 1)
  assert.equal(result.minimumEnglishCoverage, 1)
  assert.equal(result.minimumChineseCoverage, 1)
})

test('rejects a stale sentence snapshot after article text changes', () => {
  const review = reviewWithMappings([
    { english: 'The museum combines a public ceremony', chinese: '博物馆将一场公众典礼' },
    { english: 'with everyday activities', chinese: '与日常活动结合起来' },
  ])
  review.sentence_pairs[0]!.english = 'The museum combines a ceremony with everyday activities.'

  assert.throws(
    () => validateTranslationReview(date, review, english, chinese, {}),
    /English review snapshot is stale/
  )
})

test('rejects a stale translation snapshot after Chinese text changes', () => {
  const review = reviewWithMappings([
    { english: 'The museum combines a public ceremony', chinese: '博物馆将一场公众典礼' },
    { english: 'with everyday activities', chinese: '与日常活动结合起来' },
  ])
  review.sentence_pairs[0]!.chinese = '博物馆把一场公众典礼与日常活动结合起来。'

  assert.throws(
    () => validateTranslationReview(date, review, english, chinese, {}),
    /Chinese review snapshot is stale/
  )
})

test('rejects mappings that leave a target word without a Chinese decision', () => {
  const review = reviewWithMappings([
    { english: 'combines a public ceremony', chinese: '一场公众典礼' },
    { english: 'with everyday activities', chinese: '与日常活动结合起来' },
  ])

  assert.throws(
    () => validateTranslationReview(date, review, english, chinese, { '①': ['museum'] }),
    /target word "museum" needs an explicit Chinese mapping/
  )
})

test('rejects superficial mappings below the semantic-unit coverage gate', () => {
  const review = reviewWithMappings([
    { english: 'a public ceremony', chinese: '一场公众典礼' },
    { english: 'everyday activities', chinese: '日常活动' },
  ])

  assert.throws(
    () => validateTranslationReview(date, review, english, chinese, {}),
    /English mapping coverage is 67%; expected at least 70%/
  )
})

test('rejects a whole-sentence mapping disguised by omitted punctuation', () => {
  const review = reviewWithMappings([
    {
      english: 'The museum combines a public ceremony with everyday activities',
      chinese: '博物馆将一场公众典礼与日常活动结合起来',
    },
    { english: 'with everyday activities', chinese: '与日常活动结合起来' },
  ])

  assert.throws(
    () => validateTranslationReview(date, review, english, chinese, {}),
    /one English mapping covers 100% of the sentence/
  )
})

test('allows a single mapping for a one-word dialogue sentence', () => {
  const shortEnglish: NumberedSentence[] = [{ number: '①', text: 'Yes.' }]
  const shortChinese: NumberedSentence[] = [{ number: '①', text: '是。' }]
  const review: TranslationReview = {
    schema_version: 1,
    lesson_date: date,
    sentence_pairs: [{
      number: '①',
      english: 'Yes.',
      chinese: '是。',
      mappings: [{ english: 'Yes', chinese: '是' }],
    }],
  }

  const result = validateTranslationReview(date, review, shortEnglish, shortChinese, {})
  assert.equal(result.minimumEnglishCoverage, 1)
  assert.equal(result.minimumChineseCoverage, 1)
})
