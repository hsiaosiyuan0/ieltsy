import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const DB_PATH = resolve('db/ieltsy.db')
const CACHE_DIR = resolve('learning/audio-cache')
const DEFAULT_VOICE = 'en-US-EmmaMultilingualNeural'
const DEFAULT_RATE = '+0%'

const VOICES: Record<string, string> = {
  jenny: 'en-US-JennyNeural',
  emma: 'en-US-EmmaMultilingualNeural',
  aria: 'en-US-AriaNeural',
  andrew: 'en-US-AndrewNeural',
  guy: 'en-US-GuyNeural',
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8765' },
    'no-open': { type: 'boolean', default: false },
  },
})

const PORT = parseInt(values.port!, 10)

// ============================================================================
// Audio (edge-tts + cache)
// ============================================================================

function audioPath(text: string, voice: string = DEFAULT_VOICE, rate: string = DEFAULT_RATE): string {
  mkdirSync(CACHE_DIR, { recursive: true })
  const hash = createHash('md5').update(`${voice}|${rate}|${text}`).digest('hex').slice(0, 12)
  return resolve(CACHE_DIR, `${hash}.mp3`)
}

function ensureAudio(text: string, voice: string = DEFAULT_VOICE, rate: string = DEFAULT_RATE): string {
  const path = audioPath(text, voice, rate)
  if (existsSync(path)) return path
  const result = spawnSync(
    'edge-tts',
    ['--voice', voice, '--rate', rate, '--text', text, '--write-media', path],
    { encoding: 'utf-8' }
  )
  if (result.status !== 0) {
    throw new Error(`edge-tts failed: ${result.stderr || result.stdout}`)
  }
  return path
}

// ============================================================================
// Article markdown parsing
// ============================================================================

