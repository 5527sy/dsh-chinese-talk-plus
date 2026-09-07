/**
 * clone.ts — 本地音色复刻 API 客户端（桥 :8766，Qwen3-TTS）。
 *
 * 流程：上传参考 wav -> /api/voice/clone 复刻（内存态 voice_id）
 *       -> /api/voice/synthesize 试听 -> /api/voice/save 持久化。
 */
const RECORD_SINK_KEY = 's2s.record.base'
const DEFAULT_SINK = 'http://127.0.0.1:8766'

export interface SavedVoice {
  voice_id: string
  name: string
  ref_text?: string
  engine?: string
  created_at?: string
  ref_path?: string | null
}

export function sinkBase(): string {
  try {
    const v = localStorage.getItem(RECORD_SINK_KEY)
    if (v !== null && v.trim() !== '') return v.trim().replace(/\/+$/, '')
  } catch { /* ignore */ }
  return DEFAULT_SINK
}

/** 上传参考音频复刻音色；返回 { voiceId, refText } 或抛错。 */
export async function cloneVoice(
  wav: Blob,
  refText = '',
): Promise<{ voiceId: string; refText: string }> {
  const headers: Record<string, string> = { 'Content-Type': wav.type || 'audio/wav' }
  if (refText.trim() !== '') headers['X-Ref-Text'] = refText.trim()
  const res = await fetch(`${sinkBase()}/api/voice/clone`, { method: 'POST', headers, body: wav })
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean
    voice_id?: string
    ref_text?: string
    error?: string
  } | null
  if (!res.ok || data === null || data.ok !== true || data.voice_id === undefined) {
    throw new Error(data?.error ?? `复刻失败 HTTP ${res.status}`)
  }
  return { voiceId: data.voice_id, refText: data.ref_text ?? '' }
}

/** 用复刻音色合成试听，返回 { audioUrl, seconds } 或抛错。 */
export async function synthesizePreview(
  voiceId: string,
  text: string,
  language = 'Auto',
): Promise<{ audioUrl: string; seconds: number }> {
  const res = await fetch(`${sinkBase()}/api/voice/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_id: voiceId, text, language }),
  })
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean
    audio_url?: string
    seconds?: number
    error?: string
  } | null
  if (!res.ok || data === null || data.ok !== true || data.audio_url === undefined) {
    throw new Error(data?.error ?? `合成失败 HTTP ${res.status}`)
  }
  return { audioUrl: data.audio_url, seconds: data.seconds ?? 0 }
}

/** 把相对音频路径拼成绝对 URL。 */
export function absoluteAudioUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path
  return sinkBase() + path
}

/** 保存内存态音色为持久音色。 */
export async function saveVoice(voiceId: string, name: string): Promise<SavedVoice> {
  const res = await fetch(`${sinkBase()}/api/voice/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice_id: voiceId, name }),
  })
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean
    voice?: SavedVoice
    error?: string
  } | null
  if (!res.ok || data === null || data.ok !== true || data.voice === undefined) {
    throw new Error(data?.error ?? `保存失败 HTTP ${res.status}`)
  }
  return data.voice
}

/** 列出已保存音色。 */
export async function listVoices(): Promise<SavedVoice[]> {
  const res = await fetch(`${sinkBase()}/api/voices`)
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean
    voices?: SavedVoice[]
  } | null
  if (data === null || data.ok !== true) return []
  return data.voices ?? []
}

/** 删除已保存音色。 */
export async function deleteVoice(voiceId: string): Promise<boolean> {
  const res = await fetch(`${sinkBase()}/api/voice/${encodeURIComponent(voiceId)}`, { method: 'DELETE' })
  const data = (await res.json().catch(() => null)) as { ok?: boolean } | null
  return data?.ok === true
}
