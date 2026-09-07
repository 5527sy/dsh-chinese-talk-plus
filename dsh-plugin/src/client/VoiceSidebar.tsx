/**
 * VoicePanel — DSH 语音面板（挂 ui-layout shell.overlay，常驻，可拖拽）。
 *
 * Plus 版（流式）：
 *  - 启动后立即后台预热 STT 模型；模型就绪前麦克风按钮置灰不可用。
 *  - 就绪后点一下麦克风进入「持续监听」，再点一下停止。
 *  - 音频以 20~40ms PCM 帧流式送给桥 /ws/asr；桥做 VAD，静音 3 秒切句识别。
 */
import { memo, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { bindLog } from './voice/log-bus.ts'
import { reader } from './voice/read-aloud.ts'
import { sendRecognizedText } from './voice/sender.ts'
import { StreamingAsr } from './voice/streaming-asr.ts'
import {
  absoluteAudioUrl,
  cloneVoice,
  listVoices,
  saveVoice,
  synthesizePreview,
  type SavedVoice,
} from './voice/clone.ts'
import { EDGE_VOICE, getCurrentVoice, setCurrentVoice } from './voice/voice-store.ts'
import styles from './VoiceSidebar.module.css'

const RECORD_SINK_KEY = 's2s.record.base'
const DEFAULT_SINK = 'http://127.0.0.1:8766'
const PANEL_KEY = 's2s.record.panel'
const VAD_THRESHOLD_KEY = 's2s.vad.threshold'
const DEFAULT_VAD_THRESHOLD_DB = -40
const POS_TOGGLE_KEY = 's2s.panel.toggle.pos'
const POS_ROOT_KEY = 's2s.panel.root.pos'

function sinkBase(): string {
  try {
    const v = localStorage.getItem(RECORD_SINK_KEY)
    if (v !== null && v.trim() !== '') return v.trim().replace(/\/+$/, '')
  } catch { /* ignore */ }
  return DEFAULT_SINK
}

function clock(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

function readHidden(): boolean {
  try { return localStorage.getItem(PANEL_KEY) === '1' } catch { return false }
}

function writeHidden(hidden: boolean): void {
  try { localStorage.setItem(PANEL_KEY, hidden ? '1' : '0') } catch { /* ignore */ }
}

function readThresholdDb(): number {
  try {
    const v = Number(localStorage.getItem(VAD_THRESHOLD_KEY))
    if (Number.isFinite(v) && v >= -60 && v <= -10) return v
  } catch { /* ignore */ }
  return DEFAULT_VAD_THRESHOLD_DB
}

function writeThresholdDb(db: number): void {
  try { localStorage.setItem(VAD_THRESHOLD_KEY, String(db)) } catch { /* ignore */ }
}

interface Pos { x: number; y: number }

function viewport(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 1200, h: 800 }
  return { w: window.innerWidth, h: window.innerHeight }
}

function readPos(key: string, fallback: Pos): Pos {
  try {
    const raw = localStorage.getItem(key)
    if (raw !== null) {
      const p = JSON.parse(raw) as Partial<Pos>
      if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y }
    }
  } catch { /* ignore */ }
  return fallback
}

function writePos(key: string, pos: Pos): void {
  try { localStorage.setItem(key, JSON.stringify(pos)) } catch { /* ignore */ }
}