interface Sentence {
  num: number
  text: string
  zh?: string
}
interface TargetWord {
  word: string
  pos: string
  refs: string
  zh?: string
}
interface GrammarExample {
  sentenceNum: number
  excerpt: string
  note: string
}
interface ParsedArticle {
  title: string
  meta: string
  sentences: Sentence[]
  targetWords: TargetWord[]
  grammarTitle: string
  grammarDescription: string
  grammarExamples: GrammarExample[]
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const CIRCLED_NUM_TO_INT: Record<string, number> = Object.fromEntries(
  CIRCLED.split('').map((c, i) => [c, i + 1])
)

function parseArticleMd(md: string): ParsedArticle {
  const lines = md.split('\n')
  let title = ''
  let meta = ''
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
        const num = CIRCLED_NUM_TO_INT[m[1]!]!
        sentences.push({ num, text: m[2]!.trim() })
      }
    }

    if (section === 'zh') {
      const m = line.match(/^([①-⑳])\s+(.+)$/)
      if (m) {
        const num = CIRCLED_NUM_TO_INT[m[1]!]!
        const found = sentences.find((s) => s.num === num)
        if (found) found.zh = m[2]!.trim()
      }
    }

    if (section === 'words') {
      // | 1 | interpret | v | ② ⑯ |  -- skip header and separator rows
      if (line.includes('---') || line.includes('| 词 |') || line.includes('| # |')) continue
      const m = line.match(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/)
      if (m) {
        targetWords.push({
          word: m[1]!.trim(),
          pos: m[2]!.trim(),
          refs: m[3]!.trim(),
        })
      }
    }

    if (section === 'grammar') {
      // **一般现在时 ★★★ · 真理 / 习惯 / 状态**
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
      // - 句 ① · `Maria works...` —— 解释  OR  - 句 ①: `...` —— 解释
      const m = line.match(/^-\s*句\s*([①-⑳])\s*[:：·]?\s*`?([^`]+?)`?\s*(?:——|--)\s*(.*)$/)
      if (m) {
        const num = CIRCLED_NUM_TO_INT[m[1]!]!
        grammarExamples.push({
          sentenceNum: num,
          excerpt: m[2]!.trim(),
          note: m[3]!.trim(),
        })
      }
    }
  }

  return { title, meta, sentences, targetWords, grammarTitle, grammarDescription, grammarExamples }
}

// ============================================================================
// HTML rendering
// ============================================================================

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

function highlightTargets(text: string, targets: string[]): string {
  const escaped = escapeHtml(text)
  let result = escaped
  const sorted = [...targets].sort((a, b) => b.length - a.length)
  for (const word of sorted) {
    if (!word) continue
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`\\b(${safe}(?:s|es|ed|d|ing)?)\\b`, 'gi')
    result = result.replace(pattern, '<em class="target">$1</em>')
  }
  return result
}

function renderRefs(refs: string): string {
  return refs.split(/\s+/).filter(Boolean).map(tok => {
    const num = CIRCLED_NUM_TO_INT[tok]
    if (num) {
      return `<a class="ref-jump" data-target="${num}" title="跳到第 ${num} 句">${tok}</a>`
    }
    return `<span class="ref-label">${escapeHtml(tok)}</span>`
  }).join(' ')
}

function renderHtml(date: string, article: ParsedArticle): string {
  const targets = article.targetWords.map(t => t.word)

  const sentencesHtml = article.sentences.map(s => `        <p class="sentence" data-num="${s.num}" data-text="${escapeHtml(s.text)}">
          <span class="num">${CIRCLED[s.num - 1]}</span>
          <span class="text">
            <span class="en">${highlightTargets(s.text, targets)}</span>
            ${s.zh ? `<span class="zh">${escapeHtml(s.zh)}</span>` : ''}
          </span>
        </p>`).join('\n')

  const wordsHtml = article.targetWords.map(w => `          <li data-refs="${escapeHtml(w.refs)}">
            <span class="word">${escapeHtml(w.word)}</span>
            <span class="pos">${escapeHtml(w.pos)}</span>
            <span class="refs">${renderRefs(w.refs)}</span>
            ${w.zh ? `<span class="zh">${escapeHtml(w.zh)}</span>` : ''}
          </li>`).join('\n')

  const grammarExamplesHtml = article.grammarExamples.map(ex => `          <li>
            <span class="sent-num">${CIRCLED[ex.sentenceNum - 1]}</span>
            <code>${escapeHtml(ex.excerpt)}</code>
            ${ex.note ? `<span class="note">— ${escapeHtml(ex.note)}</span>` : ''}
          </li>`).join('\n')

  const titlePart = article.title.split('·').pop()?.trim() ?? article.title
  const metaParts = article.meta.split('|').map(p => p.trim()).filter(Boolean)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(titlePart)} — IELTSY</title>
<style>
  :root {
    --bg: #fbf7ef;
    --card: #ffffff;
    --text: #2c2418;
    --text-muted: #7a6f5d;
    --target: #b08442;
    --target-bg: rgba(176, 132, 66, 0.1);
    --hover: rgba(176, 132, 66, 0.15);
    --playing: #f5d27b;
    --border: #ebe3d2;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; }
  body {
    font-family: 'Iowan Old Style', 'Palatino', Georgia, serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.75;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  .page { max-width: 760px; margin: 48px auto; padding: 0 24px; }
  .article-header { text-align: center; margin-bottom: 32px; }
  .date-row {
    font-family: -apple-system, 'Segoe UI', sans-serif;
    font-size: 0.78rem;
    color: var(--text-muted);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-bottom: 14px;
  }
  .date-row .dot { margin: 0 8px; opacity: 0.4; }
  .title {
    font-family: 'Iowan Old Style', Georgia, serif;
    font-size: 2.4rem;
    font-weight: 700;
    letter-spacing: -0.015em;
    line-height: 1.2;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 28px;
    font-family: -apple-system, 'Segoe UI', sans-serif;
    font-size: 0.875rem;
    position: sticky;
    top: 16px;
    z-index: 10;
    box-shadow: 0 1px 3px rgba(44, 36, 24, 0.04);
  }
  .btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    font-family: inherit;
    transition: background 0.15s ease;
  }
  .btn:hover { background: var(--hover); }
  .btn.primary { background: var(--text); color: var(--bg); border-color: var(--text); }
  .btn.primary:hover { background: #4a3d28; }
  .ic-play, .ic-stop {
    display: inline-block;
    width: 0.7em;
    height: 0.7em;
    background: currentColor;
    vertical-align: -0.05em;
    margin-right: 4px;
  }
  .ic-play {
    width: 0;
    height: 0;
    background: transparent;
    border-style: solid;
    border-width: 0.4em 0 0.4em 0.6em;
    border-color: transparent transparent transparent currentColor;
    margin-right: 6px;
  }
  .ic-pause {
    display: inline-block;
    width: 0.55em;
    height: 0.75em;
    background: transparent;
    border-left: 0.18em solid currentColor;
    border-right: 0.18em solid currentColor;
    vertical-align: -0.05em;
    margin-right: 6px;
  }
  .spacer { flex: 1; }
  label.row { display: flex; align-items: center; gap: 6px; color: var(--text-muted); cursor: pointer; }
  select {
    font-family: inherit;
    font-size: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 4px 6px;
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
  }
  .article {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 40px 48px;
    margin-bottom: 24px;
  }
  .sentence {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 8px 12px;
    margin: 2px -12px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s ease;
    font-size: 1.0625rem;
  }
  .sentence:hover { background: var(--hover); }
  .sentence.playing {
    background: var(--playing);
    animation: pulse 1.5s ease-in-out infinite;
  }
  .sentence.paused { background: var(--playing); opacity: 0.6; }
  .sentence.loading { background: var(--hover); opacity: 0.7; }
  @keyframes pulse {
    0%, 100% { background: var(--playing); }
    50% { background: #f5cb5b; }
  }
  .sentence .num {
    flex-shrink: 0;
    width: 24px;
    color: var(--text-muted);
    font-family: 'SF Mono', 'Menlo', monospace;
    font-size: 0.8rem;
    padding-top: 4px;
    text-align: center;
  }
  .sentence .text { flex: 1; }
  .sentence .en { display: block; }
  .sentence .zh {
    display: block;
    margin-top: 4px;
    color: var(--text-muted);
    font-size: 0.92em;
    font-family: 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Serif SC', serif;
    line-height: 1.6;
  }
  body.zh-hidden .sentence .zh { display: none; }
  .target {
    color: var(--target);
    background: var(--target-bg);
    padding: 1px 4px;
    border-radius: 3px;
    font-style: normal;
    font-weight: 600;
  }
  body.targets-hidden .target {
    color: inherit;
    background: transparent;
    padding: 0;
    font-weight: normal;
  }
  .words-section, .grammar-section {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px 32px;
    margin-bottom: 16px;
  }
  h2 {
    font-family: -apple-system, 'Segoe UI', sans-serif;
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 16px;
    color: var(--text);
  }
  h2 .count { color: var(--text-muted); font-weight: 400; margin-left: 4px; }
  .word-list {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 2px;
    counter-reset: word;
    font-family: -apple-system, 'Segoe UI', sans-serif;
  }
  .word-list li {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 0.9rem;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .word-list li:hover { background: var(--hover); }
  .word-list li.loading { background: var(--hover); opacity: 0.7; }
  .word-list li.playing { background: var(--playing); }
  .word-list li.paused { background: var(--playing); opacity: 0.6; }
  .word-list li::before {
    counter-increment: word;
    content: counter(word, decimal);
    font-family: 'SF Mono', monospace;
    font-size: 0.7rem;
    color: var(--text-muted);
    min-width: 16px;
    text-align: right;
  }
  .word-list .word { font-weight: 600; color: var(--target); }
  .word-list .pos { color: var(--text-muted); font-style: italic; font-size: 0.8rem; }
  .word-list .refs {
    color: var(--text-muted);
    font-size: 0.75rem;
    margin-left: auto;
    font-family: 'SF Mono', monospace;
    display: inline-flex;
    gap: 2px;
  }
  .word-list .ref-jump {
    color: var(--text-muted);
    text-decoration: none;
    padding: 2px 4px;
    border-radius: 3px;
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
  }
  .word-list .ref-jump:hover { color: var(--target); background: var(--target-bg); }
  .word-list .ref-label { padding: 2px 4px; opacity: 0.5; }
  @keyframes ref-flash {
    0%   { background: transparent; }
    20%  { background: var(--target-bg); }
    100% { background: transparent; }
  }
  .sentence.ref-flash { animation: ref-flash 1.4s ease-out; }
  .word-list .zh {
    flex-basis: 100%;
    margin-left: 22px;
    color: var(--text-muted);
    font-size: 0.78rem;
    font-family: 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Serif SC', serif;
    line-height: 1.5;
    white-space: pre-line;
  }
  .grammar-desc {
    color: var(--text-muted);
    margin-bottom: 14px;
    font-size: 0.9rem;
    font-family: -apple-system, 'Segoe UI', sans-serif;
  }
  .grammar-examples { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .grammar-examples li {
    padding: 10px 14px;
    background: var(--bg);
    border-radius: 6px;
    font-size: 0.95rem;
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .grammar-examples .sent-num {
    color: var(--text-muted);
    font-family: 'SF Mono', monospace;
    font-size: 0.85rem;
  }
  .grammar-examples code {
    font-family: 'SF Mono', 'Menlo', monospace;
    background: var(--target-bg);
    color: var(--target);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 0.875em;
  }
  .grammar-examples .note {
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.85rem;
    font-family: -apple-system, 'Segoe UI', sans-serif;
  }
  .page-footer {
    text-align: center;
    padding: 32px 0 16px;
    color: var(--text-muted);
    font-size: 0.8rem;
    font-family: -apple-system, 'Segoe UI', sans-serif;
  }
  @media (max-width: 600px) {
    .page { padding: 0 16px; margin: 24px auto; }
    .title { font-size: 1.75rem; }
    .article { padding: 28px 20px; }
    .words-section, .grammar-section { padding: 20px 18px; }
    .word-list { grid-template-columns: 1fr; }
    .controls { flex-wrap: wrap; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="article-header">
    <div class="date-row">
      <span>${escapeHtml(date)}</span>${metaParts.map(p => `<span class="dot">·</span><span>${escapeHtml(p)}</span>`).join('')}
    </div>
    <h1 class="title">${escapeHtml(titlePart)}</h1>
  </header>

  <div class="controls">
    <button class="btn primary" id="playAll"><span class="ic-play"></span> Play All</button>
    <button class="btn" id="stopBtn"><span class="ic-stop"></span> Stop</button>
    <div class="spacer"></div>
    <label class="row">Voice
      <select id="voice">
        <option value="jenny">Jenny · natural US</option>
        <option value="emma" selected>Emma · soft US</option>
        <option value="aria">Aria · clear US</option>
        <option value="andrew">Andrew · male US</option>
        <option value="guy">Guy · male US</option>
      </select>
    </label>
    <label class="row">Pace
      <select id="speed">
        <option value="-12%">slow</option>
        <option value="+0%" selected>normal</option>
        <option value="+8%">brisk</option>
      </select>
    </label>
    <label class="row">
      <input type="checkbox" id="showTargets" checked>
      Targets
    </label>
    <label class="row">
      <input type="checkbox" id="showZh">
      中文
    </label>
  </div>

  <article class="article">
${sentencesHtml}
  </article>

  <section class="words-section">
    <h2>目标词 <span class="count">(${article.targetWords.length})</span></h2>
    <ol class="word-list">
${wordsHtml}
    </ol>
  </section>

  <section class="grammar-section">
    <h2>语法点 · ${escapeHtml(article.grammarTitle)}</h2>
    ${article.grammarDescription ? `<p class="grammar-desc">${escapeHtml(article.grammarDescription)}</p>` : ''}
    <ul class="grammar-examples">
${grammarExamplesHtml}
    </ul>
  </section>

  <footer class="page-footer">${escapeHtml(date)} · click any sentence to play · IELTSY</footer>
</div>

<script>
const audioCache = new Map();
let currentAudio = null;
let currentEl = null;
let currentResolve = null;
let isPaused = false;
let stoppedByUser = false;

function getVoice() { return document.getElementById('voice').value; }
function getRate() { return document.getElementById('speed').value; }

function setPauseUI() {
  const btn = document.getElementById('playAll');
  if (!currentAudio)        btn.innerHTML = '<span class="ic-play"></span> Play All';
  else if (isPaused)        btn.innerHTML = '<span class="ic-play"></span> Resume';
  else                      btn.innerHTML = '<span class="ic-pause"></span> Pause';
}

const AUDIO_VERSION = 'us-voice-v3';  // bump when audio-generation options change
function getAudio(text) {
  const voice = getVoice();
  const rate = getRate();
  const key = voice + '|' + rate + '|' + text;
  if (audioCache.has(key)) return audioCache.get(key);
  const audio = new Audio(
    '/audio?text=' + encodeURIComponent(text)
    + '&voice=' + encodeURIComponent(voice)
    + '&rate=' + encodeURIComponent(rate)
    + '&v=' + AUDIO_VERSION
  );
  audio.preload = 'auto';
  audioCache.set(key, audio);
  return audio;
}

function stopCurrent() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.oncanplay = null;
  }
  if (currentEl) {
    currentEl.classList.remove('playing');
    currentEl.classList.remove('loading');
    currentEl.classList.remove('paused');
  }
  currentAudio = null;
  currentEl = null;
  isPaused = false;
  setPauseUI();
}

function playAudio(text, el) {
  return new Promise(resolve => {
    stopCurrent();
    const audio = getAudio(text);
    audio.playbackRate = 1;
    if (el) {
      el.classList.add('loading');
      currentEl = el;
    }
    currentAudio = audio;
    currentResolve = resolve;
    setPauseUI();

    const cleanup = () => {
      if (el) {
        el.classList.remove('playing');
        el.classList.remove('loading');
        el.classList.remove('paused');
      }
      currentEl = null;
      currentAudio = null;
      currentResolve = null;
      isPaused = false;
      setPauseUI();
      resolve();
    };
    audio.onended = cleanup;
    audio.onerror = (e) => { console.error('Audio error', e); cleanup(); };
    audio.oncanplay = () => {
      if (el) {
        el.classList.remove('loading');
        if (!isPaused) el.classList.add('playing');
      }
    };
    audio.play().catch(err => { console.error('Play failed', err); cleanup(); });
  });
}

// Click sentence → play sentence
document.querySelectorAll('.sentence').forEach(s => {
  s.addEventListener('click', () => playAudio(s.dataset.text, s));
});

// Click word → play just that word
document.querySelectorAll('.word-list li').forEach(li => {
  li.addEventListener('click', () => {
    const word = li.querySelector('.word')?.textContent?.trim();
    if (word) playAudio(word, li);
  });
});

// Click ref chip (圈数字) → scroll to sentence, brief flash
document.querySelectorAll('.word-list .ref-jump').forEach(a => {
  a.addEventListener('click', e => {
    e.stopPropagation();
    const num = a.dataset.target;
    if (!num) return;
    const target = document.querySelector('.sentence[data-num="' + num + '"]');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('ref-flash');
    void target.offsetWidth;  // force reflow so animation restarts on repeated clicks
    target.classList.add('ref-flash');
    target.addEventListener('animationend', () => target.classList.remove('ref-flash'), { once: true });
  });
});

document.getElementById('playAll').addEventListener('click', async () => {
  if (currentAudio) {
    if (isPaused) {
      currentAudio.play().catch(()=>{});
      isPaused = false;
      if (currentEl) { currentEl.classList.remove('paused'); currentEl.classList.add('playing'); }
    } else {
      currentAudio.pause();
      isPaused = true;
      if (currentEl) { currentEl.classList.remove('playing'); currentEl.classList.add('paused'); }
    }
    setPauseUI();
    return;
  }
  stoppedByUser = false;
  const sentences = Array.from(document.querySelectorAll('.sentence'));
  for (const s of sentences) {
    await playAudio(s.dataset.text, s);
    if (stoppedByUser) break;
  }
});

document.getElementById('stopBtn').addEventListener('click', () => {
  stoppedByUser = true;
  const r = currentResolve;
  currentResolve = null;
  stopCurrent();
  if (r) r();  // unblock Play All loop's await
});

document.getElementById('showTargets').addEventListener('change', e => {
  document.body.classList.toggle('targets-hidden', !e.target.checked);
});

// 默认隐藏中文翻译（强迫先读英文，需要时再 toggle）
document.body.classList.add('zh-hidden');
document.getElementById('showZh').addEventListener('change', e => {
  document.body.classList.toggle('zh-hidden', !e.target.checked);
});

document.getElementById('voice').addEventListener('change', stopCurrent);
document.getElementById('speed').addEventListener('change', stopCurrent);
</script>
</body>
</html>`
}

