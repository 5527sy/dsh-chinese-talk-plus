/**
 * voice-store.ts — 当前朗读音色选择（本地持久化）。
 *
 * 取值：'edge'（微软 Edge TTS 默认）或 'clone:<voice_id>'（本地复刻音色）。
 * 一次只允许一种音色朗读；reader.speak 在入队时读取这里的最新值。
 */
const VOICE_KEY = 's2s.voice.current'
export const EDGE_VOICE = 'edge'

export type CurrentVoice = string

export function getCurrentVoice(): CurrentVoice {
  try {
    const v = localStorage.getItem(VOICE_KEY)
    if (v !== null && v.trim() !== '') return v.trim()
  } catch { /* ignore */ }
  return EDGE_VOICE
}

export function setCurrentVoice(voice: CurrentVoice): void {
  try { localStorage.setItem(VOICE_KEY, voice) } catch { /* ignore */ }
}

/** 若为本地复刻音色则返回其 voice_id，否则 null。 */
export function cloneIdOf(voice: CurrentVoice): string | null {
  if (voice.startsWith('clone:')) return voice.slice(6)
  return null
}
