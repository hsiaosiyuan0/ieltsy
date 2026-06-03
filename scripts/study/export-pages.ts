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

function icon(name: 'book' | 'home' | 'archive' | 'arrow-left' | 'play' | 'translate' | 'eye' | 'check' | 'calendar' | 'layers'): string {
  const paths: Record<typeof name, string> = {
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>',
    archive: '<path d="M3 5h18"/><path d="M5 5v14h14V5"/><path d="M9 9h6"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    play: '<path d="m8 5 11 7-11 7V5z"/>',
    translate: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="M22 22l-5-10-5 10"/><path d="M14 18h6"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  }
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`
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
  <a class="skip-link" href="#content">跳到正文</a>
  <header class="ledger-shell">
    <a class="brand" href="${homeHref}" aria-label="IELTSY 首页">
      <span class="brand-mark">${icon('book')}</span>
      <span>IELTSY</span>
    </a>
    <nav class="nav" aria-label="主导航">
      <a href="${homeHref}" ${navHome}>${icon('home')}<span>学习日</span></a>
      <a href="${opts.prefix}mistakes/" ${navMistakes}>${icon('archive')}<span>错题本</span></a>
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
    return `        <a class="ledger-row" href="days/${article.date}/">
          <span class="date-rail">${escapeHtml(article.date)}</span>
          <span class="row-main">
            <strong>${escapeHtml(title)}</strong>
            <span>${escapeHtml(article.genre)} · ${article.targetWords.length} 词 · ${escapeHtml(article.grammarTitle || '语法点')}</span>
          </span>
          <span class="row-cue">${icon('arrow-left')}</span>
        </a>`
  }).join('\n')

  const body = `  <main id="content" class="page home-ledger">
    <section class="ledger-cover">
      <div>
        <p class="eyebrow">Study Ledger</p>
        <h1>${escapeHtml(SITE_TITLE)}</h1>
      </div>
      <div class="cover-actions">
        <a class="command primary" href="${latestHref}">${icon('play')}<span>继续</span></a>
        <a class="command" href="mistakes/">${icon('archive')}<span>错题</span></a>
      </div>
    </section>

    <section class="ledger-metrics" aria-label="学习统计">
      <div><span>${articles.length}</span><small>学习日</small></div>
      <div><span>${totalWords}</span><small>目标词</small></div>
      <div><span>${escapeHtml(latest?.date ?? '-')}</span><small>最近更新</small></div>
    </section>

    <section class="section-head compact">
      <h2>学习日</h2>
      <p>${escapeHtml(latestTitle)}</p>
    </section>

    <div class="ledger-list">
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
            <button class="sentence-play" type="button" data-action="play-sentence" aria-label="朗读第 ${sentence.num} 句">${icon('play')}</button>
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

  const body = `  <main id="content" class="page lesson-page">
    <section class="lesson-cover">
      <a class="back-link" href="../../">${icon('arrow-left')}<span>学习日</span></a>
      <div class="cover-grid">
        <div>
          <p class="eyebrow">${escapeHtml(article.date)} · ${escapeHtml(article.genre)}</p>
          <h1>${escapeHtml(title)}</h1>
        </div>
        <div class="meta-stack">
          ${metaParts.map((part) => `<span>${escapeHtml(part)}</span>`).join('\n          ')}
        </div>
      </div>
    </section>

    <section class="command-bar" aria-label="学习工具">
      <button class="command primary" type="button" data-action="play-all">${icon('play')}<span>全文</span></button>
      <button class="command" type="button" data-action="toggle-zh" aria-pressed="false">${icon('translate')}<span>译文</span></button>
      <button class="command" type="button" data-action="toggle-practice" aria-pressed="false">${icon('eye')}<span>遮词</span></button>
      <label class="done-toggle">
        <input type="checkbox" data-action="mark-done">
        ${icon('check')}
        <span>完成</span>
      </label>
    </section>

    <div class="lesson-grid">
      <article class="reader" aria-label="短文">
${sentencesHtml}
      </article>

      <aside class="study-panels" aria-label="目标词和语法点">
        <section class="study-panel">
          <h2>目标词</h2>
          <ol class="word-list">
${wordsHtml}
          </ol>
        </section>

        <section class="study-panel">
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
  const body = `  <main id="content" class="page mistakes-page">
    <section class="lesson-cover compact">
      <a class="back-link" href="../">${icon('arrow-left')}<span>学习日</span></a>
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
  const body = `  <main id="content" class="page mistakes-page">
    <section class="lesson-cover compact">
      <a class="back-link" href="../">${icon('arrow-left')}<span>学习日</span></a>
      <p class="eyebrow">Mistakes</p>
      <h1>错题本</h1>
    </section>
    <div class="ledger-list">
      <a class="ledger-row" href="words.html">
        <span class="date-rail">Words</span>
        <span class="row-main"><strong>单词错题</strong><span>最近答错的目标词</span></span>
        <span class="row-cue">${icon('arrow-left')}</span>
      </a>
      <a class="ledger-row" href="grammar.html">
        <span class="date-rail">Grammar</span>
        <span class="row-main"><strong>语法错题</strong><span>需要回看的语法点</span></span>
        <span class="row-cue">${icon('arrow-left')}</span>
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
    body: `  <main id="content" class="page home-ledger">
    <section class="ledger-cover">
      <p class="eyebrow">404</p>
      <h1>页面不存在</h1>
      <div class="cover-actions"><a class="command primary" href="./">${icon('home')}<span>返回首页</span></a></div>
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
  --canvas: #f7f8f5;
  --paper: #ffffff;
  --paper-quiet: #f1f4ef;
  --ink: #171a1f;
  --ink-soft: #4e5661;
  --ink-faint: #77808b;
  --rule: #d8ded6;
  --rule-strong: #aeb8ae;
  --accent: #0f766e;
  --accent-ink: #0b4f4a;
  --study: #4f46e5;
  --review: #b45309;
  --review-bg: #fff2cc;
  --success: #15803d;
  --danger: #b91c1c;
  --radius: 8px;
  --page: min(1180px, calc(100% - 32px));
  --transition: 150ms ease-out;
}

