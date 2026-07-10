import { createHash } from 'node:crypto'

export const AUDIO_VOICE = process.env.IELTSY_AUDIO_VOICE || 'en-US-EmmaMultilingualNeural'
export const AUDIO_RATE = process.env.IELTSY_AUDIO_RATE || '+0%'
export const PROSODY_SCHEMA_VERSION = 2
export const PROSODY_SOURCE = 'edge-tts-word-boundary-analysis-v2'
export const SENTENCE_AUDIO_PROFILE = 'word-boundary-v2'

function hashKey(parts: string[]): string {
  return createHash('md5').update(parts.join('|')).digest('hex').slice(0, 12)
}

export function sentenceAudioCacheKey(text: string): string {
  return hashKey([SENTENCE_AUDIO_PROFILE, AUDIO_VOICE, AUDIO_RATE, text.trim()])
}

export function lexicalAudioCacheKey(text: string): string {
  return hashKey([AUDIO_VOICE, AUDIO_RATE, text.trim()])
}
