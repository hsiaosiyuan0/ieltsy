import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverGrammarLibrary, type GrammarPoint } from './grammar-library'

const LEGACY_MAX_ID = 459
const NEW_POINT_IDS = Array.from({ length: 14 }, (_, index) => LEGACY_MAX_ID + index + 1)
const MAX_TITLE_ONLY_POINTS = 72
const MIN_LEGACY_DETAILED_NOTES = 10
const MIN_SUMMARY_LENGTH = 60
const MIN_DETAIL_LENGTH = 700

interface MarkdownSection {
  heading: string
  body: string
}

const sectionPatterns = {
  decision: [/核心(?:判断|框架|选择|规则)/, /先(?:判断|找|看)/],
  life: [/(?:生活|日常|家庭|真实)(?:语境|场景)/, /生活化例句/],
  contrast: [/最小对立/, /纠错/, /错误(?:修正|诊断)/, /易错(?:点|辨析)/, /对比与(?:修正|纠错)/],
  transfer: [/语域(?:迁移|选择|边界|对比)/, /口语.*写作/, /写作.*口语/, /任务(?:迁移|应用)/, /跨场景迁移/],
} as const

function markdownSections(markdown: string): MarkdownSection[] {
  const matches = [...markdown.matchAll(/^####\s+(.+?)\s*$/gm)]
  return matches.map((match, index) => ({
    heading: match[1]!.trim(),
    body: markdown.slice(match.index! + match[0].length, matches[index + 1]?.index ?? markdown.length).trim(),
  }))
}

function findSection(
  sections: MarkdownSection[],
  patterns: readonly RegExp[]
): MarkdownSection | undefined {
  return sections.find((section) => patterns.some((pattern) => pattern.test(section.heading)))
}

function englishCodeFragments(markdown: string): string[] {
  const fragments = [...markdown.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1]!.trim())
    .filter((fragment) => (fragment.match(/[A-Za-z]+(?:'[A-Za-z]+)*/g)?.length ?? 0) >= 2)
  return [...new Set(fragments)]
}

function pointLabel(point: GrammarPoint): string {
  return `#${point.id} ${point.title}`
}

const library = discoverGrammarLibrary()

test('grammar library keeps title-only debt at or below the recorded baseline', () => {
  const legacyPoints = library.points.filter((point) => point.id <= LEGACY_MAX_ID)
  const newPoints = library.points.filter((point) => point.id > LEGACY_MAX_ID)
  const titleOnlyPoints = library.points.filter((point) => point.summary.trim() === '')
  const legacyDetailedNotes = legacyPoints.filter((point) => point.detailMarkdown.trim() !== '')

  const stats = {
    total: library.points.length,
    titleOnly: titleOnlyPoints.length,
    legacyDetailed: legacyDetailedNotes.length,
    newDetailed: newPoints.filter((point) => point.detailMarkdown.trim() !== '').length,
  }

  assert.equal(stats.total, LEGACY_MAX_ID + NEW_POINT_IDS.length)
  assert.ok(
    stats.titleOnly <= MAX_TITLE_ONLY_POINTS,
    `title-only grammar debt grew beyond ${MAX_TITLE_ONLY_POINTS}: ${titleOnlyPoints.map(pointLabel).join(', ')}`
  )
  assert.ok(
    titleOnlyPoints.every((point) => point.id <= LEGACY_MAX_ID),
    `new grammar points must not be title-only: ${titleOnlyPoints.filter((point) => point.id > LEGACY_MAX_ID).map(pointLabel).join(', ')}`
  )
  assert.ok(
    stats.legacyDetailed >= MIN_LEGACY_DETAILED_NOTES,
    `legacy detailed-note count regressed: expected at least ${MIN_LEGACY_DETAILED_NOTES}, received ${stats.legacyDetailed}`
  )
  assert.equal(stats.newDetailed, NEW_POINT_IDS.length)
})

test('grammar points #460-473 have substantial summaries and detailed notes', () => {
  const failures: string[] = []

  for (const id of NEW_POINT_IDS) {
    const point = library.byId.get(id)
    if (!point) {
      failures.push(`#${id}: missing grammar point`)
      continue
    }

    if (point.summary.trim().length < MIN_SUMMARY_LENGTH) {
      failures.push(`${pointLabel(point)}: summary is shorter than ${MIN_SUMMARY_LENGTH} characters`)
    }
    if (!/例[：:][^\n]*`[^`\n]*[A-Za-z][^`\n]*`/.test(point.summaryMarkdown)) {
      failures.push(`${pointLabel(point)}: summary needs an explicit English example after “例：”`)
    }
    if (point.detailMarkdown.trim().length < MIN_DETAIL_LENGTH) {
      failures.push(`${pointLabel(point)}: detailed note is shorter than ${MIN_DETAIL_LENGTH} characters`)
    }
  }

  assert.deepEqual(failures, [])
})

test('grammar points #460-473 cover decisions, daily use, contrasts, and register transfer', () => {
  const failures: string[] = []

  for (const id of NEW_POINT_IDS) {
    const point = library.byId.get(id)
    if (!point) {
      failures.push(`#${id}: missing grammar point`)
      continue
    }

    const sections = markdownSections(point.detailMarkdown)
    if (sections.length < 4) {
      failures.push(`${pointLabel(point)}: expected at least four #### sections, received ${sections.length}`)
    }

    const decision = findSection(sections, sectionPatterns.decision)
    const life = findSection(sections, sectionPatterns.life)
    const contrast = findSection(sections, sectionPatterns.contrast)
    const transfer = findSection(sections, sectionPatterns.transfer)

    if (!decision) failures.push(`${pointLabel(point)}: missing a core-decision section`)
    if (!life) failures.push(`${pointLabel(point)}: missing a daily-life context section`)
    if (!contrast) failures.push(`${pointLabel(point)}: missing a minimal-contrast or correction section`)
    if (!transfer) failures.push(`${pointLabel(point)}: missing a register-transfer section`)

    const allExamples = englishCodeFragments(point.detailMarkdown)
    if (allExamples.length < 3) {
      failures.push(`${pointLabel(point)}: expected at least three English examples/code snippets, received ${allExamples.length}`)
    }
    if (life && englishCodeFragments(life.body).length < 3) {
      failures.push(`${pointLabel(point)}: daily-life section needs at least three English examples`)
    }
    if (contrast && englishCodeFragments(contrast.body).length < 2) {
      failures.push(`${pointLabel(point)}: contrast/correction section needs at least two English examples`)
    }
    if (transfer && transfer.body.length < 60) {
      failures.push(`${pointLabel(point)}: register-transfer guidance is too short`)
    }
  }

  assert.deepEqual(failures, [])
})
