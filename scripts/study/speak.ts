import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * 朗读文本（基于 edge-tts）。
 *
 * 默认 British English 女声 (Sonia)。生成的 mp3 按内容 hash 缓存到
 * learning/audio-cache/，相同文本只生成一次。
 *
 * Usage:
 *   pnpm study:speak --text "Maria works as a consultant."
 *   pnpm study:speak --voice male --text "..."     (en-GB-Ryan)
 *   pnpm study:speak --voice us-f  --text "..."    (en-US-Aria)
 *   pnpm study:speak --rate -10% --text "..."      慢一点 (默认 0%)
 *   pnpm study:speak --no-play --text "..."        只生成不播放
 */

const VOICES: Record<string, string> = {
  female: 'en-US-AriaNeural',      // 默认：US 女声，news 风格清晰
  male: 'en-US-AndrewNeural',      // US 男声，warm/confident
  'us-f': 'en-US-AriaNeural',
  'us-f2': 'en-US-JennyNeural',
  'us-m': 'en-US-AndrewNeural',
  'us-m2': 'en-US-GuyNeural',
  'uk-f': 'en-GB-SoniaNeural',
  'uk-f2': 'en-GB-LibbyNeural',
  'uk-m': 'en-GB-RyanNeural',
  'uk-m2': 'en-GB-ThomasNeural',
}

const { values } = parseArgs({
  options: {
    text: { type: 'string' },
    voice: { type: 'string', default: 'female' },
    rate: { type: 'string', default: '+0%' },
    'no-play': { type: 'boolean', default: false },
    'cache-key': { type: 'string' }, // 可选自定义缓存 key（否则用文本 hash）
  },
})

const text = values.text
if (!text) {
  console.error('Usage: pnpm study:speak --text "..." [--voice female|male|us-f|...] [--rate -10%]')
  process.exit(1)
}

const voice = VOICES[values.voice!] ?? values.voice!
const rate = values.rate ?? '+0%'

// 缓存路径：learning/audio-cache/<voice>-<rate>-<text-md5>.mp3
const cacheDir = resolve('learning/audio-cache')
mkdirSync(cacheDir, { recursive: true })

const cacheKey = values['cache-key']
  ?? createHash('md5').update(`${voice}|${rate}|${text}`).digest('hex').slice(0, 12)
const outputPath = resolve(cacheDir, `${cacheKey}.mp3`)

if (!existsSync(outputPath)) {
  console.log(`[generate] ${voice} → ${outputPath.split('/').slice(-2).join('/')}`)
  const result = spawnSync(
    'edge-tts',
    ['--voice', voice, '--rate', rate, '--text', text, '--write-media', outputPath],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) {
    console.error('edge-tts failed')
    process.exit(1)
  }
} else {
  console.log(`[cached]   ${outputPath.split('/').slice(-2).join('/')}`)
}

if (!values['no-play']) {
  // macOS 自带 afplay；其他平台可改
  const player = spawnSync('afplay', [outputPath], { stdio: 'inherit' })
  if (player.status !== 0) {
    console.error('afplay failed (macOS only; consider adding a fallback player)')
    process.exit(1)
  }
}
