import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export const EGP_COLUMNS = [
  'id',
  'SuperCategory',
  'SubCategory',
  'Level',
  'Lexical Range',
  'Guideword',
  'Can-do statement',
  'Example',
] as const

export interface EgpRow {
  sourceRow: number
  id: string
  superCategory: string
  subCategory: string
  level: string
  lexicalRange: string
  guideword: string
  canDo: string
  example: string
}

export interface EgpMappingRule {
  id: string
  superCategory: string
  subcategories: string[]
  pointIds: number[]
  rationale: string
}

export interface EgpCoverageRules {
  schemaVersion: number
  source: {
    label: string
    originalUrl?: string
    archiveSnapshotUrl?: string
    archiveTimestamp?: string
    expectedContentSha256: string
    expectedTotalRows: number
    targetLevels: string[]
    expectedTargetRows: number
    expectedActionableRows: number
    expectedPlaceholderRows: number
    expectedLevelCounts: Record<string, number>
    expectedCategoryCounts: Record<string, number>
  }
  mappingRules: EgpMappingRule[]
}

export interface EgpMappedDecision {
  rowHash: string
  sourceRow: number
  level: string
  category: string
  status: 'mapped'
  ruleId: string
  pointIds: number[]
}

export interface EgpExcludedDecision {
  rowHash: string
  sourceRow: number
  level: string
  category: string
  status: 'excluded'
  reason: 'source_placeholder_missing_can_do'
}

export type EgpDecision = EgpMappedDecision | EgpExcludedDecision

export interface EgpCoverageAudit {
  schemaVersion: 1
  source: {
    contentSha256: string
    totalRows: number
    targetLevels: string[]
  }
  summary: {
    targetRows: number
    actionableRows: number
    mappedRows: number
    excludedRows: number
    unmappedRows: number
    distinctGrammarPoints: number
    levelCounts: Record<string, number>
    categoryCounts: Record<string, number>
  }
  decisions: EgpDecision[]
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const hexadecimal = code[1]?.toLowerCase() === 'x'
      const numeric = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity
    }
    return ({ amp: '&', apos: "'", quot: '"', lt: '<', gt: '>' } as Record<string, string>)[code.toLowerCase()] ?? entity
  })
}

function cellText(cellBody: string, cellType: string, sharedStrings: string[]): string {
  if (cellType === 'inlineStr') {
    return [...cellBody.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((match) => decodeXml(match[1] ?? ''))
      .join('')
  }
  const raw = cellBody.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1] ?? ''
  if (cellType === 's') {
    const index = Number.parseInt(raw, 10)
    if (!Number.isInteger(index) || sharedStrings[index] === undefined) {
      throw new Error(`EGP workbook references missing shared string #${raw}`)
    }
    return sharedStrings[index]
  }
  return decodeXml(raw)
}

export function parseSharedStringsXml(xml: string): string[] {
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) =>
    [...((match[1] ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g))]
      .map((textMatch) => decodeXml(textMatch[1] ?? ''))
      .join('')
  )
}

export function parseEgpWorksheetXml(xml: string, sharedStrings: string[] = []): EgpRow[] {
  const parsedRows = [...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
    const rowNumber = Number.parseInt(rowMatch[1]?.match(/\br="(\d+)"/)?.[1] ?? '', 10)
    const cells = new Map<string, string>()
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1] ?? ''
      const reference = attributes.match(/\br="([A-Z]+)\d+"/)?.[1]
      if (!reference) continue
      const type = attributes.match(/\bt="([^"]+)"/)?.[1] ?? ''
      cells.set(reference, cellText(cellMatch[2] ?? '', type, sharedStrings))
    }
    return { rowNumber, cells }
  })

  if (parsedRows.length === 0) throw new Error('EGP worksheet has no rows')
  const header = parsedRows[0]!
  const headerValues = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((column) => header.cells.get(column)?.trim() ?? '')
  const officialColumns = ['#', 'SuperCategory', 'SubCategory', 'Level', 'Lexical Range', 'guideword', 'Can-do statement', 'Example']
  const supportedHeaders = [EGP_COLUMNS, officialColumns].map((columns) => columns.join('\u0000'))
  if (!supportedHeaders.includes(headerValues.join('\u0000'))) {
    throw new Error(`Unexpected EGP worksheet columns: ${headerValues.join(', ')}`)
  }

  return parsedRows.slice(1).flatMap(({ rowNumber, cells }, index) => {
    const values = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((column) => (cells.get(column) ?? '').trim())
    if (values.every((value) => value === '')) return []
    const sourceRow = Number.isInteger(rowNumber) ? rowNumber : index + 2
    const row: EgpRow = {
      sourceRow,
      id: values[0]!,
      superCategory: values[1]!,
      subCategory: values[2]!,
      level: values[3]!,
      lexicalRange: values[4]!,
      guideword: values[5]!,
      canDo: values[6]!,
      example: values[7]!,
    }
    if (!row.id || !row.superCategory || !row.subCategory || !row.level || !row.guideword) {
      throw new Error(`EGP source row ${sourceRow} is missing a required identity or classification field`)
    }
    return [row]
  })
}