* { box-sizing: border-box; }
html {
  min-width: 320px;
  scroll-padding-top: 96px;
  font-size: 16px;
}
body {
  margin: 0;
  min-height: 100vh;
  background: var(--canvas);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.55;
  text-rendering: optimizeLegibility;
}
a { color: inherit; }
button, input { font: inherit; }
button, a, label { -webkit-tap-highlight-color: transparent; }
button { cursor: pointer; }

.skip-link {
  position: fixed;
  left: 16px;
  top: 10px;
  z-index: 30;
  translate: 0 -150%;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--paper);
  color: var(--accent-ink);
  padding: 10px 12px;
  font-weight: 800;
}
.skip-link:focus { translate: 0 0; }

.icon {
  width: 1.05em;
  height: 1.05em;
  flex: 0 0 auto;
}

.ledger-shell {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 60px;
  padding: 8px max(16px, calc((100vw - 1180px) / 2));
  background: var(--canvas);
  border-bottom: 1px solid var(--rule);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  color: var(--ink);
  font-weight: 900;
  letter-spacing: 0;
  text-decoration: none;
}
.brand-mark {
  display: inline-grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  background: var(--paper);
  color: var(--accent-ink);
}
.nav {
  display: flex;
  gap: 6px;
}
.nav a {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 44px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--ink-soft);
  padding: 0 12px;
  text-decoration: none;
  transition: background var(--transition), border-color var(--transition), color var(--transition);
}
.nav a:hover {
  border-color: var(--rule);
  background: var(--paper);
  color: var(--ink);
}
.nav a[aria-current="page"] {
  border-color: var(--rule-strong);
  background: var(--paper-quiet);
  color: var(--accent-ink);
  font-weight: 800;
}

.page {
  width: var(--page);
  margin: 0 auto;
  padding: clamp(20px, 4vw, 46px) 0 56px;
}

.ledger-cover, .lesson-cover {
  display: grid;
  gap: 18px;
  padding: 0 0 clamp(18px, 3vw, 32px);
}
.ledger-cover {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  border-bottom: 1px solid var(--rule);
}
.lesson-cover {
  border-bottom: 1px solid var(--rule);
}
.lesson-cover.compact {
  max-width: 760px;
}
.cover-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 320px);
  gap: 18px;
  align-items: end;
}
.eyebrow {
  margin: 0 0 10px;
  color: var(--accent-ink);
  font-size: 0.78rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  color: var(--ink);
  font-size: clamp(2rem, 5vw, 4.4rem);
  line-height: 0.98;
  letter-spacing: 0;
  max-width: 920px;
}
.lesson-cover h1 {
  font-size: clamp(1.95rem, 4vw, 3.8rem);
}
.cover-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  width: fit-content;
  color: var(--ink-soft);
  font-weight: 800;
  text-decoration: none;
}
.back-link:hover {
  color: var(--accent-ink);
}