// ============================================================================
// HTTP server
// ============================================================================

function resolveVoice(value: string | null): string {
  if (!value) return DEFAULT_VOICE
  return VOICES[value] ?? DEFAULT_VOICE
}

function resolveRate(value: string | null): string {
  if (!value) return DEFAULT_RATE
  return /^[+-]\d{1,3}%$/.test(value) ? value : DEFAULT_RATE
}

function serveAudio(text: string, res: ServerResponse, voice: string, rate: string): void {
  try {
    const path = ensureAudio(text, voice, rate)
    const stat = statSync(path)
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
    })
    createReadStream(path).pipe(res)
  } catch (err) {
    console.error('[audio error]', err)
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Audio generation failed')
  }
}

function enrichTargetWordsWithZh(db: Database.Database, targets: TargetWord[]): void {
  if (targets.length === 0) return
  const stmt = db.prepare(`
    SELECT definition_zh FROM words
    WHERE lower(headword) = ? AND definition_zh IS NOT NULL AND definition_zh <> ''
    ORDER BY CASE WHEN pos = ? THEN 0 ELSE 1 END, id
    LIMIT 1
  `)
  for (const t of targets) {
    const row = stmt.get(t.word.toLowerCase(), t.pos) as { definition_zh: string } | undefined
    if (row?.definition_zh) t.zh = row.definition_zh
  }
}

