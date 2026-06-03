import { spawnSync } from 'node:child_process'

/**
 * IELTSY CLI — 统一命令入口
 *
 * Usage:
 *   pnpm ielts                          # show help
 *   pnpm ielts help                     # same as above
 *   pnpm ielts help <subcommand>        # detailed help for one cmd
 *   pnpm ielts help --json              # all metadata as JSON (LLM-friendly)
 *   pnpm ielts <subcommand> [args]      # run subcommand
 *
 * 实现方式：dispatcher 把参数转发给已有的 scripts/study/*.ts 文件。
 * 添加新子命令：只需在 COMMANDS 注册 metadata + 指向 script 路径。
 */

interface ArgSpec {
  flag: string
  type: 'string' | 'boolean' | 'number'
  required?: boolean
  default?: string | boolean | number
  description: string
}

interface CommandMeta {
  description: string
  script: string
  args: ArgSpec[]
  examples: string[]
  notes?: string
}

const COMMANDS: Record<string, CommandMeta> = {
  // ──────────────────────────────────────────────────────────────────────────
  init: {
    description: '一次性建立学习计划（首次使用必须先跑）',
    script: 'scripts/study/init.ts',
    args: [
      { flag: '--target-band', type: 'number', required: true, description: '目标 IELTS 分数，如 7.0' },
      { flag: '--target-date', type: 'string', required: true, description: '截止日期 YYYY-MM-DD' },
      { flag: '--baseline', type: 'string', description: 'CEFR 基础水平，如 B1（用于过滤已掌握词）' },
      { flag: '--daily-words', type: 'number', default: 17, description: '每日新词量' },
      { flag: '--daily-grammar', type: 'number', default: 1, description: '每日新语法点数' },
      { flag: '--daily-minutes', type: 'number', default: 30, description: '每日学习时长（分钟）' },
      { flag: '--reset', type: 'boolean', default: false, description: '清空已有进度后重建' },
    ],
    examples: [
      'pnpm ielts init --target-band 7 --target-date 2026-12-01',
      'pnpm ielts init --target-band 7 --target-date 2026-12-01 --baseline B1 --daily-words 17',
      'pnpm ielts init --target-band 7 --target-date 2026-12-01 --reset',
    ],
    notes: '写入 user_state 表（单例）。词汇池按 baseline 过滤，pool 来自 7090 词的全集。',
  },

  // ──────────────────────────────────────────────────────────────────────────
  today: {
    description: '获取今日学习任务（新词 + 语法 + 复习队列）',
    script: 'scripts/study/today.ts',
    args: [
      { flag: '--force', type: 'boolean', default: false, description: '今日 session 已存在时强制重新生成' },
      { flag: '--json', type: 'boolean', default: false, description: '仅输出 JSON，不输出人类可读' },
    ],
    examples: [
      'pnpm ielts today',
      'pnpm ielts today --json',
      'pnpm ielts today --force',
    ],
    notes: `首次调用会自动创建 learning/days/YYYY-MM-DD/ 文件夹，并把 article_path / session_path 写入 db。
人类可读输出末尾有 "--- DATA (JSON) ---" 段，其后是完整结构化数据：
{
  date: string,
  article_genre: string,     // narrative | argumentative | descriptive | expository | dialogue
  article_path: string,
  session_path: string,
  new_words: [{id, headword, pos, cefr, def}, ...],
  grammar: {id, title, importance, description} | null,
  review_words: [{id, headword, def}, ...]
}
Idempotent: 重复调用同一日期返回相同 session。`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  record: {
    description: '保存今日成绩 + 更新 SM-2 间隔重复 + 写入错题记录',
    script: 'scripts/study/record.ts',
    args: [
      { flag: '--correct', type: 'string', default: '', description: '答对的 word_id，逗号分隔，如 "123,456"' },
      { flag: '--incorrect', type: 'string', default: '', description: '答错的 word_id' },
      { flag: '--whole-dictation', type: 'boolean', default: false, description: '是否完成了整篇默写' },
      { flag: '--notes', type: 'string', default: '', description: 'session 备注' },
      { flag: '--date', type: 'string', description: '覆盖日期（默认今天）' },
      { flag: '--mistakes-json', type: 'string', default: '', description: '详细错题 JSON（结构见 notes）' },
      { flag: '--mistakes-file', type: 'string', description: '从文件读 mistakes JSON（避免 shell 转义）' },
    ],
    examples: [
      'pnpm ielts record --correct "485,2141,2200" --incorrect "2212"',
      `pnpm ielts record --correct "1,2" --incorrect "3" --mistakes-json '[{"word_id":3,"context":"...","user_answer":"...","correct_answer":"...","error_type":"spelling"}]'`,
      'pnpm ielts record --whole-dictation --notes "challenging today"',
    ],
    notes: `mistakes-json 结构：
[
  {
    word_id: number,
    context: string,           // 句子原文，挖空处用 ___
    user_answer: string,
    correct_answer: string,
    error_type: 'spelling' | 'similar-form' | 'meaning' | 'pos' | 'unknown'
  }
]
SM-2: 答对 → interval *= ease, ease += 0.1, reps++；答错 → interval=1, ease -= 0.2, reps=0。
答对 5 次 + 间隔 ≥ 30 天 → status='mastered'。`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  'add-word': {
    description: '把任意词加入学习队列（用户阅读中遇到的生词）',
    script: 'scripts/study/add-word.ts',
    args: [
      { flag: '--word', type: 'string', description: '单个词，如 consultant' },
      { flag: '--words', type: 'string', description: '批量，逗号分隔，如 "consultant,client,deadline"' },
      { flag: '--pos', type: 'string', description: '同词多义时指定 POS：n/v/adj/adv 等' },
      { flag: '--force', type: 'boolean', default: false, description: 'db 里没有时创建空白条目' },
    ],
    examples: [
      'pnpm ielts add-word --word consultant',
      'pnpm ielts add-word --word contract --pos v',
      'pnpm ielts add-word --words "consultant,client,deadline"',
      'pnpm ielts add-word --word weirdword --force',
    ],
    notes: '若词已在 word_progress 表中，重置为 learning，next_review_date=today。',
  },

  // ──────────────────────────────────────────────────────────────────────────
  speak: {
    description: '朗读文本（基于 edge-tts，默认自然美音女声 Jenny）',
    script: 'scripts/study/speak.ts',
    args: [
      { flag: '--text', type: 'string', required: true, description: '要朗读的文本' },
      { flag: '--voice', type: 'string', default: 'female', description: '声音别名：female/male/us-f/us-soft/us-m/us-f2/us-m2/uk-f/uk-m 或完整名 en-US-JennyNeural' },
      { flag: '--rate', type: 'string', default: '+0%', description: '语速调整，如 -10% 或 +20%' },
      { flag: '--no-play', type: 'boolean', default: false, description: '只生成 mp3 不播放' },
    ],
    examples: [
      'pnpm ielts speak --text "Maria works as a consultant."',
      'pnpm ielts speak --voice male --text "..."',
      'pnpm ielts speak --voice uk-f --text "..." --rate -10%',
      'pnpm ielts speak --no-play --text "..."',
    ],
    notes: '缓存到 learning/audio-cache/<md5>.mp3（按 voice+rate+text 哈希）。播放器：macOS afplay。',
  },

  // ──────────────────────────────────────────────────────────────────────────
  preview: {
    description: '启动 HTTP 服务在浏览器预览文章（点击句子/单词朗读）',
    script: 'scripts/study/preview.ts',
    args: [
      { flag: '--port', type: 'number', default: 8765, description: '服务端口' },
      { flag: '--no-open', type: 'boolean', default: false, description: '不自动打开浏览器' },
    ],
    examples: [
      'pnpm ielts preview',
      'pnpm ielts preview --port 9000 --no-open',
    ],
    notes: `路由：
  GET /                        → 重定向到今日预览
  GET /YYYY-MM-DD              → 该天的文章 HTML
  GET /audio?text=...&v=...    → 朗读音频 mp3（lazy 生成 + 文件缓存）

⚠️ 须用 run_in_background: true 启动（server 是持续进程）。
停止：pkill -f scripts/study/preview`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  'export-pages': {
    description: '导出 GitHub Pages 可托管的静态学习站点',
    script: 'scripts/study/export-pages.ts',
    args: [
      { flag: '--out', type: 'string', default: 'dist', description: '静态站点输出目录' },
      { flag: '--title', type: 'string', default: 'IELTSY', description: '站点标题' },
    ],
    examples: [
      'pnpm ielts export-pages',
      'pnpm ielts export-pages --out dist --title IELTSY',
      'pnpm pages:build',
    ],
    notes: `从 learning/days/YYYY-MM-DD/article.md 和 learning/mistakes/*.md 生成纯静态 HTML。
发布版支持手机阅读、浏览器朗读、遮词练习和 localStorage 完成标记；SM-2 进度仍由本地 record 命令写入 SQLite。`,
  },

  // ──────────────────────────────────────────────────────────────────────────
  mistakes: {
    description: '从 db 重新生成错题本 md（覆盖式）',
    script: 'scripts/study/render-mistakes.ts',
    args: [],
    examples: ['pnpm ielts mistakes'],
    notes: '输出文件：learning/mistakes/words.md 和 learning/mistakes/grammar.md。每次 record 后跑一次保持同步。',
  },
}

// ============================================================================
// Help formatting
// ============================================================================

function printAllHelp(): void {
  console.log('IELTSY CLI — IELTS 学习闭环工具')
  console.log()
  console.log('Usage: pnpm ielts <subcommand> [args]')
  console.log('       pnpm ielts help [<subcommand>] [--json]')
  console.log()
  console.log('Subcommands:')
  const maxLen = Math.max(...Object.keys(COMMANDS).map((n) => n.length))
  for (const [name, meta] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(maxLen + 2)} ${meta.description}`)
  }
  console.log()
  console.log('Run "pnpm ielts help <subcommand>" for details, or "pnpm ielts help --json" for full schema.')
}

function printOneHelp(name: string): void {
  const meta = COMMANDS[name]
  if (!meta) {
    console.error(`Unknown subcommand: ${name}`)
    console.error('Run "pnpm ielts help" for available commands.')
    process.exit(1)
  }

  console.log(`pnpm ielts ${name} — ${meta.description}`)
  console.log()
  if (meta.args.length > 0) {
    console.log('Args:')
    const maxLen = Math.max(...meta.args.map((a) => a.flag.length))
    for (const a of meta.args) {
      const typeStr = `(${a.type}${a.default !== undefined ? `, default: ${a.default}` : ''}${a.required ? ', required' : ''})`
      console.log(`  ${a.flag.padEnd(maxLen + 2)} ${typeStr}`)
      console.log(`  ${' '.repeat(maxLen + 2)} ${a.description}`)
    }
    console.log()
  }
  console.log('Examples:')
  for (const ex of meta.examples) console.log(`  ${ex}`)
  if (meta.notes) {
    console.log()
    console.log('Notes:')
    for (const line of meta.notes.split('\n')) console.log(`  ${line}`)
  }
}

function printJsonHelp(name?: string): void {
  if (name) {
    if (!COMMANDS[name]) {
      console.error(`Unknown subcommand: ${name}`)
      process.exit(1)
    }
    console.log(JSON.stringify({ [name]: COMMANDS[name] }, null, 2))
  } else {
    console.log(JSON.stringify(COMMANDS, null, 2))
  }
}

// ============================================================================
// Dispatch
// ============================================================================

function main(): void {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const rest = argv.slice(1)
    const wantsJson = rest.includes('--json')
    const subName = rest.find((a) => !a.startsWith('--'))

    if (wantsJson) {
      printJsonHelp(subName)
    } else if (subName) {
      printOneHelp(subName)
    } else {
      printAllHelp()
    }
    return
  }

  const meta = COMMANDS[cmd]
  if (!meta) {
    console.error(`Unknown command: ${cmd}`)
    console.error('Run "pnpm ielts help" for available commands.')
    process.exit(1)
  }

  const result = spawnSync('tsx', [meta.script, ...argv.slice(1)], { stdio: 'inherit' })
  process.exit(result.status ?? 0)
}

main()