function useDrag(
  key: string,
  defaultPos: Pos,
  onTap?: () => void,
): { pos: Pos; onPointerDown: (e: { clientX: number; clientY: number; preventDefault: () => void }) => void; style: { left: number; top: number } } {
  const [pos, setPos] = useState<Pos>(() => readPos(key, defaultPos))
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)

  const onPointerDown = (e: { clientX: number; clientY: number; preventDefault: () => void }): void => {
    e.preventDefault()
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false }
    const move = (ev: PointerEvent): void => {
      const st = dragRef.current
      if (st === null) return
      const dx = ev.clientX - st.sx
      const dy = ev.clientY - st.sy
      if (Math.abs(dx) + Math.abs(dy) > 3) st.moved = true
      if (st.moved) setPos({ x: st.ox + dx, y: st.oy + dy })
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const st = dragRef.current
      dragRef.current = null
      if (st === null) return
      if (st.moved) {
        setPos(prev => { writePos(key, prev); return prev })
      } else if (onTap !== undefined) {
        onTap()
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return { pos, onPointerDown, style: { left: pos.x, top: pos.y } }
}

type Phase = 'idle' | 'listening' | 'error'

interface LogLine { t: string; msg: string; bad?: boolean }

export const VoiceSidebar = memo(function VoiceSidebar() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [hidden, setHidden] = useState<boolean>(() => readHidden())
  const [sttReady, setSttReady] = useState(false)
  const [partial, setPartial] = useState('')
  const [thresholdDb, setThresholdDb] = useState<number>(() => readThresholdDb())
  const [log, setLog] = useState<LogLine[]>(() => [{ t: clock(), msg: '启动中：正在预热语音识别模型…' }])
  const [toast, setToast] = useState<string | null>(null)
  const [readOn, setReadOn] = useState<boolean>(reader.enabled)
  const [speaking, setSpeaking] = useState<boolean>(reader.reading)
  const [synthesizing, setSynthesizing] = useState<boolean>(reader.synthesizing)
  const [voices, setVoices] = useState<SavedVoice[]>([])
  const [currentVoice, setCurrentVoiceState] = useState<string>(() => getCurrentVoice())
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloneVoiceId, setCloneVoiceId] = useState<string | null>(null)
  const [refText, setRefText] = useState('')
  const [previewText, setPreviewText] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [synthBusy, setSynthBusy] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveBusy, setSaveBusy] = useState(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const asrRef = useRef<StreamingAsr | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const pushLog = (msg: string, bad = false): void => {
    setLog(prev => [...prev.slice(-19), { t: clock(), msg, bad }])
  }

  const collapse = (): void => {
    if (phase === 'listening') {
      showToast('请先停止监听')
      return
    }
    setHidden(true)
    writeHidden(true)
  }

  const expand = (): void => {
    setHidden(false)
    writeHidden(false)
  }

  const collapsedDrag = useDrag(POS_TOGGLE_KEY, { x: viewport().w - 46, y: Math.round(viewport().h / 2 - 18) }, expand)
  const panelDrag = useDrag(POS_ROOT_KEY, { x: viewport().w - 266, y: Math.round(viewport().h / 2 - 230) })

  useEffect(() => {
    return () => { if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current) }
  }, [])

  useEffect(() => {
    const unsubReader = reader.subscribe(() => {
      setReadOn(reader.enabled)
      setSpeaking(reader.reading)
      setSynthesizing(reader.synthesizing)
    })
    bindLog((msg, bad = false) => pushLog(msg, bad))
    return () => { unsubReader(); bindLog(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    const base = sinkBase()
    const warm = async (): Promise<void> => {
      try { await fetch(base + '/api/stt/warm', { method: 'POST' }) } catch { /* ignore */ }
      while (!cancelled) {
        try {
          const res = await fetch(base + '/api/health')
          const h = (await res.json().catch(() => null)) as { stt?: string } | null
          if (h?.stt === 'ready') { if (!cancelled) { setSttReady(true); pushLog('语音识别模型已就绪') } return }
          if (!cancelled && h?.stt === 'loading') pushLog('模型加载中…')
        } catch { /* ignore */ }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }
    }
    void warm()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 载入已保存的本地音色（供下拉切换）。
  useEffect(() => {
    let cancelled = false
    void listVoices().then(vs => { if (!cancelled) setVoices(vs) })
    return () => { cancelled = true }
  }, [])

  const showToast = (msg: string, durationMs = 2600): void => {
    setToast(msg)
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs)
  }

  const handleFinal = (text: string): void => {
    const t = (text ?? '').trim()
    setPartial('')
    if (t === '') { pushLog('（未识别到文字）'); return }
    void (async () => {
      const err = await sendRecognizedText(t)
      if (err === null || err === undefined) pushLog('识别并发送：' + t)
      else pushLog('识别但发送失败：' + err, true)
    })()
  }

  const startListening = async (): Promise<void> => {
    if (phase === 'listening' || !sttReady) return
    void reader.stop()
    setPhase('listening')
    setPartial('')
    pushLog('开始持续监听…（静音 3 秒自动识别并发送）')
    const asr = new StreamingAsr({
      base: sinkBase(),
      initialThresholdDb: thresholdDb,
      onPartial: text => setPartial(text),
      onFinal: handleFinal,
      onError: msg => { pushLog(msg, true); setPhase('error') },
    })
    asrRef.current = asr
    try {
      await asr.start()
    } catch (err) {
      asrRef.current = null
      setPhase('error')
      pushLog('麦克风启动失败：' + (err instanceof Error ? err.message : String(err)), true)
    }
  }

  const stopListening = (): void => {
    const asr = asrRef.current
    asrRef.current = null
    if (asr !== null) void asr.stop()
    setPhase('idle')
    setPartial('')
    pushLog('已停止监听')
  }

  const onMicClick = (): void => {
    if (!sttReady) return
    if (phase === 'listening') stopListening()
    else void startListening()
  }

  const onThresholdChange = (v: number): void => {
    setThresholdDb(v)
    writeThresholdDb(v)
    asrRef.current?.setThresholdDb(v)
  }

  // ── 音色复刻 ────────────────────────────────────────────────
  const ensureAudio = (): HTMLAudioElement => {
    if (audioRef.current === null) {
      const a = new Audio()
      a.onended = () => setPreviewPlaying(false)
      a.onpause = () => setPreviewPlaying(false)
      a.onplay = () => setPreviewPlaying(true)
      audioRef.current = a
    }
    return audioRef.current
  }

  const doClone = async (file: File): Promise<void> => {
    setCloneBusy(true)
    pushLog('正在复刻音色…（首次需加载模型，请稍候）')
    try {
      const { voiceId, refText: rt } = await cloneVoice(file)
      setCloneVoiceId(voiceId)
      setRefText(rt)
      setPreviewUrl(null)
      setPreviewText('')
      setSaveName('')
      pushLog('复刻成功，可输入文本试听或保存音色')
    } catch (err) {
      pushLog('复刻失败：' + (err instanceof Error ? err.message : String(err)), true)
    } finally {
      setCloneBusy(false)
    }
  }

  const onFileChosen = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file !== undefined) void doClone(file)
  }

  const synthesizeAndPlay = async (): Promise<void> => {
    if (cloneVoiceId === null || previewText.trim() === '') {
      pushLog('请先输入试听文本', true)
      return
    }
    setSynthBusy(true)
    try {
      const { audioUrl } = await synthesizePreview(cloneVoiceId, previewText.trim())
      setPreviewUrl(audioUrl)
      const a = ensureAudio()
      a.src = absoluteAudioUrl(audioUrl)
      await a.play().catch(() => {})
    } catch (err) {
      pushLog('试听失败：' + (err instanceof Error ? err.message : String(err)), true)
    } finally {
      setSynthBusy(false)
    }
  }

  const onPlayPreview = (): void => {
    if (previewUrl === null) void synthesizeAndPlay()
    else void audioRef.current?.play().catch(() => {})
  }

  const onPausePreview = (): void => { audioRef.current?.pause() }

  const onRegenerate = (): void => { void synthesizeAndPlay() }

  const onSaveVoice = async (): Promise<void> => {
    if (cloneVoiceId === null || saveName.trim() === '') return
    setSaveBusy(true)
    try {
      await saveVoice(cloneVoiceId, saveName.trim())
      pushLog('音色已保存：' + saveName.trim())
      const vs = await listVoices()
      setVoices(vs)
      const next = `clone:${cloneVoiceId}`
      setCurrentVoiceState(next)
      setCurrentVoice(next)
    } catch (err) {
      pushLog('保存失败：' + (err instanceof Error ? err.message : String(err)), true)
    } finally {
      setSaveBusy(false)
    }
  }

  const onVoiceChange = (v: string): void => {
    setCurrentVoiceState(v)
    setCurrentVoice(v)
    if (v === EDGE_VOICE) pushLog('朗读音色：微软晓晓（默认）')
    else {
      const vid = v.slice(6)
      const found = voices.find(x => x.voice_id === vid)
      pushLog('朗读音色：' + (found?.name ?? vid))
    }
  }

  const listening = phase === 'listening'
  const micClass = listening ? styles.micBtn + ' ' + styles.micOn : !sttReady ? styles.micBtn + ' ' + styles.micBusy : styles.micBtn
  const statusText = !sttReady ? '模型加载中…' : listening ? '持续监听中（静音 3 秒自动发送）' : phase === 'error' ? '出错了，见下方日志' : '点击开始持续监听'

  if (hidden) {
    return (
      <button
        type="button"
        className={styles.collapsed}
        style={collapsedDrag.style}
        title="展开语音面板（可拖拽）"
        onPointerDown={collapsedDrag.onPointerDown}
      >
        🎙️
      </button>
    )
  }

  return (
    <div className={styles.root} style={panelDrag.style}>
      <header className={styles.header} onPointerDown={panelDrag.onPointerDown}>
        <div className={styles.headerTop}>
          <span className={styles.title}>语音通话</span>
          <button type="button" className={styles.close} title="折叠面板" onClick={collapse}>✕</button>
        </div>
        <span className={styles.subtitle}>流式听写 · 静音3秒自动识别发送</span>
      </header>

          <div className={styles.micArea}>
            <button
              type="button"
              className={micClass}
              title={!sttReady ? '模型加载中…' : listening ? '停止监听' : '开始监听'}
              disabled={!sttReady}
              style={!sttReady ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              onClick={onMicClick}
            >
              {!sttReady ? '⏳' : listening ? '🔴' : '🎙️'}
            </button>
            <span className={listening ? styles.stateText + ' ' + styles.stateRec : styles.stateText}>{statusText}</span>
          </div>

          <div className={styles.threshold}>
            <div className={styles.thresholdHead}>
              <span className={styles.thresholdLabel}>触发阈值</span>
              <span className={styles.thresholdVal}>{thresholdDb} dB</span>
            </div>
            <input
              className={styles.thresholdSlider}
              type="range"
              min={-60}
              max={-10}
              step={1}
              value={thresholdDb}
              onChange={e => onThresholdChange(Number(e.target.value))}
            />
            <div className={styles.thresholdHint}>低于该音量不开始录音</div>
          </div>

          {/* 朗读音色切换（一次只允许一种音色） */}
          <div className={styles.cloneSection}>
            <div className={styles.cloneTitle}>朗读音色</div>
            <select className={styles.select} value={currentVoice} onChange={e => onVoiceChange(e.target.value)}>
              <option value={EDGE_VOICE}>微软晓晓（默认）</option>
              {voices.map(v => (
                <option key={v.voice_id} value={`clone:${v.voice_id}`}>{v.name}</option>
              ))}
            </select>
          </div>

          {/* 音色复刻：上传 wav -> 试听/暂停/重新生成 -> 保存 */}
          <div className={styles.cloneSection}>
            <div className={styles.cloneTitle}>音色复刻</div>
            <input ref={fileRef} type="file" accept="audio/*,.wav" className={styles.fileInput} onChange={onFileChosen} />
            <button type="button" className={styles.ctrlBtn} disabled={cloneBusy} onClick={() => fileRef.current?.click()}>
              {cloneBusy ? '⏳ 复刻中…' : '📁 上传 WAV 复刻'}
            </button>
            {cloneVoiceId !== null && (
              <div className={styles.cloneInfo}>
                <div className={styles.cloneRefText} title={refText}>{refText === '' ? '（参考文本未识别）' : '参考：' + refText}</div>
                <input className={styles.textInput} value={previewText} placeholder="输入试听文本" onChange={e => setPreviewText(e.target.value)} />
                <div className={styles.cloneBtns}>
                  <button type="button" className={styles.ctrlBtn} disabled={synthBusy || previewText.trim() === ''} onClick={onPlayPreview}>
                    {synthBusy ? '⏳ 合成中…' : '▶ 试听播放'}
                  </button>
                  <button type="button" className={styles.ctrlBtn} disabled={previewUrl === null} onClick={onPausePreview}>⏸ 试听暂停</button>
                  <button type="button" className={styles.ctrlBtn} disabled={synthBusy || previewText.trim() === ''} onClick={onRegenerate}>🔄 重新生成</button>
                </div>
                <input className={styles.textInput} value={saveName} placeholder="音色名（保存后可选）" onChange={e => setSaveName(e.target.value)} />
                <button type="button" className={styles.ctrlBtn + ' ' + styles.saveBtn} disabled={saveBusy || saveName.trim() === ''} onClick={onSaveVoice}>
                  {saveBusy ? '⏳ 保存中…' : '💾 保存音色'}
                </button>
              </div>
            )}
          </div>

          {listening && (
            <div className={styles.partial} title="实时识别结果">
              {partial === '' ? '（正在听，实时文字会显示在这里）' : partial}
            </div>
          )}

          <div className={styles.controls}>
            <button
              type="button"
              className={readOn ? styles.ctrlBtn + ' ' + styles.ctrlOn : styles.ctrlBtn}
              title={readOn ? '关闭自动朗读回答' : '开启自动朗读回答'}
              onClick={() => reader.setEnabled(!readOn)}
            >
              {readOn ? '🔊 朗读开' : '🔇 朗读关'}
            </button>
            {synthesizing
              ? <span className={styles.synthesizing}>⏳ 语音正在合成，请等待…</span>
              : speaking && <span className={styles.speaking}>📢 朗读中…</span>}
          </div>

          <footer className={styles.footer}>
            <div className={styles.hint}>识别文本自动发送到当前会话；回答归档与朗读沿用原插件</div>
            <div className={styles.logBox}>
              {log.map((item, i) => (
                <div key={i} className={item.bad === true ? styles.logLine + ' ' + styles.logBad : styles.logLine}>
                  <span className={styles.logT}>{item.t}</span> {item.msg}
                </div>
              ))}
            </div>
          </footer>

          {toast !== null && (
            <div className={styles.toast} role="alert" onClick={() => setToast(null)}>
              {toast}
            </div>
          )}
    </div>
  )
})