function serveArticle(date: string, res: ServerResponse): void {
  const db = new Database(DB_PATH, { readonly: true })
  try {
    const session = db.prepare('SELECT article_path FROM daily_sessions WHERE session_date = ?').get(date) as
      | { article_path: string | null }
      | undefined
    if (!session?.article_path) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`No article for ${date}`)
      return
    }
    const fullPath = resolve(session.article_path)
    if (!existsSync(fullPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`File missing: ${fullPath}`)
      return
    }
    const md = readFileSync(fullPath, 'utf-8')
    const parsed = parseArticleMd(md)
    enrichTargetWordsWithZh(db, parsed.targetWords)
    const html = renderHtml(date, parsed)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } finally {
    db.close()
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  if (url.pathname === '/audio') {
    const text = url.searchParams.get('text')
    if (!text) {
      res.writeHead(400)
      res.end('Missing text')
      return
    }
    serveAudio(text, res, resolveVoice(url.searchParams.get('voice')), resolveRate(url.searchParams.get('rate')))
    return
  }

  let date: string
  if (url.pathname === '/' || url.pathname === '') {
    date = new Date().toISOString().split('T')[0]!
  } else {
    const m = url.pathname.match(/^\/(\d{4}-\d{2}-\d{2})\/?$/)
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found. Use / or /YYYY-MM-DD')
      return
    }
    date = m[1]!
  }

  console.log(`[${new Date().toISOString().split('T')[1]?.slice(0, 8)}] GET ${url.pathname}`)
  serveArticle(date, res)
})

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`
  console.log(`✓ Preview server: ${url}`)
  console.log(`  Today: ${url}`)
  console.log(`  By date: ${url}/YYYY-MM-DD`)
  console.log(`  Stop: pkill -f study/preview  (or Ctrl+C if foreground)`)
  if (process.env.http_proxy || process.env.HTTP_PROXY) {
    console.log(`  Note: http_proxy is set in env. If browser fails to connect, ensure system proxy bypasses localhost.`)
  }

  if (!values['no-open']) {
    spawnSync('open', [url], { stdio: 'ignore' })
  }
})

process.on('SIGINT', () => {
  console.log('\n✗ Server stopping...')
  server.close(() => process.exit(0))
})
