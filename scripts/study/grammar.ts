import { parseArgs } from 'node:util'
import { discoverGrammarLibrary, grammarNoteHeading, grammarSearchText, type GrammarPoint } from './grammar-library'

const { values } = parseArgs({
  options: {
    id: { type: 'string' },
    query: { type: 'string', short: 'q' },
    json: { type: 'boolean', default: false },
  },
})

function outputPoint(point: GrammarPoint): Record<string, unknown> {
  return {
    id: point.id,
    title: point.title,
    importance: point.importance,
    summary: point.summary,
    chapter: point.chapter,
    chapter_title: point.chapterTitle,
    section: point.section,
    subsection: point.subsection,
    source_path: point.sourcePath,
    note_heading: grammarNoteHeading(point),
    has_note: Boolean(point.detailMarkdown),
  }
}

function scoreMatch(point: GrammarPoint, query: string): number {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  const title = point.title.replace(/[`*_]/g, '').toLocaleLowerCase('zh-CN')
  const searchable = grammarSearchText(point)
  if (String(point.id) === normalized) return 1000
  if (title === normalized) return 900
  if (title.startsWith(normalized)) return 700
  if (title.includes(normalized)) return 600
  if (searchable.includes(normalized)) return 300
  return 0
}

function main(): void {
  const library = discoverGrammarLibrary()
  const rawId = values.id?.trim()
  const query = values.query?.trim()
  let matches: GrammarPoint[] = []

  if (rawId) {
    const id = Number.parseInt(rawId, 10)
    if (!Number.isInteger(id) || id < 1) throw new Error(`Invalid grammar id: ${rawId}`)
    const point = library.byId.get(id)
    if (point) matches = [point]
  } else if (query) {
    matches = library.points
      .map((point) => ({ point, score: scoreMatch(point, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.point.id - b.point.id)
      .slice(0, 12)
      .map((item) => item.point)
  }

  const result = {
    total_points: library.points.length,
    chapters: library.chapters.length,
    notes: library.points.filter((point) => point.detailMarkdown).length,
    query: rawId ? `#${rawId}` : query ?? '',
    matches: matches.map(outputPoint),
  }

  if (values.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (!rawId && !query) {
    console.log(`Grammar library: ${result.total_points} points across ${result.chapters} chapters; ${result.notes} detailed notes`)
    console.log('Use --id <number> or --query <text> to locate the canonical grammar entry.')
    return
  }

  if (matches.length === 0) {
    console.log(`No grammar point matched ${result.query}.`)
    process.exitCode = 1
    return
  }

  for (const point of matches) {
    console.log(`#${point.id} ${point.title} ${'★'.repeat(point.importance)}`)
    console.log(`  ${point.chapterTitle}${point.section ? ` / ${point.section}` : ''}`)
    console.log(`  ${point.sourcePath}`)
    console.log(`  ${grammarNoteHeading(point)} · ${point.detailMarkdown ? '已有详细笔记' : '尚无详细笔记'}`)
    if (point.summary) console.log(`  ${point.summary}`)
  }
}

main()
