import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const GRAMMAR_DIR = resolve('grammar')
const CURRICULUM_PATH = resolve(GRAMMAR_DIR, 'curriculum.md')
const POINT_PATTERN = /^(\d+)\.\s+(.+?)(★{1,3})(.*)$/
const NOTE_SECTION_PATTERN = /^##\s+语法笔记(?:\s+Grammar Notes)?\s*$/i
const NOTE_HEADING_PATTERN = /^###\s+(\d+)\.\s+(.+)$/
const CURRICULUM_PATTERN = /<!--\s*curriculum-json:start\s*-->\s*```json\s*([\s\S]*?)\s*```\s*<!--\s*curriculum-json:end\s*-->/i

export interface GrammarCurriculumScope {
  title: string
  claim: string
  baselineBand: number
  targetBand: number
  cefrRange: string
  safetyMargin: string
}

export interface GrammarCurriculumEvidence {
  id: string
  label: string
  url: string
  role: string
}

export interface GrammarCurriculumPhase {
  id: string
  position: number
  name: string
  caption: string
  cefrFocus: string
  startBand: number
  targetBand: number
  nominalWeeks: number
  wordFocus: string
  grammarFocus: string
  outcomes: string[]
  pointIds: number[]
}

export interface GrammarCoverageGroup {
  id: string
  label: string
  description: string
  pointIds: number[]
  allPoints?: boolean
}

export interface GrammarCurriculum {
  schemaVersion: number
  scope: GrammarCurriculumScope
  evidence: GrammarCurriculumEvidence[]
  phases: GrammarCurriculumPhase[]
  criteria: GrammarCoverageGroup[]
  taskContexts: GrammarCoverageGroup[]
  phaseByPointId: Map<number, GrammarCurriculumPhase>
}

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
  curriculum: GrammarCurriculum
}

export interface GrammarCurriculumDocument {
  schemaVersion: number
  scope: GrammarCurriculumScope
  evidence: GrammarCurriculumEvidence[]
  phases: GrammarCurriculumPhase[]
  criteria: GrammarCoverageGroup[]
  taskContexts: GrammarCoverageGroup[]
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

  for (const [index, point] of points.entries()) {
    if (point.id !== index + 1) {
      throw new Error(`Grammar point IDs must remain append-only and contiguous: expected #${index + 1}, received #${point.id}`)
    }
  }

  const curriculum = parseGrammarCurriculum(points)
  return { chapters, points, byId, curriculum }
}

function parseGrammarCurriculum(points: GrammarPoint[]): GrammarCurriculum {
  if (!existsSync(CURRICULUM_PATH)) throw new Error(`Grammar curriculum not found: ${CURRICULUM_PATH}`)
  const markdown = readFileSync(CURRICULUM_PATH, 'utf-8')
  return parseGrammarCurriculumMarkdown(markdown, points)
}