.command, .done-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 44px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper);
  color: var(--ink);
  padding: 0 13px;
  font-weight: 850;
  line-height: 1;
  text-decoration: none;
  transition: background var(--transition), border-color var(--transition), color var(--transition);
}
.command:hover, .done-toggle:hover {
  border-color: var(--rule-strong);
  background: var(--paper-quiet);
}
.command.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: white;
}
.command[aria-pressed="true"] {
  border-color: var(--accent);
  background: var(--paper-quiet);
  color: var(--accent-ink);
}
.done-toggle {
  cursor: pointer;
}
.done-toggle input {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  overflow: hidden;
}
.done-toggle:has(input:checked) {
  border-color: var(--success);
  background: #eef8ef;
  color: var(--success);
}

.ledger-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 16px 0 28px;
}
.ledger-metrics div {
  min-height: 88px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper);
  padding: 14px;
}
.ledger-metrics span {
  display: block;
  font-size: clamp(1.35rem, 3vw, 2.25rem);
  font-weight: 900;
  line-height: 1.1;
}
.ledger-metrics small {
  color: var(--ink-faint);
  font-size: 0.82rem;
  font-weight: 800;
}

.section-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  align-items: end;
  margin: 0 0 10px;
}
.section-head h2 {
  margin: 0;
  font-size: 1rem;
}
.section-head p {
  margin: 0;
  color: var(--ink-faint);
  overflow-wrap: anywhere;
}

.ledger-list {
  display: grid;
  gap: 8px;
}
.ledger-row {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr) 36px;
  gap: 14px;
  align-items: center;
  min-height: 76px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper);
  padding: 12px 14px;
  text-decoration: none;
  cursor: pointer;
  transition: background var(--transition), border-color var(--transition);
}
.ledger-row:hover {
  border-color: var(--rule-strong);
  background: #fbfcfa;
}
.date-rail {
  color: var(--accent-ink);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.86rem;
  font-weight: 900;
}
.row-main {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.row-main strong {
  color: var(--ink);
  line-height: 1.25;
  overflow-wrap: anywhere;
}
.row-main span {
  color: var(--ink-faint);
  font-size: 0.9rem;
}
.row-cue {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  color: var(--ink-faint);
  transform: rotate(180deg);
}
.empty {
  color: var(--ink-faint);
}

.meta-stack {
  display: grid;
  gap: 6px;
  align-content: end;
}
.meta-stack span {
  border-left: 3px solid var(--rule-strong);
  color: var(--ink-soft);
  padding-left: 10px;
  font-size: 0.9rem;
  font-weight: 750;
}

.command-bar {
  position: sticky;
  top: 61px;
  z-index: 15;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 14px 0;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--canvas);
  padding: 8px;
}

.lesson-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  gap: 16px;
  align-items: start;
}
.reader, .study-panel, .markdown-body {
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper);
}
.reader {
  padding: clamp(14px, 3vw, 28px);
}
.sentence {
  display: grid;
  grid-template-columns: 44px 30px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  margin: 0;
  padding: 13px 0;
  border-bottom: 1px solid #ecefeb;
}
.sentence:last-child { border-bottom: 0; }
.sentence-play {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper);
  color: var(--accent-ink);
  transition: background var(--transition), border-color var(--transition);
}
.sentence-play:hover {
  border-color: var(--accent);
  background: var(--paper-quiet);
}
.num {
  color: var(--study);
  font-weight: 900;
  line-height: 44px;
}
.sentence-text {
  min-width: 0;
  display: grid;
  gap: 5px;
}
.en {
  color: var(--ink);
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.18rem;
  line-height: 1.78;
}
.zh {
  color: var(--ink-soft);
  font-size: 0.96rem;
  line-height: 1.7;
}
body.hide-zh .zh { display: none; }

.target {
  border-radius: 5px;
  background: var(--review-bg);
  color: var(--review);
  cursor: pointer;
  font-weight: 850;
  padding: 0.04rem 0.18rem;
}
body.practice .target {
  color: transparent;
  text-shadow: none;
  border-bottom: 2px solid var(--review);
  background: transparent;
}
body.practice .target.revealed {
  color: var(--review);
  border-bottom-color: transparent;
  background: var(--review-bg);
}

