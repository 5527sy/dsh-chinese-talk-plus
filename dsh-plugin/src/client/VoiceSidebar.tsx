/**
 * VoicePanel — DSH 语音面板（挂 ui-layout shell.overlay，常驻，可拖拽）。
 *
 * Plus 版（流式）：
 *  - 启动后立即后台预热 STT 模型；模型就绪前麦克风按钮置灰不可用。
 *  - 就绪后点一下麦克风进入「持续监听」，再点一下停止。
 *  - 音频以 20~40ms PCM 帧流式送给桥 /ws/asr；桥做 VAD，静音 3 秒切句识别。
 */
import { memo, useEffect, useRef, useState } from 'react'
import { bindLog } from './voice/log-bus.ts'
import { reader } from './voice/read-aloud.ts'
import { sendRecognizedText } from './voice/sender.ts'
import { StreamingAsr } from './voice/streaming-asr.ts'
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
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const asrRef = useRef<StreamingAsr | null>(null)

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
    const unsubReader = reader.subscribe(() => { setReadOn(reader.enabled); setSpeaking(reader.reading) })
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
            {speaking && <span className={styles.speaking}>📢 朗读中…</span>}
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