function extractZipMember(xlsxPath: string, member: string, required: boolean): string {
  const result = spawnSync('unzip', ['-p', xlsxPath, member], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw new Error(`Could not run unzip: ${result.error.message}`)
  if (result.status !== 0) {
    if (!required) return ''
    const detail = result.stderr.trim() || `exit ${result.status}`
    throw new Error(`Could not read ${member} from ${xlsxPath}: ${detail}`)
  }
  return result.stdout
}

export function readEgpWorkbook(xlsxPath: string): EgpRow[] {
  const sharedStringsXml = extractZipMember(xlsxPath, 'xl/sharedStrings.xml', false)
  const sharedStrings = sharedStringsXml ? parseSharedStringsXml(sharedStringsXml) : []
  const worksheetXml = extractZipMember(xlsxPath, 'xl/worksheets/sheet1.xml', true)
  return parseEgpWorksheetXml(worksheetXml, sharedStrings)
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

export function sha256EgpContent(rows: EgpRow[]): string {
  const hash = createHash('sha256')
  for (const row of rows) {
    hash.update(`${JSON.stringify([
      row.id,
      row.superCategory,
      row.subCategory,
      row.level,
      row.lexicalRange,
      row.guideword,
      row.canDo,
      row.example,
    ])}\n`)
  }
  return hash.digest('hex')
}

export function loadEgpCoverageRules(path: string): EgpCoverageRules {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as EgpCoverageRules
  if (parsed.schemaVersion !== 1) throw new Error(`Unsupported EGP rule schema: ${String(parsed.schemaVersion)}`)
  if (!parsed.source || !Array.isArray(parsed.mappingRules)) throw new Error('EGP rule file is missing source metadata or mappingRules')
  return parsed
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  return Object.fromEntries(
    [...items.reduce((counts, item) => {
      const value = key(item)
      counts.set(value, (counts.get(value) ?? 0) + 1)
      return counts
    }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right))
  )
}

function assertEqualCounts(label: string, actual: Record<string, number>, expected: Record<string, number>): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(Object.fromEntries(Object.entries(expected).sort(([left], [right]) => left.localeCompare(right))))
  if (actualJson !== expectedJson) throw new Error(`${label} changed: expected ${expectedJson}, received ${actualJson}`)
}

function fingerprintRow(row: EgpRow): string {
  return createHash('sha256')
    .update([
      row.id,
      row.superCategory,
      row.subCategory,
      row.level,
      row.lexicalRange,
      row.guideword,
      row.canDo,
      row.example,
    ].join('\u0000'))
    .digest('hex')
}

function validateRules(rules: EgpCoverageRules, knownPointIds: ReadonlySet<number>): Map<string, EgpMappingRule> {
  if (!/^[a-f0-9]{64}$/.test(rules.source.expectedContentSha256)) {
    throw new Error('EGP expectedContentSha256 must be a lowercase SHA-256 digest')
  }
  if (new Set(rules.source.targetLevels).size !== rules.source.targetLevels.length) throw new Error('EGP targetLevels contains duplicates')
  const byCategory = new Map<string, EgpMappingRule>()
  const ruleIds = new Set<string>()
  for (const rule of rules.mappingRules) {
    if (!rule.id || ruleIds.has(rule.id)) throw new Error(`Duplicate or empty EGP mapping rule id: ${rule.id}`)
    ruleIds.add(rule.id)
    if (!rule.rationale.trim() || rule.subcategories.length === 0 || rule.pointIds.length === 0) {
      throw new Error(`EGP mapping rule ${rule.id} must have a rationale, subcategories, and point IDs`)
    }
    if (new Set(rule.pointIds).size !== rule.pointIds.length) throw new Error(`EGP mapping rule ${rule.id} contains duplicate point IDs`)
    for (const pointId of rule.pointIds) {
      if (!knownPointIds.has(pointId)) throw new Error(`EGP mapping rule ${rule.id} references missing grammar point #${pointId}`)
    }
    for (const subCategory of rule.subcategories) {
      const key = `${rule.superCategory}\u0000${subCategory}`
      if (byCategory.has(key)) throw new Error(`Multiple EGP rules cover ${rule.superCategory} / ${subCategory}`)
      byCategory.set(key, rule)
    }
  }
  return byCategory
}

export function auditEgpRows(
  allRows: EgpRow[],
  rules: EgpCoverageRules,
  knownPointIds: ReadonlySet<number>,
  sourceContentSha256 = sha256EgpContent(allRows)
): EgpCoverageAudit {
  if (sourceContentSha256 !== rules.source.expectedContentSha256) {
    throw new Error(
      `EGP normalized content SHA-256 changed: expected ${rules.source.expectedContentSha256}, received ${sourceContentSha256}`
    )
  }
  if (allRows.length !== rules.source.expectedTotalRows) {
    throw new Error(`EGP row count changed: expected ${rules.source.expectedTotalRows}, received ${allRows.length}`)
  }

  const targetLevels = new Set(rules.source.targetLevels)
  const targetRows = allRows.filter((row) => targetLevels.has(row.level.trim()))
  const levelCounts = countBy(targetRows, (row) => row.level.trim())
  const categoryCounts = countBy(targetRows, (row) => row.superCategory)
  if (targetRows.length !== rules.source.expectedTargetRows) {
    throw new Error(`EGP A2-C1 row count changed: expected ${rules.source.expectedTargetRows}, received ${targetRows.length}`)
  }
  assertEqualCounts('EGP A2-C1 level counts', levelCounts, rules.source.expectedLevelCounts)
  assertEqualCounts('EGP A2-C1 category counts', categoryCounts, rules.source.expectedCategoryCounts)

  const ruleByCategory = validateRules(rules, knownPointIds)
  const usedRuleIds = new Set<string>()
  const decisions: EgpDecision[] = []
  const unmapped: EgpRow[] = []
  for (const row of targetRows) {
    const level = row.level.trim()
    const category = `${row.superCategory} / ${row.subCategory}`
    const rowHash = fingerprintRow({ ...row, level })
    if (!row.canDo) {
      decisions.push({
        rowHash,
        sourceRow: row.sourceRow,
        level,
        category,
        status: 'excluded',
        reason: 'source_placeholder_missing_can_do',
      })
      continue
    }
    const rule = ruleByCategory.get(`${row.superCategory}\u0000${row.subCategory}`)
    if (!rule) {
      unmapped.push(row)
      continue
    }
    usedRuleIds.add(rule.id)
    decisions.push({
      rowHash,
      sourceRow: row.sourceRow,
      level,
      category,
      status: 'mapped',
      ruleId: rule.id,
      pointIds: [...rule.pointIds],
    })
  }

  const excludedRows = decisions.filter((decision) => decision.status === 'excluded').length
  const mappedRows = decisions.length - excludedRows
  const unusedRules = rules.mappingRules.filter((rule) => !usedRuleIds.has(rule.id))
  if (unmapped.length > 0) {
    const categories = [...new Set(unmapped.map((row) => `${row.superCategory} / ${row.subCategory}`))]
    throw new Error(`EGP has ${unmapped.length} actionable rows without a mapping rule: ${categories.join(', ')}`)
  }
  if (unusedRules.length > 0) throw new Error(`Unused EGP mapping rules: ${unusedRules.map((rule) => rule.id).join(', ')}`)
  if (mappedRows !== rules.source.expectedActionableRows || excludedRows !== rules.source.expectedPlaceholderRows) {
    throw new Error(
      `EGP decision counts changed: expected ${rules.source.expectedActionableRows} mapped + ` +
      `${rules.source.expectedPlaceholderRows} excluded, received ${mappedRows} mapped + ${excludedRows} excluded`
    )
  }

  const distinctGrammarPoints = new Set(
    decisions.flatMap((decision) => decision.status === 'mapped' ? decision.pointIds : [])
  ).size
  return {
    schemaVersion: 1,
    source: {
      contentSha256: sourceContentSha256,
      totalRows: allRows.length,
      targetLevels: [...rules.source.targetLevels],
    },
    summary: {
      targetRows: targetRows.length,
      actionableRows: mappedRows,
      mappedRows,
      excludedRows,
      unmappedRows: 0,
      distinctGrammarPoints,
      levelCounts,
      categoryCounts,
    },
    decisions,
  }
}