.study-panels {
  position: sticky;
  top: 132px;
  display: grid;
  gap: 12px;
}
.study-panel {
  padding: 14px;
}
.study-panel h2 {
  margin: 0 0 10px;
  font-size: 1rem;
}
.word-list {
  list-style: none;
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
}
.word-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 8px;
  align-items: center;
  border-bottom: 1px solid #eef1ed;
  padding: 0 0 7px;
}
.word-list li:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}
.word-button {
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
  overflow-wrap: anywhere;
  padding: 5px 0;
  text-align: left;
  font-weight: 850;
}
.word-button:hover {
  color: var(--review);
}
.pos {
  border: 1px solid #d9dcff;
  border-radius: 999px;
  background: #f4f4ff;
  color: #3730a3;
  padding: 0.08rem 0.42rem;
  font-size: 0.76rem;
  font-weight: 900;
}
.refs {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.ref {
  color: var(--accent-ink);
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.78rem;
  font-weight: 900;
  text-decoration: none;
}
.ref:hover {
  text-decoration: underline;
}
.grammar-title {
  margin: 0 0 4px;
  font-weight: 900;
}
.grammar-desc {
  margin: 0 0 10px;
  color: var(--ink-soft);
}
.grammar-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding-left: 18px;
}
.grammar-list code, .markdown-body code {
  border: 1px solid var(--rule);
  border-radius: 5px;
  background: var(--paper-quiet);
  padding: 0.08rem 0.25rem;
}
.grammar-list .note {
  display: block;
  color: var(--ink-soft);
  font-size: 0.92rem;
}

.markdown-body {
  max-width: 820px;
  padding: clamp(16px, 3vw, 30px);
}
.markdown-body h2, .markdown-body h3, .markdown-body h4 {
  margin: 1.25rem 0 0.5rem;
}
.markdown-body h2:first-child { margin-top: 0; }
.markdown-body p {
  margin: 0.7rem 0;
}
.markdown-body blockquote {
  margin: 0.9rem 0;
  border-left: 3px solid var(--accent);
  color: var(--ink-soft);
  padding-left: 12px;
}
.markdown-body a {
  color: var(--accent-ink);
  font-weight: 800;
}

:where(a, button, label, [tabindex]):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (hover: hover) {
  .command:hover, .ledger-row:hover, .nav a:hover, .word-button:hover, .sentence-play:hover {
    transition-duration: 120ms;
  }
}

@media (max-width: 900px) {
  .ledger-shell {
    padding-inline: 8px;
  }
  .brand span:last-child {
    display: none;
  }
  .nav a {
    padding-inline: 10px;
  }
  .page {
    width: min(100% - 16px, 720px);
    padding-top: 18px;
  }
  .ledger-cover, .cover-grid {
    grid-template-columns: 1fr;
  }
  .cover-actions {
    justify-content: flex-start;
  }
  .ledger-metrics {
    grid-template-columns: 1fr;
  }
  .section-head {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  .ledger-row {
    grid-template-columns: minmax(0, 1fr) 36px;
    gap: 8px;
  }
  .date-rail {
    grid-column: 1 / -1;
  }
  .row-cue {
    grid-column: 2;
    grid-row: 2;
  }
  .command-bar {
    top: 61px;
  }
  .command, .done-toggle {
    flex: 1 1 calc(50% - 6px);
  }
  .lesson-grid {
    grid-template-columns: 1fr;
  }
  .study-panels {
    position: static;
  }
  .sentence {
    grid-template-columns: 44px minmax(0, 1fr);
  }
  .sentence-play {
    grid-row: span 2;
  }
  .num {
    grid-column: 2;
    line-height: 1.2;
  }
  .sentence-text {
    grid-column: 2;
  }
  .en {
    font-size: 1.1rem;
  }
}

@media (max-width: 420px) {
  .nav a span {
    display: none;
  }
  .nav a {
    width: 44px;
    justify-content: center;
  }
  .command, .done-toggle {
    flex-basis: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}

@media print {
  .ledger-shell, .command-bar, .sentence-play, .back-link {
    display: none !important;
  }
  body {
    background: white;
  }
  .page {
    width: auto;
    padding: 0;
  }
  .lesson-grid {
    display: block;
  }
  .reader, .study-panel, .markdown-body {
    border: 0;
  }
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
