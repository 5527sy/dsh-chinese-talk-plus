/**
 * PttRecorder — 按住说话录音 + 静音自动停止（VAD）。
 *
 * 按下按钮开始录音（MediaRecorder，webm/opus）。录音期间用
 * AudioContext + AnalyserNode 计算音量 RMS：当声音停顿达到 `silenceMs`
 * （默认 2000ms）时自动 stop() 并交付整段 Blob，由上层做 STT + 自动发送。
 * 也支持松开按钮手动 stop()。
 */
export interface PttRecorderHooks {
  /** 录音结束，产出整段音频 Blob 与时长(ms)。 */
  onDone: (blob: Blob, durationMs: number) => void
}

export interface PttRecorderOptions {
  /** 静音持续多久（毫秒）自动停止。默认 2000。 */
  silenceMs?: number
  /** 判定为静音的 RMS 阈值。默认 0.02。 */
  volumeThreshold?: number
}

type RecState = 'new' | 'starting' | 'live' | 'stopping' | 'stopped'

function pickMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  if (typeof MediaRecorder === 'undefined') return ''
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    } catch { /* ignore */ }
  }
  return ''
}

export class PttRecorder {
  private state: RecState = 'new'
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private cancelled = false

  private readonly silenceMs: number
  private readonly volumeThreshold: number
  private audioCtx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private vadTimer: ReturnType<typeof setInterval> | null = null
  private silenceSince: number | null = null

  constructor(private readonly hooks: PttRecorderHooks, options: PttRecorderOptions = {}) {
    this.silenceMs = options.silenceMs ?? 2000
    this.volumeThreshold = options.volumeThreshold ?? 0.02
  }

  get active(): boolean {
    return this.state === 'starting' || this.state === 'live'
  }

  /** 请求麦克风并开始录制（须在用户手势中调用）。 */
  async start(): Promise<void> {
    if (this.state === 'stopping' || this.state === 'stopped') return
    this.state = 'starting'
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err) {
      this.state = 'stopped'
      throw err
    }
    // 极短按压：getUserMedia 返回前已松开 → 直接释放。
    if (this.state !== 'starting') {
      stream.getTracks().forEach(track => { try { track.stop() } catch { /* ignore */ } })
      this.state = 'stopped'
      return
    }
    this.stream = stream
    this.chunks = []
    this.cancelled = false

    // 静音检测（VAD）：AudioContext + AnalyserNode。失败时退回纯手动停止。
    try {
      const AC: typeof AudioContext | undefined =
        window.AudioContext
          ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AC === undefined) throw new Error('AudioContext unavailable')
      const ctx = new AC()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      this.audioCtx = ctx
      this.analyser = analyser
      this.silenceSince = null
      this.vadTimer = setInterval(() => this.vadTick(), 100)
    } catch { /* ignore */ }

    const mime = pickMime()
    let rec: MediaRecorder
    try {
      rec = mime !== ''
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream)
    } catch (err) {
      this.clearVad()
      stream.getTracks().forEach(track => { try { track.stop() } catch { /* ignore */ } })
      this.state = 'stopped'
      throw err
    }
    rec.ondataavailable = (e: BlobEvent): void => {
      if (e.data !== null && e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder = rec
    this.startedAt = performance.now()
    try {
      rec.start()
    } catch (err) {
      this.clearVad()
      this.state = 'stopped'
      throw err
    }
    this.state = 'live'
  }

  private vadTick(): void {
    const analyser = this.analyser
    if (analyser === null || this.state !== 'live') return
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    const now = performance.now()
    if (rms < this.volumeThreshold) {
      if (this.silenceSince === null) this.silenceSince = now
      else if (now - this.silenceSince >= this.silenceMs) this.stop()
    } else {
      this.silenceSince = null
    }
  }

  /** 松开或静音超时：停止并交付整段录音。 */
  stop(): void {
    this.clearVad()
    if (this.state === 'stopping' || this.state === 'stopped') return
    this.state = 'stopping'
    const rec = this.recorder
    const stream = this.stream
    this.recorder = null
    this.stream = null
    if (rec === null || stream === null || rec.state === 'inactive') {
      this.state = 'stopped'
      return
    }
    const ms = Math.max(0, Math.round(performance.now() - this.startedAt))
    rec.onstop = (): void => {
      stream.getTracks().forEach(track => { try { track.stop() } catch { /* ignore */ } })
      const first = this.chunks[0]
      const type = (first !== undefined ? first.type : rec.mimeType) || 'audio/webm'
      const blob = new Blob(this.chunks, { type })
      this.chunks = []
      this.state = 'stopped'
      if (!this.cancelled && blob.size > 0) this.hooks.onDone(blob, ms)
    }
    try {
      rec.stop()
    } catch (err) {
      this.state = 'stopped'
      this.chunks = []
      throw err
    }
  }

  private clearVad(): void {
    if (this.vadTimer !== null) {
      clearInterval(this.vadTimer)
      this.vadTimer = null
    }
    if (this.audioCtx !== null) {
      const ctx = this.audioCtx
      this.audioCtx = null
      this.analyser = null
      void ctx.close().catch(() => { /* ignore */ })
    }
  }

  /** 放弃本次录音（不交付）。 */
  cancel(): void {
    if (this.state === 'stopping' || this.state === 'stopped') return
    this.cancelled = true
    this.stop()
  }
}