import { parseArgs } from 'node:util'
import {
  discoverArticleDates,
  REAL_WORLD_CONTEXT_REQUIRED_SINCE,
  validateArticle,
} from './article-harness'

const { values } = parseArgs({
  options: {
    date: { type: 'string' },
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
})

const today = new Date().toISOString().slice(0, 10)
const dates = values.all
  ? discoverArticleDates().filter((date) => date >= REAL_WORLD_CONTEXT_REQUIRED_SINCE)
  : [values.date ?? today]

if (dates.length === 0) {
  console.log('No articles require the real-world context harness yet.')
  process.exit(0)
}

const results = dates.map(validateArticle)
if (values.json) {
  console.log(JSON.stringify(results, null, 2))
} else {
  for (const result of results) {
    console.log(
      `✓ ${result.date} · ${result.genre} · ${result.wordCount} words · `
      + `${result.sentenceCount} sentences · ${result.targetCount} targets · `
      + `${result.translationReview?.sentenceCount ?? 0} aligned · `
      + `${result.context?.context_kind ?? 'legacy context'}`
    )
  }
  console.log(`✓ Article harness: ${results.length} lesson(s) passed`)
}