export function parseGrammarCurriculumMarkdown(markdown: string, points: GrammarPoint[]): GrammarCurriculum {
  const match = markdown.match(CURRICULUM_PATTERN)
  if (!match) throw new Error('grammar/curriculum.md must contain exactly one marked JSON curriculum block')

  let document: GrammarCurriculumDocument
  try {
    document = JSON.parse(match[1]!) as GrammarCurriculumDocument
  } catch (error) {
    throw new Error(`Invalid grammar curriculum JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  return validateGrammarCurriculumDocument(document, points)
}

export function validateGrammarCurriculumDocument(
  document: GrammarCurriculumDocument,
  points: Array<Pick<GrammarPoint, 'id'>>
): GrammarCurriculum {
  if (document.schemaVersion !== 1) throw new Error(`Unsupported grammar curriculum schema version: ${document.schemaVersion}`)
  if (!document.scope || document.scope.baselineBand !== 4.5 || document.scope.targetBand !== 7.5) {
    throw new Error('Grammar curriculum scope must span IELTS 4.5 to 7.5')
  }
  if (!Array.isArray(document.evidence) || document.evidence.length < 4) {
    throw new Error('Grammar curriculum must name at least four independent evidence sources')
  }
  for (const source of document.evidence) {
    if (!source.id || !source.label || !source.role || !/^https:\/\//.test(source.url)) {
      throw new Error(`Invalid grammar curriculum evidence entry: ${JSON.stringify(source)}`)
    }
  }

  const phases = [...(document.phases ?? [])].sort((a, b) => a.position - b.position)
  if (phases.length !== 6) throw new Error(`Grammar curriculum must contain six phases, received ${phases.length}`)
  const phaseIDs = new Set<string>()
  const phaseByPointId = new Map<number, GrammarCurriculumPhase>()
  let nominalWeeks = 0
  for (const [index, phase] of phases.entries()) {
    if (!phase.id || phaseIDs.has(phase.id)) throw new Error(`Duplicate or empty grammar phase ID: ${phase.id}`)
    phaseIDs.add(phase.id)
    if (phase.position !== index + 1) throw new Error(`Grammar phase ${phase.id} has position ${phase.position}; expected ${index + 1}`)
    if (phase.startBand !== (index === 0 ? document.scope.baselineBand : phases[index - 1]!.targetBand)) {
      throw new Error(`Grammar phase ${phase.id} does not start at the previous phase target`)
    }
    if (phase.targetBand <= phase.startBand) throw new Error(`Grammar phase ${phase.id} must increase the target band`)
    if (!Number.isInteger(phase.nominalWeeks) || phase.nominalWeeks < 1) throw new Error(`Grammar phase ${phase.id} has invalid nominalWeeks`)
    if (!phase.name || !phase.caption || !phase.cefrFocus || !phase.wordFocus || !phase.grammarFocus) {
      throw new Error(`Grammar phase ${phase.id} is missing learner-facing metadata`)
    }
    if (!Array.isArray(phase.outcomes) || phase.outcomes.length === 0 || phase.outcomes.some((outcome) => !outcome.trim())) {
      throw new Error(`Grammar phase ${phase.id} must define at least one outcome`)
    }
    if (!Array.isArray(phase.pointIds) || phase.pointIds.length === 0) throw new Error(`Grammar phase ${phase.id} has no grammar points`)
    const withinPhase = new Set<number>()
    for (const pointId of phase.pointIds) {
      if (!Number.isInteger(pointId) || pointId < 1) throw new Error(`Grammar phase ${phase.id} contains invalid point ID ${pointId}`)
      if (withinPhase.has(pointId)) throw new Error(`Grammar phase ${phase.id} repeats point #${pointId}`)
      if (phaseByPointId.has(pointId)) throw new Error(`Grammar point #${pointId} appears in more than one phase`)
      withinPhase.add(pointId)
      phaseByPointId.set(pointId, phase)
    }
    nominalWeeks += phase.nominalWeeks
  }
  if (phases.at(-1)!.targetBand !== document.scope.targetBand) {
    throw new Error(`Last grammar phase must target Band ${document.scope.targetBand}`)
  }
  if (nominalWeeks !== 78) throw new Error(`Grammar curriculum nominal weeks total ${nominalWeeks}; expected 78`)

  const pointIDs = new Set(points.map((point) => point.id))
  for (const pointId of phaseByPointId.keys()) {
    if (!pointIDs.has(pointId)) throw new Error(`Grammar curriculum references unknown point #${pointId}`)
  }
  for (const point of points) {
    if (!phaseByPointId.has(point.id)) throw new Error(`Grammar point #${point.id} has no curriculum phase`)
  }

  validateCoverageGroups('criterion', document.criteria, pointIDs, true)
  validateCoverageGroups('task context', document.taskContexts, pointIDs, true)
  return {
    schemaVersion: document.schemaVersion,
    scope: document.scope,
    evidence: document.evidence,
    phases,
    criteria: document.criteria,
    taskContexts: document.taskContexts,
    phaseByPointId,
  }
}

function validateCoverageGroups(
  kind: string,
  groups: GrammarCoverageGroup[] | undefined,
  pointIDs: Set<number>,
  requireFullUnion: boolean
): void {
  if (!Array.isArray(groups) || groups.length === 0) throw new Error(`Grammar curriculum has no ${kind} groups`)
  const groupIDs = new Set<string>()
  const covered = new Set<number>()
  for (const group of groups) {
    if (!group.id || groupIDs.has(group.id)) throw new Error(`Duplicate or empty grammar ${kind} ID: ${group.id}`)
    groupIDs.add(group.id)
    if (!group.label || !group.description || !Array.isArray(group.pointIds) || (!group.allPoints && group.pointIds.length === 0)) {
      throw new Error(`Grammar ${kind} ${group.id} is incomplete`)
    }
    if (group.allPoints) {
      for (const pointId of pointIDs) covered.add(pointId)
    }
    const withinGroup = new Set<number>()
    for (const pointId of group.pointIds) {
      if (!pointIDs.has(pointId)) throw new Error(`Grammar ${kind} ${group.id} references unknown point #${pointId}`)
      if (withinGroup.has(pointId)) throw new Error(`Grammar ${kind} ${group.id} repeats point #${pointId}`)
      withinGroup.add(pointId)
      covered.add(pointId)
    }
  }
  if (requireFullUnion) {
    for (const pointId of pointIDs) {
      if (!covered.has(pointId)) throw new Error(`Grammar point #${pointId} is not covered by any ${kind}`)
    }
  }
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
