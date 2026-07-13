import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const GRAMMAR_DIR = resolve('grammar')
const POINT_PATTERN = /^(\d+)\.\s+(.+?)(★{1,3})(.*)$/
const NOTE_SECTION_PATTERN = /^##\s+语法笔记(?:\s+Grammar Notes)?\s*$/i
const NOTE_HEADING_PATTERN = /^###\s+(\d+)\.\s+(.+)$/

export interface GrammarPoint {
  id: number
  chapter: number
  chapterTitle: string
  section: string
  subsection: string
  title: string
  importance: number
  summary: string
  summaryMarkdown: string
  detailMarkdown: string
  sourceFile: string
  sourcePath: string
}

export interface GrammarChapter {
  number: number
  title: string
  sourceFile: string
  sourcePath: string
  points: GrammarPoint[]
}

export interface GrammarLibrary {
  chapters: GrammarChapter[]
  points: GrammarPoint[]
  byId: Map<number, GrammarPoint>
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/[`*_]/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function parsePointTail(raw: string): string {
  const tail = raw.trim()
  if (!tail) return ''
  if (/^[—-]/.test(tail)) return tail.replace(/^[—-]\s*/, '').trim()
  if ((tail.startsWith('（') && tail.endsWith('）')) || (tail.startsWith('(') && tail.endsWith(')'))) {
    return tail.slice(1, -1).trim()
  }
  return tail
}

function parseChapter(fileName: string): GrammarChapter {
  const sourcePath = resolve(GRAMMAR_DIR, fileName)
  const lines = readFileSync(sourcePath, 'utf-8').split('\n')
  const chapterFromFile = Number.parseInt(fileName.match(/^(\d+)-/)?.[1] ?? '', 10)
  if (!Number.isFinite(chapterFromFile)) throw new Error(`Grammar chapter filename must start with a number: ${fileName}`)

  const titleLine = lines.find((line) => /^#\s+/.test(line.trim()))?.trim()
  const title = titleLine?.replace(/^#\s+/, '').trim() || `第 ${chapterFromFile} 章`
  const noteSectionIndex = lines.findIndex((line) => NOTE_SECTION_PATTERN.test(line.trim()))
  const indexEnd = noteSectionIndex >= 0 ? noteSectionIndex : lines.length
  const points: GrammarPoint[] = []
  let section = ''
  let subsection = ''

  for (let index = 0; index < indexEnd; index += 1) {
    const line = lines[index]!.trimEnd()
    const trimmed = line.trim()
    const sectionMatch = trimmed.match(/^##\s+(.+)$/)
    if (sectionMatch) {
      section = sectionMatch[1]!.trim()
      subsection = ''
      continue
    }

    const subsectionMatch = trimmed.match(/^###\s+(.+)$/)
    if (subsectionMatch) {
      subsection = subsectionMatch[1]!.trim()
      continue
    }

    const pointMatch = trimmed.match(POINT_PATTERN)
    if (!pointMatch) continue

    const summaryLines: string[] = []
    const inlineSummary = parsePointTail(pointMatch[4] ?? '')
    if (inlineSummary) summaryLines.push(inlineSummary)
    let lookahead = index + 1
    while (lookahead < indexEnd) {
      const continuation = lines[lookahead]!
      if (!/^\s{2,}[-*]\s+/.test(continuation)) break
      summaryLines.push(continuation.trim())
      lookahead += 1
    }

    const summaryMarkdown = summaryLines.join('\n')
    points.push({
      id: Number.parseInt(pointMatch[1]!, 10),
      chapter: chapterFromFile,
      chapterTitle: title,
      section,
      subsection,
      title: pointMatch[2]!.trim(),
      importance: pointMatch[3]!.length,
      summary: cleanInlineMarkdown(summaryLines.map((item) => item.replace(/^[-*]\s+/, '')).join('；')),
      summaryMarkdown,
      detailMarkdown: '',
      sourceFile: fileName,
      sourcePath,
    })
    index = lookahead - 1
  }

  if (noteSectionIndex >= 0) {
    const notes = new Map<number, { title: string; markdown: string }>()
    let activeId: number | null = null
    let activeTitle = ''
    let body: string[] = []

    function flushNote(): void {
      if (activeId === null) return
      if (notes.has(activeId)) throw new Error(`${fileName}: duplicate grammar note for #${activeId}`)
      notes.set(activeId, { title: activeTitle, markdown: body.join('\n').trim() })
    }

    for (let index = noteSectionIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!
      if (activeId !== null && line.trim() === '---') {
        flushNote()
        activeId = null
        body = []
        break
      }
      const heading = line.trim().match(NOTE_HEADING_PATTERN)
      if (heading) {
        flushNote()
        activeId = Number.parseInt(heading[1]!, 10)
        activeTitle = heading[2]!.trim()
        body = []
        continue
      }
      if (activeId !== null) body.push(line)
    }
    flushNote()

    const pointsById = new Map(points.map((point) => [point.id, point]))
    for (const [id, note] of notes) {
      const point = pointsById.get(id)
      if (!point) throw new Error(`${fileName}: grammar note #${id} has no index entry in this chapter`)
      if (cleanInlineMarkdown(note.title) !== cleanInlineMarkdown(point.title)) {
        throw new Error(`${fileName}: grammar note #${id} title must match index title "${point.title}"`)
      }
      point.detailMarkdown = note.markdown
    }
  }

  return {
    number: chapterFromFile,
    title,
    sourceFile: fileName,
    sourcePath,
    points,
  }
}

export function discoverGrammarLibrary(): GrammarLibrary {
  if (!existsSync(GRAMMAR_DIR)) throw new Error(`Grammar directory not found: ${GRAMMAR_DIR}`)
  const chapters = readdirSync(GRAMMAR_DIR)
    .filter((file) => /^\d+-.*\.md$/.test(file))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map(parseChapter)
    .sort((a, b) => a.number - b.number)
  const points = chapters.flatMap((chapter) => chapter.points).sort((a, b) => a.id - b.id)
  const byId = new Map<number, GrammarPoint>()

  for (const point of points) {
    const previous = byId.get(point.id)
    if (previous) {
      throw new Error(`Duplicate grammar point #${point.id}: ${basename(previous.sourcePath)} and ${basename(point.sourcePath)}`)
    }
    byId.set(point.id, point)
  }

  return { chapters, points, byId }
}

export function grammarSearchText(point: GrammarPoint): string {
  return cleanInlineMarkdown([
    point.id,
    point.title,
    point.summary,
    point.section,
    point.subsection,
    point.chapterTitle,
  ].join(' ')).toLocaleLowerCase('zh-CN')
}

export function grammarNoteHeading(point: GrammarPoint): string {
  return `### ${point.id}. ${point.title}`
}
