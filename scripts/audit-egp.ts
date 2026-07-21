import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { auditEgpRows, loadEgpCoverageRules, readEgpWorkbook, sha256EgpContent, sha256File } from './study/egp-coverage'
import { discoverGrammarLibrary } from './study/grammar-library'

interface Arguments {
  xlsxPath: string
  manifestPath: string
  json: boolean
}

function parseArguments(argv: string[]): Arguments {
  let xlsxPath = process.env.EGP_XLSX_PATH || '/tmp/english-grammar-profile.xlsx'
  let manifestPath = ''
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--xlsx') {
      xlsxPath = argv[++index] ?? ''
      if (!xlsxPath) throw new Error('--xlsx requires a path')
    } else if (argument === '--manifest') {
      manifestPath = argv[++index] ?? ''
      if (!manifestPath) throw new Error('--manifest requires a path')
    } else if (argument === '--json') {
      json = true
    } else if (argument === '--') {
      continue
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return { xlsxPath: resolve(xlsxPath), manifestPath: manifestPath ? resolve(manifestPath) : '', json }
}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  const rulesPath = resolve('audits/egp-coverage-rules.json')
  const rules = loadEgpCoverageRules(rulesPath)
  const fileSha256 = sha256File(args.xlsxPath)
  const rows = readEgpWorkbook(args.xlsxPath)
  const contentSha256 = sha256EgpContent(rows)
  const grammar = discoverGrammarLibrary()
  const audit = auditEgpRows(rows, rules, new Set(grammar.byId.keys()), contentSha256)

  if (args.manifestPath) {
    mkdirSync(dirname(args.manifestPath), { recursive: true })
    writeFileSync(args.manifestPath, `${JSON.stringify(audit, null, 2)}\n`)
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ source: { ...audit.source, fileSha256 }, summary: audit.summary }, null, 2)}\n`)
    return
  }
  const { summary } = audit
  console.log(`EGP normalized content verified: ${audit.source.contentSha256}`)
  console.log(`Workbook file SHA-256: ${fileSha256}`)
  console.log(`Rows: ${audit.source.totalRows} total; ${summary.targetRows} A2-C1`)
  console.log(`Decisions: ${summary.mappedRows} mapped; ${summary.excludedRows} source placeholders; ${summary.unmappedRows} unmapped`)
  console.log(`Crosswalk: ${summary.distinctGrammarPoints} distinct local grammar points`)
  console.log(`Levels: ${Object.entries(summary.levelCounts).map(([level, count]) => `${level} ${count}`).join(' · ')}`)
  if (args.manifestPath) console.log(`Private hash manifest: ${args.manifestPath}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
