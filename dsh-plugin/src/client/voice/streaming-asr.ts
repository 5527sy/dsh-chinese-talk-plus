/**
 * StreamingAsr — 浏览器端流式音频帧采集 + WebSocket 推流。
 *
 * 用 AudioContext(16k) + ScriptProcessor 把麦克风切成 20~40ms 的 PCM16 帧，
 * 通过 WebSocket 持续发给桥 `/ws/asr`；桥侧做 VAD、静音切句与识别，并把
 * `partial` / `final` 文本消息推回。
 */
export interface StreamingCallbacks {
  base: string
  onReady?: () => void
  onPartial?: (text: string) => void
  onFinal?: (text: string) => void
  onError?: (msg: string) => void
}

export class StreamingAsr {
  private ws: WebSocket | null = null
  private audioCtx: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null
  private active = false

  constructor(private readonly cb: StreamingCallbacks) {}

  get isActive(): boolean {
    return this.active
  }

  async start(): Promise<void> {
    if (this.active) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.stream = stream

    const ctx = new AudioContext({ sampleRate: 16000 })
    this.audioCtx = ctx
    const source = ctx.createMediaStreamSource(stream)
    this.source = source
    const processor = ctx.createScriptProcessor(512, 1, 1)
    this.processor = processor
    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(this.floatToPcm16(e.inputBuffer.getChannelData(0)))
      }
    }

    const wsUrl = this.cb.base.replace(/^http/, 'ws') + '/ws/asr'
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => this.cb.onReady?.()
    ws.onmessage = (ev: MessageEvent): void => {
      let data: { type?: string; text?: string; error?: string } | null = null
      try { data = JSON.parse(String(ev.data)) } catch { return }
      if (data === null) return
      if (data.type === 'ready') this.cb.onReady?.()
      else if (data.type === 'partial' && typeof data.text === 'string') this.cb.onPartial?.(data.text)
      else if (data.type === 'final' && typeof data.text === 'string') this.cb.onFinal?.(data.text)
      else if (data.type === 'error') this.cb.onError?.(typeof data.error === 'string' ? data.error : 'unknown error')
    }
    ws.onerror = () => this.cb.onError?.('语音流连接失败')

    source.connect(processor)
    processor.connect(ctx.destination)
    this.active = true
  }

  async stop(): Promise<void> {
    this.active = false
    try { this.ws?.send('stop') } catch { /* ignore */ }
    if (this.processor !== null) { try { this.processor.disconnect() } catch { /* ignore */ } this.processor = null }
    if (this.source !== null) { try { this.source.disconnect() } catch { /* ignore */ } this.source = null }
    if (this.audioCtx !== null) { try { void this.audioCtx.close() } catch { /* ignore */ } this.audioCtx = null }
    if (this.stream !== null) { this.stream.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } }); this.stream = null }
    if (this.ws !== null) { try { this.ws.close() } catch { /* ignore */ } this.ws = null }
  }

  private floatToPcm16(samples: Float32Array): ArrayBuffer {
    const buf = new ArrayBuffer(samples.length * 2)
    const view = new DataView(buf)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return buf
  }
}