import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'dist' },
  },
})

const outDir = resolve(values.out!)
const patternPath = resolve('design-system/ieltsy/pattern.css')
const builtCssPath = join(outDir, 'assets', 'site.css')
const failures: string[] = []

function check(condition: unknown, message: string): void {
  if (!condition) failures.push(message)
}

function includesAll(source: string, values: string[], scope: string): void {
  for (const value of values) check(source.includes(value), `${scope}: missing ${value}`)
}

function collectFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) files.push(...collectFiles(path, suffix))
    else if (path.endsWith(suffix)) files.push(path)
  }
  return files.sort()
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0
}

function checkAccessibleButtons(html: string, scope: string): void {
  const buttons = html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)
  for (const match of buttons) {
    const attrs = match[1] ?? ''
    const content = (match[2] ?? '').replace(/<[^>]+>/g, '').trim()
    check(/\btype="button"/.test(attrs), `${scope}: button missing type="button"`)
    check(Boolean(content) || /\baria-label="[^"]+"/.test(attrs), `${scope}: icon button missing aria-label`)
  }
}

check(existsSync(patternPath), 'pattern source is missing')
check(existsSync(builtCssPath), 'generated site.css is missing; run pnpm study:export first')

if (existsSync(patternPath) && existsSync(builtCssPath)) {
  const patternCss = readFileSync(patternPath, 'utf-8')
  const builtCss = readFileSync(builtCssPath, 'utf-8')

  check(patternCss === builtCss, 'generated site.css is not the canonical pattern.css')
  includesAll(patternCss, [
    '--color-canvas:',
    '--color-paper:',
    '--color-ink:',
    '--color-accent:',
    '--color-secondary:',
    '--color-target-mark:',
    '--color-scroll-thumb:',
    '--scrollbar-size:',
    '--measure-reading:',
    '.masthead',
    '.home-lead',
    '.archive-ledger',
    '.lesson-intro',
    '.study-toolbar',
    '.reading-sheet',
    '.annotation-rail',
    'html::-webkit-scrollbar',
    '.annotation-panel::-webkit-scrollbar',
    'scrollbar-gutter: stable',
    '.mistake-directory',
    '@media (max-width: 74rem)',
    '@media (max-width: 60rem)',
    '@media (max-width: 45rem)',
    '@media (prefers-reduced-motion: reduce)',
    '@media print',
  ], 'pattern.css')

  check(!/gradient\s*\(/i.test(patternCss), 'pattern.css: gradients are forbidden')
  check(!/transition\s*:\s*all\b/i.test(patternCss), 'pattern.css: transition: all is forbidden')
  check(!/letter-spacing\s*:\s*-/i.test(patternCss), 'pattern.css: negative letter spacing is forbidden')
  check(!/font-size\s*:\s*clamp\s*\(/i.test(patternCss), 'pattern.css: viewport-scaled type is forbidden')
  check(!/@import\s+url/i.test(patternCss), 'pattern.css: remote font imports are forbidden')
}

const htmlFiles = collectFiles(outDir, '.html')
check(htmlFiles.length > 0, 'no generated HTML pages found')

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf-8')
  const scope = relative(outDir, file)
  includesAll(html, [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    'name="viewport"',
    'class="skip-link"',
    'class="masthead"',
    '<main id="content"',
    'class="site-footer"',
  ], scope)
  check(!/\bstyle="/i.test(html), `${scope}: inline styles are forbidden`)
  check(!/class="[^"]*\bsh-/i.test(html), `${scope}: legacy sh-* component found`)
  check(!/class="[^"]*\b(?:app-shell|app-main|home-hero|lesson-hero|command-bar|reader-card|vocab-card|grammar-card)\b/i.test(html), `${scope}: legacy page structure found`)
  check(!/href="#"/.test(html), `${scope}: placeholder href found`)
  checkAccessibleButtons(html, scope)
}

const indexPath = join(outDir, 'index.html')
if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, 'utf-8')
  includesAll(html, ['data-page="home"', 'class="home-lead"', 'class="archive-ledger"'], 'index.html')
}

const lessonFiles = htmlFiles.filter((file) => file.includes(`${join('days', '')}`))
check(lessonFiles.length > 0, 'no generated lesson pages found')
for (const file of lessonFiles) {
  const html = readFileSync(file, 'utf-8')
  const scope = relative(outDir, file)
  includesAll(html, [
    'data-page="lesson"',
    'class="lesson-intro"',
    'class="study-toolbar"',
    'class="reading-sheet"',
    'class="annotation-rail"',
    'role="tablist"',
    'data-panel="words"',
    'data-panel="grammar"',
    'data-panel="prosody"',
  ], scope)

  const vocabEntries = count(html, /class="vocab-entry"/g)
  const definitions = count(html, /class="vocab-definition(?:\s[^"]*)?"/g)
  check(vocabEntries > 0, `${scope}: target vocabulary is empty`)
  check(vocabEntries === definitions, `${scope}: ${vocabEntries} target words but ${definitions} Chinese definitions`)
  check(!html.includes('definition-missing'), `${scope}: unresolved Chinese definition found`)
}

const mistakesIndexPath = join(outDir, 'mistakes', 'index.html')
if (existsSync(mistakesIndexPath)) {
  const html = readFileSync(mistakesIndexPath, 'utf-8')
  includesAll(html, ['data-page="mistakes"', 'class="mistake-directory"'], 'mistakes/index.html')
}

for (const kind of ['words', 'grammar']) {
  const file = join(outDir, 'mistakes', `${kind}.html`)
  if (!existsSync(file)) continue
  const html = readFileSync(file, 'utf-8')
  includesAll(html, ['data-page="mistake-detail"', 'class="mistake-detail-layout"', 'class="markdown-sheet"'], `mistakes/${kind}.html`)
}

const notFoundPath = join(outDir, '404.html')
if (existsSync(notFoundPath)) {
  const html = readFileSync(notFoundPath, 'utf-8')
  includesAll(html, ['data-page="not-found"', 'class="not-found"', 'class="not-found__code"'], '404.html')
}

if (failures.length > 0) {
  console.error(`Design pattern check failed (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  if (failures.some((failure) => failure.includes('Chinese definition'))) {
    console.error('  Hint: run pnpm study:sync-glossary and commit learning/glossary.zh.json')
  }
  process.exitCode = 1
} else {
  console.log(`✓ Design pattern: ${htmlFiles.length} pages follow the IELTSY pattern`)
  console.log(`  Lessons: ${lessonFiles.length}`)
  console.log('  Source: design-system/ieltsy/pattern.css')
}
