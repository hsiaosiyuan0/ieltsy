import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const CIRCLED_NUM_TO_INT: Record<string, number> = Object.fromEntries(
  CIRCLED.split('').map((c, i) => [c, i + 1])
)

interface Sentence {
  num: number
  text: string
  zh?: string
}

interface TargetWord {
  word: string
  pos: string
  refs: string
}

interface GrammarExample {
  sentenceNum: number
  excerpt: string
  note: string
}

interface ParsedArticle {
  date: string
  title: string
  meta: string
  genre: string
  sentences: Sentence[]
  targetWords: TargetWord[]
  grammarTitle: string
  grammarDescription: string
  grammarExamples: GrammarExample[]
}

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'dist' },
    title: { type: 'string', default: 'IELTSY' },
  },
})

const OUT_DIR = resolve(values.out!)
const SITE_TITLE = values.title!

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

function parseArticleMd(date: string, md: string): ParsedArticle {
  const lines = md.split('\n')
  let title = ''
  let meta = ''
  let genre = ''
  const sentences: Sentence[] = []
  const targetWords: TargetWord[] = []
  let grammarTitle = ''
  let grammarDescription = ''
  const grammarExamples: GrammarExample[] = []

  let section: 'header' | 'article' | 'zh' | 'words' | 'grammar' | 'other' = 'header'

  for (const raw of lines) {
    const line = raw.trim()

    if (!title && line.startsWith('# ')) {
      title = line.slice(2).trim()
      continue
    }
    if (!meta && line.startsWith('> ')) {
      meta = line.slice(2).trim()
      const genreMatch = meta.match(/体裁:\s*([^|（(]+)/)
      if (genreMatch?.[1]) genre = genreMatch[1].trim()
      continue
    }

    if (line.startsWith('## 短文')) { section = 'article'; continue }
    if (line.startsWith('## 中文翻译') || line.startsWith('## 翻译')) { section = 'zh'; continue }
    if (line.startsWith('## 目标词覆盖')) { section = 'words'; continue }
    if (line.startsWith('## 语法点')) { section = 'grammar'; continue }
    if (line.startsWith('## ')) { section = 'other'; continue }

    if (section === 'article') {
      const m = line.match(/^([①-⑳])\s+(.+)$/)
      if (m) {
        sentences.push({ num: CIRCLED_NUM_TO_INT[m[1]!]!, text: m[2]!.trim() })
      }
    }

    if (section === 'zh') {
      const m = line.match(/^([①-⑳])\s+(.+)$/)
      if (m) {
        const found = sentences.find((s) => s.num === CIRCLED_NUM_TO_INT[m[1]!]!)
        if (found) found.zh = m[2]!.trim()
      }
    }

    if (section === 'words') {
      if (line.includes('---') || line.includes('| 词 |') || line.includes('| # |')) continue
      const m = line.match(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/)
      if (m) {
        targetWords.push({ word: m[1]!.trim(), pos: m[2]!.trim(), refs: m[3]!.trim() })
      }
    }

    if (section === 'grammar') {
      if (!grammarTitle && line.startsWith('**') && line.endsWith('**')) {
        const inner = line.slice(2, -2).trim()
        const dot = inner.indexOf('·')
        if (dot > 0) {
          grammarTitle = inner.slice(0, dot).replace(/[★]+/g, '').trim()
          grammarDescription = inner.slice(dot + 1).trim()
        } else {
          grammarTitle = inner.replace(/[★]+/g, '').trim()
        }
        continue
      }

      const m = line.match(/^-\s*句\s*([①-⑳])\s*[:：·]?\s*`?([^`]+?)`?\s*(?:——|--)\s*(.*)$/)
      if (m) {
        grammarExamples.push({
          sentenceNum: CIRCLED_NUM_TO_INT[m[1]!]!,
          excerpt: m[2]!.trim(),
          note: m[3]!.trim(),
        })
      }
    }
  }

  const titleGenre = title.split('·')[1]?.trim().toLowerCase()
  return {
    date,
    title,
    meta,
    genre: genre || titleGenre || 'lesson',
    sentences,
    targetWords,
    grammarTitle,
    grammarDescription,
    grammarExamples,
  }
}

function articleDisplayTitle(article: ParsedArticle): string {
  return article.title.split('·').slice(2).join('·').trim() || article.title.replace(/^#\s*/, '').trim() || article.date
}

function highlightTargets(text: string, targets: string[]): string {
  let result = escapeHtml(text)
  const sorted = [...targets].sort((a, b) => b.length - a.length)
  for (const word of sorted) {
    if (!word) continue
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`\\b(${safe}(?:s|es|ed|d|ing)?)\\b`, 'gi')
    result = result.replace(pattern, (_m, actual: string) => {
      const spoken = escapeHtml(actual)
      return `<span class="target" role="button" tabindex="0" data-speak="${spoken}" title="显示 / 朗读">${spoken}</span>`
    })
  }
  return result
}

function renderRefs(refs: string): string {
  return refs.split(/\s+/).filter(Boolean).map((tok) => {
    const num = CIRCLED_NUM_TO_INT[tok]
    if (num) return `<a href="#sentence-${num}" class="ref">${tok}</a>`
    return `<span class="ref">${escapeHtml(tok)}</span>`
  }).join(' ')
}

function renderShell(opts: {
  title: string
  description: string
  prefix: string
  current?: 'home' | 'mistakes'
  bodyAttrs?: string
  body: string
}): string {
  const navHome = opts.current === 'home' ? 'aria-current="page"' : ''
  const navMistakes = opts.current === 'mistakes' ? 'aria-current="page"' : ''
  const homeHref = opts.prefix || './'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHtml(opts.description)}">
  <meta name="theme-color" content="#0f766e">
  <title>${escapeHtml(opts.title)} · ${escapeHtml(SITE_TITLE)}</title>
  <link rel="stylesheet" href="${opts.prefix}assets/site.css">
  <link rel="manifest" href="${opts.prefix}manifest.webmanifest">
</head>
<body${opts.bodyAttrs ? ` ${opts.bodyAttrs}` : ''}>
  <header class="site-header">
    <a class="brand" href="${homeHref}">IELTSY</a>
    <nav class="nav" aria-label="主导航">
      <a href="${homeHref}" ${navHome}>学习日</a>
      <a href="${opts.prefix}mistakes/" ${navMistakes}>错题本</a>
    </nav>
  </header>
${opts.body}
  <script src="${opts.prefix}assets/site.js" defer></script>
</body>
</html>
`
}

function renderIndex(articles: ParsedArticle[]): string {
  const latest = articles[0]
  const totalWords = articles.reduce((sum, article) => sum + article.targetWords.length, 0)
  const latestTitle = latest ? articleDisplayTitle(latest) : '暂无学习日'
  const latestHref = latest ? `days/${latest.date}/` : '#'
  const lessonItems = articles.map((article) => {
    const title = articleDisplayTitle(article)
    return `        <a class="lesson-row" href="days/${article.date}/">
          <span class="lesson-date">${escapeHtml(article.date)}</span>
          <span class="lesson-main">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(article.genre)} · ${article.targetWords.length} 词 · ${escapeHtml(article.grammarTitle || '语法点')}</span>
          </span>
        </a>`
  }).join('\n')

  const body = `  <main>
    <section class="home-hero">
      <p class="eyebrow">GitHub Pages 静态学习版</p>
      <h1>${escapeHtml(SITE_TITLE)}</h1>
      <div class="hero-actions">
        <a class="primary-link" href="${latestHref}">继续最近一天</a>
        <a class="secondary-link" href="mistakes/">复习错题</a>
      </div>
    </section>

    <section class="metric-grid" aria-label="学习统计">
      <div class="metric"><span>${articles.length}</span><small>学习日</small></div>
      <div class="metric"><span>${totalWords}</span><small>目标词</small></div>
      <div class="metric"><span>${escapeHtml(latest?.date ?? '-')}</span><small>最近更新</small></div>
    </section>

    <section class="section-head">
      <h2>学习日</h2>
      <p>${escapeHtml(latestTitle)}</p>
    </section>

    <div class="lesson-list">
${lessonItems || '      <p class="empty">还没有可发布的 article.md。</p>'}
    </div>
  </main>`

  return renderShell({
    title: '学习日',
    description: 'IELTSY mobile study archive',
    prefix: '',
    current: 'home',
    body,
  })
}

function renderDay(article: ParsedArticle): string {
  const targets = article.targetWords.map((w) => w.word)
  const title = articleDisplayTitle(article)
  const metaParts = article.meta.split('|').map((part) => part.trim()).filter(Boolean)
  const sentencesHtml = article.sentences.map((sentence) => `          <p class="sentence" id="sentence-${sentence.num}" data-text="${escapeHtml(sentence.text)}">
            <button class="sentence-play" type="button" data-action="play-sentence" aria-label="朗读第 ${sentence.num} 句">▶</button>
            <span class="num">${CIRCLED[sentence.num - 1]}</span>
            <span class="sentence-text">
              <span class="en">${highlightTargets(sentence.text, targets)}</span>
              ${sentence.zh ? `<span class="zh">${escapeHtml(sentence.zh)}</span>` : ''}
            </span>
          </p>`).join('\n')

  const wordsHtml = article.targetWords.map((word, idx) => `            <li>
              <button type="button" class="word-button" data-speak="${escapeHtml(word.word)}">${idx + 1}. ${escapeHtml(word.word)}</button>
              <span class="pos">${escapeHtml(word.pos)}</span>
              <span class="refs">${renderRefs(word.refs)}</span>
            </li>`).join('\n')

  const grammarHtml = article.grammarExamples.map((example) => `            <li>
              <span class="sent-num">${CIRCLED[example.sentenceNum - 1]}</span>
              <code>${escapeHtml(example.excerpt)}</code>
              ${example.note ? `<span class="note">${escapeHtml(example.note)}</span>` : ''}
            </li>`).join('\n')

  const body = `  <main>
    <section class="lesson-hero">
      <a class="back-link" href="../../">← 学习日</a>
      <p class="eyebrow">${escapeHtml(article.date)} · ${escapeHtml(article.genre)}</p>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta-row">
        ${metaParts.map((part) => `<span>${escapeHtml(part)}</span>`).join('\n        ')}
      </div>
    </section>

    <section class="toolbelt" aria-label="学习工具">
      <button type="button" data-action="play-all">▶ 全文</button>
      <button type="button" data-action="toggle-zh" aria-pressed="false">译文</button>
      <button type="button" data-action="toggle-practice" aria-pressed="false">遮词</button>
      <label class="done-toggle">
        <input type="checkbox" data-action="mark-done">
        <span>完成</span>
      </label>
    </section>

    <div class="study-grid">
      <article class="reader" aria-label="短文">
${sentencesHtml}
      </article>

      <aside class="study-side" aria-label="目标词和语法点">
        <section>
          <h2>目标词</h2>
          <ol class="word-list">
${wordsHtml}
          </ol>
        </section>

        <section>
          <h2>语法点</h2>
          <p class="grammar-title">${escapeHtml(article.grammarTitle || '未记录')}</p>
          ${article.grammarDescription ? `<p class="grammar-desc">${escapeHtml(article.grammarDescription)}</p>` : ''}
          <ul class="grammar-list">
${grammarHtml}
          </ul>
        </section>
      </aside>
    </div>
  </main>`

  return renderShell({
    title,
    description: `${article.date} IELTSY lesson`,
    prefix: '../../',
    bodyAttrs: `data-date="${escapeHtml(article.date)}"`,
    body,
  })
}

function renderInlineMd(raw: string): string {
  let html = escapeHtml(raw)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return html
}

function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let listOpen = false

  function flushParagraph(): void {
    if (paragraph.length > 0) {
      html.push(`<p>${renderInlineMd(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }

  function closeList(): void {
    if (listOpen) {
      html.push('</ul>')
      listOpen = false
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      flushParagraph()
      closeList()
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      closeList()
      const level = heading[1]!.length + 1
      html.push(`<h${level}>${renderInlineMd(heading[2]!)}</h${level}>`)
      continue
    }

    if (trimmed.startsWith('> ')) {
      flushParagraph()
      closeList()
      html.push(`<blockquote>${renderInlineMd(trimmed.slice(2))}</blockquote>`)
      continue
    }

    if (trimmed.startsWith('- ')) {
      flushParagraph()
      if (!listOpen) {
        html.push('<ul>')
        listOpen = true
      }
      html.push(`<li>${renderInlineMd(trimmed.slice(2))}</li>`)
      continue
    }

    paragraph.push(trimmed)
  }

  flushParagraph()
  closeList()
  return html.join('\n')
}

function renderMistakesPage(kind: 'words' | 'grammar', markdown: string): string {
  const title = kind === 'words' ? '单词错题' : '语法错题'
  const body = `  <main>
    <section class="lesson-hero compact">
      <a class="back-link" href="../">← 学习日</a>
      <p class="eyebrow">Mistakes</p>
      <h1>${title}</h1>
    </section>
    <article class="markdown-body">
${renderMarkdown(markdown)}
    </article>
  </main>`

  return renderShell({
    title,
    description: `${SITE_TITLE} ${title}`,
    prefix: '../',
    current: 'mistakes',
    body,
  })
}

function renderMistakesIndex(): string {
  const body = `  <main>
    <section class="lesson-hero compact">
      <a class="back-link" href="../">← 学习日</a>
      <p class="eyebrow">Mistakes</p>
      <h1>错题本</h1>
    </section>
    <div class="lesson-list">
      <a class="lesson-row" href="words.html">
        <span class="lesson-date">Words</span>
        <span class="lesson-main"><strong>单词错题</strong><span>最近答错的目标词</span></span>
      </a>
      <a class="lesson-row" href="grammar.html">
        <span class="lesson-date">Grammar</span>
        <span class="lesson-main"><strong>语法错题</strong><span>需要回看的语法点</span></span>
      </a>
    </div>
  </main>`

  return renderShell({
    title: '错题本',
    description: `${SITE_TITLE} mistake archive`,
    prefix: '../',
    current: 'mistakes',
    body,
  })
}

function renderNotFound(): string {
  return renderShell({
    title: '页面不存在',
    description: `${SITE_TITLE} not found`,
    prefix: '',
    body: `  <main>
    <section class="home-hero">
      <p class="eyebrow">404</p>
      <h1>页面不存在</h1>
      <div class="hero-actions"><a class="primary-link" href="./">返回首页</a></div>
    </section>
  </main>`,
  })
}

function discoverArticles(): ParsedArticle[] {
  const daysDir = resolve('learning/days')
  if (!existsSync(daysDir)) return []

  const articles: ParsedArticle[] = []
  for (const entry of readdirSync(daysDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue
    const articlePath = join(daysDir, entry.name, 'article.md')
    if (!existsSync(articlePath)) continue
    const parsed = parseArticleMd(entry.name, readFileSync(articlePath, 'utf-8'))
    articles.push(parsed)
  }

  return articles.sort((a, b) => b.date.localeCompare(a.date))
}

function writePage(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

const SITE_CSS = `:root {
  color-scheme: light;
  --bg: #f6f8fb;
  --panel: #ffffff;
  --panel-soft: #eef6f4;
  --text: #18212f;
  --muted: #667085;
  --line: #d9e2ec;
  --accent: #0f766e;
  --accent-dark: #115e59;
  --target: #b45309;
  --target-bg: #fff4d6;
  --indigo: #4f46e5;
  --shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
}

* { box-sizing: border-box; }
html { font-size: 16px; }
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.6;
}
a { color: inherit; }
button, input { font: inherit; }

.site-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.8rem clamp(1rem, 4vw, 2.5rem);
  background: rgba(246, 248, 251, 0.9);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(16px);
}
.brand {
  color: var(--accent-dark);
  font-size: 1.05rem;
  font-weight: 800;
  letter-spacing: 0;
  text-decoration: none;
}
.nav { display: flex; gap: 0.4rem; }
.nav a {
  border-radius: 999px;
  color: var(--muted);
  padding: 0.42rem 0.7rem;
  text-decoration: none;
}
.nav a[aria-current="page"] {
  background: var(--panel-soft);
  color: var(--accent-dark);
  font-weight: 700;
}

main {
  width: min(1120px, calc(100% - 2rem));
  margin: 0 auto;
  padding: clamp(1.2rem, 4vw, 3rem) 0 4rem;
}
.home-hero, .lesson-hero {
  padding: clamp(1.4rem, 4vw, 3rem) 0 clamp(1rem, 3vw, 2rem);
}
.home-hero h1, .lesson-hero h1 {
  margin: 0;
  max-width: 820px;
  font-size: clamp(2rem, 7vw, 4.8rem);
  line-height: 0.98;
  letter-spacing: 0;
}
.lesson-hero h1 { font-size: clamp(1.9rem, 5vw, 3.8rem); }
.lesson-hero.compact h1 { font-size: clamp(2rem, 6vw, 4rem); }
.eyebrow {
  margin: 0 0 0.75rem;
  color: var(--accent-dark);
  font-size: 0.8rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.back-link {
  display: inline-flex;
  margin-bottom: 1.1rem;
  color: var(--muted);
  font-weight: 700;
  text-decoration: none;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1.4rem;
}
.primary-link, .secondary-link, .toolbelt button, .done-toggle {
  min-height: 2.6rem;
  border-radius: 8px;
  border: 1px solid var(--line);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.55rem 0.9rem;
  font-weight: 750;
  text-decoration: none;
}
.primary-link {
  background: var(--accent);
  border-color: var(--accent);
  color: white;
}
.secondary-link, .toolbelt button, .done-toggle {
  background: var(--panel);
  color: var(--text);
}
.toolbelt button[aria-pressed="true"] {
  border-color: var(--accent);
  background: var(--panel-soft);
  color: var(--accent-dark);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.8rem;
  margin: 0 0 2rem;
}
.metric {
  min-height: 6rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 1rem;
  box-shadow: var(--shadow);
}
.metric span {
  display: block;
  font-size: clamp(1.4rem, 5vw, 2.1rem);
  font-weight: 850;
}
.metric small { color: var(--muted); font-weight: 700; }

.section-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  margin: 2rem 0 0.8rem;
}
.section-head h2 { margin: 0; font-size: 1.1rem; }
.section-head p { margin: 0; color: var(--muted); }
.lesson-list {
  display: grid;
  gap: 0.65rem;
}
.lesson-row {
  display: grid;
  grid-template-columns: 8.5rem minmax(0, 1fr);
  gap: 1rem;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 0.85rem 1rem;
  text-decoration: none;
}
.lesson-row:hover { border-color: #9abeb7; }
.lesson-date {
  color: var(--accent-dark);
  font-weight: 850;
}
.lesson-main { min-width: 0; display: grid; gap: 0.12rem; }
.lesson-main strong {
  overflow-wrap: anywhere;
  line-height: 1.25;
}
.lesson-main span {
  color: var(--muted);
  font-size: 0.92rem;
}
.empty { color: var(--muted); }

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 1rem;
}
.meta-row span {
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  padding: 0.35rem 0.65rem;
  font-size: 0.9rem;
  font-weight: 700;
}
.toolbelt {
  position: sticky;
  top: 3.8rem;
  z-index: 8;
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
  align-items: center;
  margin-bottom: 1rem;
  padding: 0.7rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(16px);
}
.done-toggle input { width: 1rem; height: 1rem; accent-color: var(--accent); }

.study-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  gap: 1rem;
  align-items: start;
}
.reader, .study-side, .markdown-body {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: var(--shadow);
}
.reader { padding: clamp(1rem, 3vw, 2rem); }
.sentence {
  display: grid;
  grid-template-columns: 2.1rem 2rem minmax(0, 1fr);
  gap: 0.4rem;
  align-items: start;
  margin: 0;
  padding: 0.85rem 0;
  border-bottom: 1px solid #edf1f6;
}
.sentence:last-child { border-bottom: 0; }
.sentence-play {
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  color: var(--accent-dark);
  cursor: pointer;
}
.num {
  color: var(--indigo);
  font-weight: 850;
  line-height: 2rem;
}
.sentence-text {
  min-width: 0;
  display: grid;
  gap: 0.35rem;
}
.en {
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(1.08rem, 2vw, 1.28rem);
  line-height: 1.75;
}
.zh {
  color: var(--muted);
  font-size: 0.96rem;
  line-height: 1.65;
}
body.hide-zh .zh { display: none; }
.target {
  border: 0;
  border-radius: 0.35rem;
  background: var(--target-bg);
  color: var(--target);
  cursor: pointer;
  font-weight: 800;
  padding: 0.05rem 0.16rem;
}
body.practice .target {
  color: transparent;
  text-shadow: none;
  border-bottom: 2px solid var(--target);
  background: transparent;
}
body.practice .target.revealed {
  color: var(--target);
  background: var(--target-bg);
  border-bottom-color: transparent;
}

.study-side {
  position: sticky;
  top: 8.8rem;
  display: grid;
  gap: 1.4rem;
  padding: 1rem;
}
.study-side h2 {
  margin: 0 0 0.7rem;
  font-size: 1rem;
}
.word-list {
  list-style: none;
  display: grid;
  gap: 0.45rem;
  margin: 0;
  padding: 0;
}
.word-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.4rem;
  align-items: center;
}
.word-button {
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  overflow-wrap: anywhere;
  padding: 0;
  text-align: left;
  font-weight: 800;
}
.pos {
  border-radius: 999px;
  background: #eef2ff;
  color: #3730a3;
  padding: 0.12rem 0.4rem;
  font-size: 0.78rem;
  font-weight: 800;
}
.refs { display: flex; gap: 0.2rem; }
.ref {
  color: var(--accent-dark);
  font-weight: 800;
  text-decoration: none;
}
.grammar-title {
  margin: 0 0 0.3rem;
  font-weight: 850;
}
.grammar-desc {
  margin: 0 0 0.8rem;
  color: var(--muted);
}
.grammar-list {
  display: grid;
  gap: 0.6rem;
  margin: 0;
  padding-left: 1.1rem;
}
.grammar-list code, .markdown-body code {
  border-radius: 0.3rem;
  background: #f1f5f9;
  padding: 0.1rem 0.25rem;
}
.grammar-list .note {
  display: block;
  color: var(--muted);
  font-size: 0.92rem;
}

.markdown-body {
  padding: clamp(1rem, 3vw, 2rem);
}
.markdown-body h2, .markdown-body h3, .markdown-body h4 {
  margin: 1.2rem 0 0.5rem;
}
.markdown-body h2:first-child { margin-top: 0; }
.markdown-body blockquote {
  margin: 0.8rem 0;
  border-left: 4px solid var(--accent);
  color: var(--muted);
  padding-left: 0.8rem;
}

@media (max-width: 860px) {
  main { width: min(100% - 1rem, 720px); }
  .metric-grid { grid-template-columns: 1fr; }
  .section-head { display: block; }
  .lesson-row { grid-template-columns: 1fr; gap: 0.3rem; }
  .toolbelt { top: 3.45rem; }
  .study-grid { grid-template-columns: 1fr; }
  .study-side { position: static; }
  .sentence { grid-template-columns: 2rem minmax(0, 1fr); }
  .sentence-play { grid-row: span 2; }
  .num { grid-column: 2; line-height: 1.2; }
  .sentence-text { grid-column: 2; }
  .word-list li { grid-template-columns: minmax(0, 1fr) auto; }
  .refs { grid-column: 1 / -1; }
}
`

const SITE_JS = `(() => {
  const storage = {
    get(key) {
      try { return window.localStorage.getItem(key) } catch { return null }
    },
    set(key, value) {
      try { window.localStorage.setItem(key, value) } catch {}
    },
  }

  function speak(text) {
    if (!text || !('speechSynthesis' in window)) return
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    utterance.rate = 0.9
    window.speechSynthesis.speak(utterance)
  }

  function setPressed(action, pressed) {
    document.querySelectorAll('[data-action="' + action + '"]').forEach((button) => {
      button.setAttribute('aria-pressed', String(pressed))
    })
  }

  function syncControls() {
    setPressed('toggle-zh', !document.body.classList.contains('hide-zh'))
    setPressed('toggle-practice', document.body.classList.contains('practice'))
  }

  const date = document.body.dataset.date
  const doneInput = document.querySelector('[data-action="mark-done"]')

  if (storage.get('ieltsy:show-zh') === '0') document.body.classList.add('hide-zh')
  if (storage.get('ieltsy:practice') === '1') document.body.classList.add('practice')
  if (date && doneInput instanceof HTMLInputElement) {
    doneInput.checked = storage.get('ieltsy:done:' + date) === '1'
  }
  syncControls()

  document.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const speakable = target.closest('[data-speak]')
    if (speakable) {
      if (document.body.classList.contains('practice') && speakable.classList.contains('target')) {
        speakable.classList.add('revealed')
      }
      speak(speakable.getAttribute('data-speak') || speakable.textContent || '')
      event.stopPropagation()
      return
    }

    const action = target.closest('[data-action]')
    const actionName = action?.getAttribute('data-action')

    if (actionName === 'play-all') {
      const text = Array.from(document.querySelectorAll('.sentence')).map((node) => node.getAttribute('data-text')).filter(Boolean).join(' ')
      speak(text)
      return
    }

    if (actionName === 'play-sentence') {
      const sentence = action?.closest('.sentence')
      speak(sentence?.getAttribute('data-text') || '')
      return
    }

    if (actionName === 'toggle-zh') {
      document.body.classList.toggle('hide-zh')
      storage.set('ieltsy:show-zh', document.body.classList.contains('hide-zh') ? '0' : '1')
      syncControls()
      return
    }

    if (actionName === 'toggle-practice') {
      document.body.classList.toggle('practice')
      document.querySelectorAll('.target.revealed').forEach((node) => node.classList.remove('revealed'))
      storage.set('ieltsy:practice', document.body.classList.contains('practice') ? '1' : '0')
      syncControls()
      return
    }

    const sentence = target.closest('.sentence')
    if (sentence && !target.closest('a, button, input')) {
      speak(sentence.getAttribute('data-text') || '')
    }
  })

  document.addEventListener('change', (event) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    if (target.getAttribute('data-action') === 'mark-done' && date) {
      storage.set('ieltsy:done:' + date, target.checked ? '1' : '0')
    }
  })

  document.addEventListener('keydown', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (!target.classList.contains('target')) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
})()
`

function main(): void {
  const articles = discoverArticles()
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(join(OUT_DIR, 'assets'), { recursive: true })

  writePage(join(OUT_DIR, '.nojekyll'), '')
  writePage(join(OUT_DIR, 'assets/site.css'), SITE_CSS)
  writePage(join(OUT_DIR, 'assets/site.js'), SITE_JS)
  writePage(join(OUT_DIR, 'manifest.webmanifest'), JSON.stringify({
    name: SITE_TITLE,
    short_name: SITE_TITLE,
    start_url: './',
    display: 'standalone',
    background_color: '#f6f8fb',
    theme_color: '#0f766e',
  }, null, 2))

  writePage(join(OUT_DIR, 'index.html'), renderIndex(articles))
  writePage(join(OUT_DIR, '404.html'), renderNotFound())

  for (const article of articles) {
    writePage(join(OUT_DIR, 'days', article.date, 'index.html'), renderDay(article))
  }

  writePage(join(OUT_DIR, 'mistakes', 'index.html'), renderMistakesIndex())
  for (const kind of ['words', 'grammar'] as const) {
    const file = resolve('learning/mistakes', `${kind}.md`)
    const markdown = existsSync(file) ? readFileSync(file, 'utf-8') : `# ${kind}\n\n_暂无错题。_`
    writePage(join(OUT_DIR, 'mistakes', `${kind}.html`), renderMistakesPage(kind, markdown))
  }

  const latest = articles[0]?.date ?? 'none'
  console.log(`✓ Exported ${articles.length} lessons to ${OUT_DIR}`)
  console.log(`  Latest: ${latest}`)
  console.log(`  Open: ${join(OUT_DIR, 'index.html')}`)
}

main()
