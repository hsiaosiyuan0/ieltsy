import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const DAYS_DIR = resolve('learning/days')
const REQUIRED_SECTIONS = ['批改标记', '逐句对照', '优先复习', '备注']

interface ArticleShape {
  sentenceLabels: string[]
  wordCount: number
}

export interface DictationAttempt {
  articleDate: string
  attemptNumber: number
  practicedAt: string
  correctWords: number
  totalWords: number
  accuracy: number
  passed: boolean
  result: string
  sentenceCount: number
  markdown: string
  bodyMarkdown: string
  sourcePath: string
  relativePath: string
}

export interface DictationLibrary {
  attempts: DictationAttempt[]
  byDate: Map<string, DictationAttempt[]>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function roundedAccuracy(correct: number, total: number): number {
  return Math.round((correct / total) * 1000) / 10
}

function readArticleShape(articlePath: string): ArticleShape {
  const markdown = readFileSync(articlePath, 'utf-8')
  const articleStart = markdown.indexOf('## 短文')
  const translationStart = markdown.indexOf('## 中文翻译', articleStart + 1)
  assert(articleStart >= 0 && translationStart > articleStart, `${articlePath}: cannot locate the English article section`)
  const articleBody = markdown.slice(articleStart, translationStart)
  const sentenceLabels = [...articleBody.matchAll(/^([①-⑳])\s+.+$/gm)].map((match) => match[1]!)
  assert(sentenceLabels.length > 0, `${articlePath}: no circled English sentences found`)
  const wordCount = (articleBody.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length
  assert(wordCount > 0, `${articlePath}: English article has no countable words`)
  return { sentenceLabels, wordCount }
}

function parseAttempt(articleDate: string, sourcePath: string, article: ArticleShape): DictationAttempt {
  const fileName = basename(sourcePath)
  const fileAttempt = Number.parseInt(fileName.match(/^attempt-(\d{2})\.md$/)?.[1] ?? '', 10)
  assert(Number.isInteger(fileAttempt) && fileAttempt > 0, `${sourcePath}: filename must use attempt-NN.md`)
  const markdown = readFileSync(sourcePath, 'utf-8')
  const heading = markdown.match(/^#\s+(\d{4}-\d{2}-\d{2})\s+·\s+Whole Dictation\s+·\s+Attempt\s+(\d+)\s*$/m)
  assert(heading, `${sourcePath}: invalid dictation heading`)
  assert(heading[1] === articleDate, `${sourcePath}: heading date must match its lesson directory`)
  const attemptNumber = Number.parseInt(heading[2]!, 10)
  assert(attemptNumber === fileAttempt, `${sourcePath}: heading attempt must match filename`)

  const metaLine = markdown.match(/^>\s+练习时间:\s*([^|]+?)\s*\|\s*正确:\s*(\d+)\/(\d+)\s*\|\s*准确率:\s*([\d.]+)%\s*\|\s*结果:\s*(通过|未通过)\s*$/m)
  assert(metaLine, `${sourcePath}: invalid dictation metadata`)
  const practicedAt = metaLine[1]!.trim()
  assert(/^\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?$/.test(practicedAt), `${sourcePath}: 练习时间 must use YYYY-MM-DD or YYYY-MM-DD HH:mm`)
  assert(practicedAt.slice(0, 10) >= articleDate, `${sourcePath}: 练习时间 cannot be earlier than the lesson`)
  const correctWords = Number.parseInt(metaLine[2]!, 10)
  const totalWords = Number.parseInt(metaLine[3]!, 10)
  const accuracy = Number.parseFloat(metaLine[4]!)
  const result = metaLine[5]!
  assert(totalWords > 0, `${sourcePath}: total words must be positive`)
  assert(totalWords === article.wordCount, `${sourcePath}: total words must equal the ${article.wordCount}-word source article`)
  assert(correctWords >= 0 && correctWords <= totalWords, `${sourcePath}: correct words must be within 0..total`)
  assert(accuracy === roundedAccuracy(correctWords, totalWords), `${sourcePath}: accuracy must equal correct/total rounded to one decimal`)
  const passed = accuracy > 80
  assert((passed ? '通过' : '未通过') === result, `${sourcePath}: result must follow the >80% passing rule`)

  for (const section of REQUIRED_SECTIONS) {
    assert(new RegExp(`^##\\s+${section}\\s*$`, 'm').test(markdown), `${sourcePath}: missing ## ${section}`)
  }
  const sentenceLabels = [...markdown.matchAll(/^###\s+([①-⑳])\s*$/gm)].map((match) => match[1]!)
  assert(
    sentenceLabels.length === article.sentenceLabels.length,
    `${sourcePath}: expected ${article.sentenceLabels.length} sentence corrections, found ${sentenceLabels.length}`
  )
  for (const [index, label] of sentenceLabels.entries()) {
    assert(label === article.sentenceLabels[index], `${sourcePath}: sentence corrections must follow the source order`)
  }
  const sentenceCount = sentenceLabels.length

  const bodyMarkdown = markdown
    .replace(/^#\s+.+\n+/, '')
    .replace(/^>\s+练习时间:.+\n+/, '')
    .trim()

  return {
    articleDate,
    attemptNumber,
    practicedAt,
    correctWords,
    totalWords,
    accuracy,
    passed,
    result,
    sentenceCount,
    markdown,
    bodyMarkdown,
    sourcePath,
    relativePath: `learning/days/${articleDate}/dictations/${fileName}`,
  }
}

export function discoverDictationLibrary(): DictationLibrary {
  const attempts: DictationAttempt[] = []
  if (!existsSync(DAYS_DIR)) return { attempts, byDate: new Map() }

  const dayEntries = readdirSync(DAYS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  for (const day of dayEntries) {
    const articlePath = join(DAYS_DIR, day.name, 'article.md')
    const dictationsDir = join(DAYS_DIR, day.name, 'dictations')
    if (!existsSync(dictationsDir)) continue
    assert(existsSync(articlePath), `${dictationsDir}: dictation attempts require article.md`)
    const article = readArticleShape(articlePath)
    const files = readdirSync(dictationsDir)
      .filter((file) => file.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    for (const file of files) attempts.push(parseAttempt(day.name, join(dictationsDir, file), article))
  }

  const byDate = new Map<string, DictationAttempt[]>()
  for (const attempt of attempts) {
    const group = byDate.get(attempt.articleDate) ?? []
    group.push(attempt)
    byDate.set(attempt.articleDate, group)
  }

  for (const [date, group] of byDate) {
    group.sort((a, b) => a.attemptNumber - b.attemptNumber)
    for (const [index, attempt] of group.entries()) {
      assert(attempt.attemptNumber === index + 1, `${date}: attempts must be contiguous from attempt-01.md`)
    }
  }

  attempts.sort((a, b) => {
    const dateOrder = b.articleDate.localeCompare(a.articleDate)
    return dateOrder || b.attemptNumber - a.attemptNumber
  })
  return { attempts, byDate }
}

export function nextDictationAttempt(date: string, library = discoverDictationLibrary()): { number: number; path: string } {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(date), 'date must use YYYY-MM-DD')
  assert(existsSync(join(DAYS_DIR, date, 'article.md')), `${date}: article.md is missing`)
  const number = (library.byDate.get(date)?.length ?? 0) + 1
  return {
    number,
    path: `learning/days/${date}/dictations/attempt-${String(number).padStart(2, '0')}.md`,
  }
}
