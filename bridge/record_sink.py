"""record-sink — DSH 录音面板的落盘 + 中文识别服务（轻量，模型懒加载）。

浏览器点击开始/结束录音（MediaRecorder，webm/opus）→ 结束后上传音频 →
本服务用 ffmpeg 转成 MP3，以结束那一秒的年月日时分秒命名（如
20260212103015.mp3）保存到输出目录（默认 <启动目录>/vocal/master，可用
--out-dir 或 DSH_VOCAL_DIR 覆盖）。也接受 WAV（兼容调试）。

V2.1 起同时提供中文语音识别：
  POST /api/stt  上传任意音频（webm/mp3/wav…）→ ffmpeg 转 16k PCM →
                  FunASR Paraformer-large（中文，16k）→ { ok, text }
模型首次调用时懒加载（GPU 上约 10~60s），之后每次毫秒~秒级。

端点：
  GET  /api/health             -> {status, out_dir, ffmpeg, stt}
  POST /api/record             body=任意 ffmpeg 可解码音频
                               header X-Record-Ms=录音时长(ms)
                               -> {ok, file, path, seconds, bytes}
  POST /api/stt                body=任意 ffmpeg 可解码音频（同 record）
                               -> {ok, text, language, seconds}

配置（优先级从高到低）：
  输出目录 : 启动参数 --out-dir  >  环境变量 DSH_VOCAL_DIR  >  默认(见下)
  ffmpeg   : 环境变量 FFMPEG_BIN  >  PATH 中的 ffmpeg  >  已知默认安装路径
  ASR 模型 : 环境变量 FUNASR_DIR  >  已知本地路径  >  ModelScope 模型 id
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import math
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from bridge import voice_clone

RUNTIME_ROOT = Path.cwd()

# ffmpeg 定位顺序：FFMPEG_BIN 环境变量 > 启动目录内 ffmpeg/bin > PATH。
FFMPEG_FALLBACKS = [
    RUNTIME_ROOT / "ffmpeg" / "bin" / "ffmpeg.exe",
    RUNTIME_ROOT / "ffmpeg" / "bin" / "ffmpeg",
]

# FunASR Paraformer-large 中文 ASR（16k）：FUNASR_DIR > 启动目录模型 > ModelScope id。
FUNASR_DEFAULT = RUNTIME_ROOT / "models" / "funasr" / "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
FUNASR_MODELSCOPE_ID = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"

DEFAULT_ALLOW_ORIGINS = [
    "http://127.0.0.1:3080",
    "http://localhost:3080",
    "http://127.0.0.1:3081",
    "http://localhost:3081",
]


def configured_origins() -> list[str]:
    """Return explicitly configured CORS origins or the local Harness defaults."""
    raw = os.environ.get("DSH_BRIDGE_ORIGINS", "")
    origins = [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]
    return origins or DEFAULT_ALLOW_ORIGINS

# 按 Content-Type 选临时文件扩展名（ffmpeg 实际按内容探测格式）。
EXT_BY_TYPE = {
    "audio/webm": ".webm",
    "video/webm": ".webm",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
}


def default_out_dir() -> Path:
    """默认输出 = <启动目录>/vocal/master，不包含机器专用绝对路径。

    录音 MP3 存 <启动目录>/vocal/master，回答 txt 存 <启动目录>/vocal/answer
    （vocal/ 已在 .gitignore，不会进库）。可用 --out-dir 或 DSH_VOCAL_DIR 覆盖。
    """
    return RUNTIME_ROOT / "vocal" / "master"


def resolve_ffmpeg() -> Optional[Path]:
    env = os.environ.get("FFMPEG_BIN")
    if env and Path(env).is_file():
        return Path(env)
    for cand in FFMPEG_FALLBACKS:
        if cand.is_file():
            return cand
    return Path(shutil.which("ffmpeg")) if shutil.which("ffmpeg") else None


OUT_DIR = default_out_dir()
FFMPEG: Optional[Path] = resolve_ffmpeg()

app = FastAPI(title="dsh-chinese-talk-plus bridge")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    return {
        "status": "ok",
        "out_dir": str(OUT_DIR),
        "ffmpeg": "ok" if FFMPEG else "missing",
        "stt": _STT_STATE,
        "speaker": {
            "edge_tts": "ok" if _edge_command() is not None else "missing",
            "ffplay": "ok" if _resolve_ffplay() is not None else "missing",
            "sapi": "available" if os.name == "nt" else "unsupported",
        },
        "clone": {
            "engine": "qwen3-tts-1.7b",
            "state": voice_clone.model_state(),
            "voices": len(voice_clone.list_voices()),
        },
    }


def wav_seconds(data: bytes) -> Optional[float]:
    """从 RIFF/WAVE 头解析时长（秒）；非 WAV 返回 None。"""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    sr = ch = bits = 0
    audio = 0
    pos = 12
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = int.from_bytes(data[pos + 4:pos + 8], "little")
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt " and len(body) >= 16:
            ch = int.from_bytes(body[2:4], "little")
            sr = int.from_bytes(body[4:8], "little")
            bits = int.from_bytes(body[14:16], "little")
        elif cid == b"data":
            audio = len(body)
        pos += 8 + size + (size & 1)
    if sr <= 0 or ch <= 0 or bits <= 0:
        return None
    return audio / (sr * ch * (bits // 8))


def unique_path(d: Path, stem: str, ext: str) -> Path:
    cand = d / f"{stem}{ext}"
    if not cand.exists():
        return cand
    i = 2
    while True:
        cand = d / f"{stem}_{i}{ext}"
        if not cand.exists():
            return cand
        i += 1


def answer_dir() -> Path:
    """回答 txt 落盘目录：环境 DSH_ANSWER_DIR，否则 OUT_DIR 的兄弟 answer/。"""
    env = os.environ.get("DSH_ANSWER_DIR")
    if env:
        return Path(env)
    return OUT_DIR.parent / "answer"


@app.post("/api/answer")
async def save_answer(request: Request) -> JSONResponse:
    """保存一次正式回答：{ text } -> vocal/answer/YYYYMMDDHHMMSS.txt（结束时刻命名）。"""
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
    text = str(payload.get("text") or "").strip()
    if not text:
        return JSONResponse({"ok": False, "error": "empty text"}, status_code=400)
    out_dir = answer_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d%H%M%S")
    out = unique_path(out_dir, stamp, ".txt")
    out.write_text(text, encoding="utf-8")
    return JSONResponse({
        "ok": True,
        "file": out.name,
        "path": str(out),
        "bytes": out.stat().st_size,
    })


@app.post("/api/record")
async def record(request: Request) -> JSONResponse:
    body = await request.body()
    if len(body) < 256:
        return JSONResponse({"ok": False, "error": "empty or too-small payload"}, status_code=400)
    if FFMPEG is None:
        return JSONResponse(
            {"ok": False, "error": "ffmpeg not found — set FFMPEG_BIN"},
            status_code=500,
        )

    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    ext = EXT_BY_TYPE.get(content_type, ".bin")

    # 时长：WAV 从头解析；其他格式用浏览器上报的 X-Record-Ms。
    seconds = wav_seconds(body)
    if seconds is None:
        try:
            ms = int(request.headers.get("x-record-ms", "0"))
        except ValueError:
            ms = 0
        seconds = ms / 1000.0
    if seconds <= 0:
        seconds = 0.0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp_dir = OUT_DIR / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    stamp = time.strftime("%Y%m%d%H%M%S")  # 文件名 = 结束那一秒（年月日时分秒）
    out = unique_path(OUT_DIR, stamp, ".mp3")
    src = tmp_dir / f"{out.stem}{ext}"
    try:
        src.write_bytes(body)
        proc = subprocess.run(
            [
                str(FFMPEG), "-y",
                "-i", str(src),
                "-ac", "1",
                "-codec:a", "libmp3lame",
                "-q:a", "4",
                str(out),
            ],
            capture_output=True,
            timeout=120,
        )
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"ffmpeg failed: {err}"}, status_code=500)
    finally:
        try:
            src.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass

    if proc.returncode != 0:
        tail = (proc.stderr or b"").decode("utf-8", "ignore")[-400:]
        return JSONResponse(
            {"ok": False, "error": f"ffmpeg exit {proc.returncode}: {tail}"},
            status_code=500,
        )

    return JSONResponse({
        "ok": True,
        "file": out.name,
        "path": str(out),
        "seconds": round(seconds, 2),
        "bytes": out.stat().st_size,
    })


# ──────────────────────────────── 中文识别 (V2.1) ──────────────────────────────
_STT_MODEL = None
_STT_LOCK = threading.Lock()
_STT_STATE = "cold"  # cold | loading | ready


def stt_model_name() -> str:
    env = os.environ.get("FUNASR_DIR")
    if env:
        return env
    if FUNASR_DEFAULT.is_dir():
        return str(FUNASR_DEFAULT)
    return FUNASR_MODELSCOPE_ID


def _load_stt_model():
    """懒加载 FunASR Paraformer-large（中文 16k）。线程安全，只加载一次。"""
    global _STT_MODEL, _STT_STATE  # noqa: PLW0603
    if _STT_MODEL is not None:
        _STT_STATE = "ready"
        return _STT_MODEL
    with _STT_LOCK:
        if _STT_MODEL is not None:
            _STT_STATE = "ready"
            return _STT_MODEL
        _STT_STATE = "loading"
        try:
            import torch
            from funasr import AutoModel

            cuda = torch.cuda.is_available()
            print(f"[record-sink] STT 加载模型: {stt_model_name()} (cuda={cuda})", flush=True)
            _STT_MODEL = AutoModel(
                model=stt_model_name(),
                trust_remote_code=True,
                device="cuda" if cuda else "cpu",
                dtype="float16" if cuda else "float32",
            )
            _STT_STATE = "ready"
        except Exception:
            _STT_STATE = "cold"
            raise
    return _STT_MODEL


def _transcribe(model, pcm16: bytes) -> str:
    """16k 单声道小端 PCM16 → 文本。空/异常一律返回空串。"""
    audio = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
    audio = np.ascontiguousarray(audio, dtype=np.float32)
    result = model.generate(input=audio, cache={})
    return (result[0].get("text") or "").strip() if result else ""


def _run_stt(body: bytes, content_type: str, record_ms: int) -> dict:
    """同步执行 STT：转 16k PCM → 懒加载模型 → 转写。"""
    if FFMPEG is None:
        raise RuntimeError("ffmpeg not found — set FFMPEG_BIN")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp_dir = OUT_DIR / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    ext = EXT_BY_TYPE.get(content_type, ".bin")
    token = uuid.uuid4().hex[:12]
    src = tmp_dir / f"_stt_{token}{ext}"
    pcm = tmp_dir / f"_stt_{token}.pcm"
    try:
        src.write_bytes(body)
        proc = subprocess.run(
            [
                str(FFMPEG), "-y",
                "-i", str(src),
                "-ar", "16000",
                "-ac", "1",
                "-f", "s16le",
                str(pcm),
            ],
            capture_output=True,
            timeout=120,
        )
        if proc.returncode != 0:
            tail = (proc.stderr or b"").decode("utf-8", "ignore")[-300:]
            raise RuntimeError(f"ffmpeg decode failed: {tail}")
        pcm_bytes = pcm.read_bytes()
        if len(pcm_bytes) < 3200:  # < 0.1s
            return {"ok": True, "text": "", "language": "zh", "seconds": record_ms / 1000.0}
        model = _load_stt_model()
        text = _transcribe(model, pcm_bytes)
        return {"ok": True, "text": text, "language": "zh", "seconds": record_ms / 1000.0}
    finally:
        try:
            src.unlink(missing_ok=True)
            pcm.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


@app.post("/api/stt")
async def stt(request: Request) -> JSONResponse:
    """中文语音识别：任意 ffmpeg 可解码音频 -> { ok, text }。首次调用加载模型较慢。"""
    body = await request.body()
    if len(body) < 256:
        return JSONResponse({"ok": False, "error": "empty or too-small payload"}, status_code=400)
    try:
        ms = int(request.headers.get("x-record-ms", "0"))
    except ValueError:
        ms = 0
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    try:
        result = await asyncio.to_thread(_run_stt, body, content_type, ms)
        return JSONResponse(result)
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"stt failed: {err}"}, status_code=500)


# ─────────────────────── 流式听写 + 异步预热 (Plus) ───────────────────────────
_SILENCE_MS = 3000
_PARTIAL_INTERVAL_S = 1.2


def _warm_stt_async() -> None:
    try:
        _load_stt_model()
    except Exception as err:  # noqa: BLE001
        print(f"[record-sink] STT 预热失败: {err}", flush=True)


@app.post("/api/stt/warm")
def warm_stt() -> JSONResponse:
    """后台预热 STT 模型；立即返回当前状态。"""
    if _STT_MODEL is not None:
        return JSONResponse({"ok": True, "stt": "ready"})
    if _STT_STATE == "loading":
        return JSONResponse({"ok": True, "stt": "loading"})
    threading.Thread(target=_warm_stt_async, daemon=True).start()
    return JSONResponse({"ok": True, "stt": "loading"})


@app.websocket("/ws/asr")
async def ws_asr(ws: WebSocket) -> None:
    """流式听写：接收 16k 单声道 PCM16 小端帧，VAD 切句，静音 3s 触发识别。

    客户端发送二进制 PCM 帧（每帧 20~40ms）；文本消息 `stop` 结束会话。
    服务端消息：`ready` / `partial` / `final` / `error`。
    """
    await ws.accept()
    try:
        await asyncio.to_thread(_load_stt_model)
    except Exception as err:  # noqa: BLE001
        await ws.send_json({"type": "error", "error": f"stt load failed: {err}"})
        await ws.close()
        return
    await ws.send_json({"type": "ready"})

    vad_threshold_db = -40.0  # RMS dB：低于此值不认为在说话（前端滑块可调）
    accum = bytearray()
    speaking = False
    silent_since: Optional[float] = None
    last_partial_at = 0.0
    partial_lock = threading.Lock()
    loop = asyncio.get_running_loop()

    def emit_partial(snapshot: bytes) -> None:
        if len(snapshot) < 6400:  # <0.2s 不识别
            return
        with partial_lock:
            try:
                text = _transcribe(_STT_MODEL, snapshot)
            except Exception:  # noqa: BLE001
                return
        if text:
            try:
                loop.call_soon_threadsafe(
                    lambda t=text: asyncio.ensure_future(ws.send_json({"type": "partial", "text": t})),
                )
            except Exception:  # noqa: BLE001
                pass

    async def finalize() -> None:
        nonlocal speaking, silent_since, last_partial_at
        speaking = False
        silent_since = None
        last_partial_at = 0.0
        pcm = bytes(accum)
        accum.clear()
        if len(pcm) < 3200:
            return
        try:
            text = await asyncio.to_thread(_transcribe, _STT_MODEL, pcm)
            await ws.send_json({"type": "final", "text": text})
        except Exception as err:  # noqa: BLE001
            await ws.send_json({"type": "error", "error": str(err)})

    try:
        while True:
            msg = await ws.receive()
            kind = msg.get("type")
            if kind == "websocket.disconnect":
                break
            if kind != "websocket.receive":
                continue
            if msg.get("bytes"):
                frame = msg["bytes"]
            elif msg.get("text"):
                txt = (msg["text"] or "").strip()
                if txt.lower() == "stop":
                    break
                try:
                    cfg = json.loads(txt)
                    if isinstance(cfg, dict) and cfg.get("type") == "vad" and isinstance(cfg.get("threshold_db"), (int, float)):
                        vad_threshold_db = float(cfg["threshold_db"])
                        await ws.send_json({"type": "vad", "threshold_db": vad_threshold_db})
                except Exception:
                    pass
                continue
            else:
                continue

            samples = np.frombuffer(frame, dtype="<i2")
            if samples.size == 0:
                continue
            rms = float(np.sqrt(float(np.mean((samples.astype(np.float32) / 32768.0) ** 2))))
            rms_db = 20.0 * math.log10(max(rms, 1e-6))
            now = time.monotonic()

            if rms_db >= vad_threshold_db:
                if not speaking:
                    speaking = True
                    accum.clear()
                    silent_since = None
                accum.extend(frame)
                if now - last_partial_at >= _PARTIAL_INTERVAL_S:
                    last_partial_at = now
                    threading.Thread(target=emit_partial, args=(bytes(accum),), daemon=True).start()
            else:
                if speaking:
                    if silent_since is None:
                        silent_since = now
                    elif now - silent_since >= _SILENCE_MS / 1000.0:
                        await finalize()
    except WebSocketDisconnect:
        pass

# ─────────────────────── 回答朗读：edge-tts 在线 + 本机 SAPI 兜底 ───────────────
import queue as _queue
import tempfile as _tempfile

# ffplay：FFPLAY_BIN 环境变量 > 启动目录内 ffmpeg/bin > PATH。
FFPLAY_FALLBACKS = [
    RUNTIME_ROOT / "ffmpeg" / "bin" / "ffplay.exe",
    RUNTIME_ROOT / "ffmpeg" / "bin" / "ffplay",
]

_SPEECH_QUEUE = _queue.Queue()
_SPEECH_THREAD = None
_SPEECH_THREAD_LOCK = threading.Lock()
_SPEECH_STOP = threading.Event()
_SPEECH_CURRENT = None  # 当前正在播放的 ffplay Popen
_SPEECH_STATE_LOCK = threading.Lock()
_SPEECH_STATE = {"speaking": False, "queue": 0, "phase": "idle"}  # idle | synthesizing | speaking
_SPEECH_ERROR = ""


def _split_speech(text: str, max_len: int = 280, min_pause: int = 40) -> list:
    """攒句成段：句子到 min_pause 字以上或到 max_len 才切（减少句间合成停顿）。"""
    out = []
    buf = ""
    for ch in text:
        buf += ch
        if len(buf) >= max_len or (len(buf) >= min_pause and ch in "。！？!?…；;\n"):
            out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out


# 会令 GBK 输出/合成失败的 emoji、装饰符号等。
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U0001F1E6-\U0001F1FF"
    "\U00002600-\U000027BF\U0000FE00-\U0000FE0F"
    "\U0000200D\u20E3]"
)


def _sanitize_tts_text(text: str) -> str:
    """去掉不适合朗读/导致编码失败的内容（emoji、控制符等）。"""
    s = _EMOJI_RE.sub("", text)
    s = re.sub(r"[\uE000-\uF8FF\uFFF0-\uFFFF]", "", s)  # 私用区/占位
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _edge_command() -> Optional[list[str]]:
    """Resolve edge-tts from an explicit path, PATH, or the active Python environment."""
    configured = os.environ.get("EDGE_TTS_BIN")
    if configured:
        return [configured]
    executable = shutil.which("edge-tts")
    if executable:
        return [executable]
    if importlib.util.find_spec("edge_tts") is not None:
        return [sys.executable, "-m", "edge_tts"]
    return None


def _play_file_wait(path: Path) -> None:
    global _SPEECH_CURRENT  # noqa: PLW0603
    player = _resolve_ffplay()
    if player is None:
        raise RuntimeError("ffplay 不可用，请安装 ffmpeg 或设置 FFPLAY_BIN")
    play = subprocess.Popen(
        [str(player), "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with _SPEECH_STATE_LOCK:
        _SPEECH_CURRENT = play
    try:
        play.wait(timeout=900)
    finally:
        with _SPEECH_STATE_LOCK:
            if _SPEECH_CURRENT is play:
                _SPEECH_CURRENT = None


def _speak_sapi_piece(text: str) -> None:
    """本机 SAPI 离线兜底（speak.ps1，System.Speech，优先 Huihui 中文）。"""
    if os.name != "nt":
        raise RuntimeError("SAPI 兜底仅支持 Windows")
    engine = Path(__file__).resolve().parent / "speak.ps1"
    if not engine.is_file():
        raise RuntimeError(f"speak.ps1 不存在: {engine}")
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if powershell is None:
        raise RuntimeError("PowerShell 不可用，无法调用 SAPI")
    proc = subprocess.Popen(
        [
            powershell, "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(engine), "-Text", text,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with _SPEECH_STATE_LOCK:
        _SPEECH_CURRENT = proc
    try:
        proc.wait(timeout=900)
    finally:
        with _SPEECH_STATE_LOCK:
            if _SPEECH_CURRENT is proc:
                _SPEECH_CURRENT = None
    if proc.returncode != 0:
        raise RuntimeError(f"SAPI 朗读失败 rc={proc.returncode}")


def _speak_edge_piece(text: str) -> None:
    """edge-tts(晓晓在线) 合成一段 mp3 -> ffplay 播放；失败自动重试，最终抛错。"""
    command = _edge_command()
    if command is None:
        raise RuntimeError("edge-tts 不可用，请安装依赖或设置 EDGE_TTS_BIN")
    voice = os.environ.get("DSH_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
    last = "unknown"
    for attempt in range(1, 4):  # NoAudioReceived/节流：自动重试 3 次
        if _SPEECH_STOP.is_set():
            return
        fd, path = _tempfile.mkstemp(suffix=".mp3", prefix="dsh_edge_")
        os.close(fd)
        try:
            _r = subprocess.run(
                [*command, "--voice", voice, "--text", text, "--write-media", path],
                capture_output=True,
                timeout=120,
            )
            if _r.returncode != 0 or not Path(path).exists() or Path(path).stat().st_size < 2000:
                last = _r.stderr.decode("utf-8", "replace").strip()[-1200:]
                continue  # 重试
            _play_file_wait(Path(path))
            return
        finally:
            if Path(path).exists():
                try:
                    os.unlink(path)
                except Exception:  # noqa: BLE001
                    pass
        if attempt < 3:
            time.sleep(1.2 * attempt)
    raise RuntimeError(f"edge-tts 合成失败（3 次重试）: {last}")


def _write_wav(path: Path, wav, sr: int) -> None:
    """把 float32 波形写成 16bit PCM WAV（浏览器/ffplay 通用）。"""
    data = np.clip(np.asarray(wav, dtype=np.float32), -1.0, 1.0)
    sf.write(str(path), data, sr, subtype="PCM_16")


def _speak_clone_piece(text: str, voice_id: str) -> None:
    """本地复刻音色合成一段 wav -> ffplay 播放（合成期报 synthesizing）。"""
    with _SPEECH_STATE_LOCK:
        _SPEECH_STATE["phase"] = "synthesizing"
    path = None
    try:
        wav, sr = voice_clone.synthesize(voice_id, text)
        fd, path = _tempfile.mkstemp(suffix=".wav", prefix="dsh_clone_")
        os.close(fd)
        _write_wav(Path(path), wav, sr)
        with _SPEECH_STATE_LOCK:
            _SPEECH_STATE["phase"] = "speaking"
        _play_file_wait(Path(path))
    finally:
        if path is not None:
            try:
                os.unlink(path)
            except Exception:  # noqa: BLE001
                pass


def _speech_worker() -> None:
    global _SPEECH_CURRENT, _SPEECH_ERROR  # noqa: PLW0603
    while True:
        item = _SPEECH_QUEUE.get()
        if item is None:
            return
        if isinstance(item, tuple):
            text, voice = item
        else:
            text, voice = item, None
        with _SPEECH_STATE_LOCK:
            _SPEECH_STATE["speaking"] = True
            _SPEECH_STATE["phase"] = "speaking"
            _SPEECH_STATE["queue"] = max(0, _SPEECH_QUEUE.qsize())
        try:
            for piece in _split_speech(text, max_len=280, min_pause=50):
                if _SPEECH_STOP.is_set():
                    break
                if voice and voice.startswith("clone:"):
                    _speak_clone_piece(piece, voice[len("clone:"):])
                else:
                    try:
                        _speak_edge_piece(piece)  # 在线晓晓（重试）
                    except Exception as edge_err:  # noqa: BLE001
                        print(f"[record-sink] edge 失败，回退本机离线语音: {edge_err}", flush=True)
                        if _SPEECH_STOP.is_set():
                            break
                        _speak_sapi_piece(piece)   # 本机 Huihui 离线兜底
        except Exception as err:  # noqa: BLE001
            print(f"[record-sink] speak error: {err}", flush=True)
            with _SPEECH_STATE_LOCK:
                _SPEECH_ERROR = str(err)
        finally:
            with _SPEECH_STATE_LOCK:
                _SPEECH_STATE["speaking"] = False
                _SPEECH_STATE["phase"] = "idle"
                _SPEECH_STATE["queue"] = max(0, _SPEECH_QUEUE.qsize())


def _resolve_ffplay() -> Optional[Path]:
    env = os.environ.get("FFPLAY_BIN")
    if env and Path(env).is_file():
        return Path(env)
    for candidate in FFPLAY_FALLBACKS:
        if candidate.is_file():
            return candidate
    executable = shutil.which("ffplay")
    return Path(executable) if executable else None


def _ensure_speech_worker() -> None:
    global _SPEECH_THREAD  # noqa: PLW0603
    with _SPEECH_THREAD_LOCK:
        if _SPEECH_THREAD is None or not _SPEECH_THREAD.is_alive():
            _SPEECH_THREAD = threading.Thread(target=_speech_worker, daemon=True)
            _SPEECH_THREAD.start()


@app.post("/api/speak")
async def speak(request: Request) -> JSONResponse:
    """整段文本入队朗读（默认 Edge TTS，voice=clone:<id> 切本地复刻音色，串行播放）。"""
    global _SPEECH_ERROR  # noqa: PLW0603
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
    text = _sanitize_tts_text(str(payload.get("text") or ""))
    if not text:
        return JSONResponse({"ok": False, "error": "empty text"}, status_code=400)
    voice = str(payload.get("voice") or "").strip() or "edge"
    if voice.startswith("clone:"):
        voice_id = voice[len("clone:"):]
        if voice_clone.ensure_voice(voice_id) is None:
            return JSONResponse({"ok": False, "error": f"音色不存在: {voice_id}"}, status_code=404)
    if _resolve_ffplay() is None:
        return JSONResponse({"ok": False, "error": "ffplay 不可用，请安装 ffmpeg 或设置 FFPLAY_BIN"}, status_code=500)
    try:
        _ensure_speech_worker()
        with _SPEECH_STATE_LOCK:
            _SPEECH_ERROR = ""
        _SPEECH_STOP.clear()
        _SPEECH_QUEUE.put((text, voice))
        with _SPEECH_STATE_LOCK:
            queue_len = _SPEECH_QUEUE.qsize() + (1 if _SPEECH_STATE["speaking"] else 0)
        return JSONResponse({"ok": True, "queue": queue_len, "chars": len(text), "voice": voice})
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"speak failed: {err}"}, status_code=500)


@app.post("/api/speech/stop")
async def speech_stop() -> JSONResponse:
    """停掉当前播放并清空队列。"""
    global _SPEECH_CURRENT  # noqa: PLW0603
    _SPEECH_STOP.set()
    with _SPEECH_STATE_LOCK:
        proc = _SPEECH_CURRENT
        _SPEECH_CURRENT = None
    if proc is not None:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
    while True:
        try:
            _SPEECH_QUEUE.get_nowait()
        except _queue.Empty:
            break
    return JSONResponse({"ok": True})


@app.get("/api/speech/status")
def speech_status() -> dict:
    with _SPEECH_STATE_LOCK:
        return {
            "speaking": _SPEECH_STATE["speaking"],
            "phase": _SPEECH_STATE["phase"],
            "queue": _SPEECH_STATE["queue"],
            "error": _SPEECH_ERROR,
        }


# ─────────────────────── 音色复刻：Qwen3-TTS (V3) ──────────────────────────────
PREVIEW_DIR = RUNTIME_ROOT / "vocal" / "preview"
VOICE_TMP = RUNTIME_ROOT / "voices" / ".tmp"


def _do_clone(body: bytes, content_type: str, manual: str) -> dict:
    """同步：上传音频转 24k WAV -> FunASR 转写 -> 抽取音色，返回 {voice_id, ref_text}。"""
    if FFMPEG is None:
        raise RuntimeError("ffmpeg not found — set FFMPEG_BIN")
    VOICE_TMP.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex[:12]
    src_ext = EXT_BY_TYPE.get(content_type, ".bin")
    src = VOICE_TMP / f"_ref_{token}{src_ext}"
    ref_path = VOICE_TMP / f"ref_{token}.wav"
    src.write_bytes(body)
    registered = False
    try:
        proc = subprocess.run(
            [str(FFMPEG), "-y", "-i", str(src), "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", str(ref_path)],
            capture_output=True, timeout=120,
        )
        if proc.returncode != 0:
            tail = (proc.stderr or b"").decode("utf-8", "ignore")[-300:]
            raise RuntimeError(f"ffmpeg 转 WAV 失败: {tail}")

        if manual:
            ref_text = manual
        else:
            result = _run_stt(ref_path.read_bytes(), "audio/wav", 0)
            ref_text = (result.get("text") or "").strip()
        if not ref_text:
            raise RuntimeError("参考音频转写失败，请用 X-Ref-Text 头提供参考文本")

        voice_id = voice_clone.register_voice(str(ref_path), ref_text)
        registered = True
        return {"voice_id": voice_id, "ref_text": ref_text}
    finally:
        try:
            src.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        if not registered:
            try:
                ref_path.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass


@app.post("/api/voice/clone")
async def voice_clone_upload(request: Request) -> JSONResponse:
    """上传参考音频 -> 复刻音色，返回 { voice_id, ref_text }。参考文本可用 X-Ref-Text 头提供。"""
    body = await request.body()
    if len(body) < 256:
        return JSONResponse({"ok": False, "error": "empty or too-small payload"}, status_code=400)
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    manual = (request.headers.get("x-ref-text") or "").strip()
    try:
        result = await asyncio.to_thread(_do_clone, body, content_type, manual)
        return JSONResponse({"ok": True, **result})
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"复刻失败: {err}"}, status_code=500)


@app.post("/api/voice/synthesize")
async def voice_synthesize(request: Request) -> JSONResponse:
    """用复刻音色合成一段试听音频，返回可播放 URL。"""
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
    voice_id = str(payload.get("voice_id") or "")
    text = _sanitize_tts_text(str(payload.get("text") or ""))
    language = str(payload.get("language") or "Auto")
    if not voice_id or not text:
        return JSONResponse({"ok": False, "error": "voice_id/text 必填"}, status_code=400)
    try:
        wav, sr = await asyncio.to_thread(voice_clone.synthesize, voice_id, text, language)
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"合成失败: {err}"}, status_code=500)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex[:12]
    out = PREVIEW_DIR / f"{token}.wav"
    try:
        _write_wav(out, wav, sr)
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"写音频失败: {err}"}, status_code=500)
    return JSONResponse({
        "ok": True,
        "audio_url": f"/api/voice/audio/{token}",
        "seconds": round(len(wav) / sr, 2),
    })


@app.get("/api/voice/audio/{token}")
def voice_audio(token: str):
    if not re.fullmatch(r"[0-9a-f]{12}", token):
        return JSONResponse({"ok": False, "error": "bad token"}, status_code=400)
    path = PREVIEW_DIR / f"{token}.wav"
    if not path.is_file():
        return JSONResponse({"ok": False, "error": "not found"}, status_code=404)
    return FileResponse(path, media_type="audio/wav")


@app.post("/api/voice/save")
async def voice_save(request: Request) -> JSONResponse:
    """保存内存态音色到 voices/cloned/<id>/（ref.wav + meta.json）。"""
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
    voice_id = str(payload.get("voice_id") or "")
    name = str(payload.get("name") or "").strip()
    if not voice_id or not name:
        return JSONResponse({"ok": False, "error": "voice_id/name 必填"}, status_code=400)
    try:
        meta = await asyncio.to_thread(voice_clone.save_voice, voice_id, name)
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"保存失败: {err}"}, status_code=500)
    return JSONResponse({"ok": True, "voice": meta})


@app.get("/api/voices")
def list_voices() -> JSONResponse:
    return JSONResponse({"ok": True, "voices": voice_clone.list_voices()})


@app.delete("/api/voice/{voice_id}")
def delete_voice(voice_id: str) -> JSONResponse:
    ok = voice_clone.delete_voice(voice_id)
    return JSONResponse({"ok": ok})


def main() -> None:
    global OUT_DIR  # noqa: PLW0603
    parser = argparse.ArgumentParser(description="dsh-chinese-talk-plus local speech bridge")
    parser.add_argument("--out-dir", help="MP3 输出目录（默认 DSH_VOCAL_DIR 或 ../vocal/master）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()

    if args.out_dir:
        OUT_DIR = Path(args.out_dir)
    elif os.environ.get("DSH_VOCAL_DIR"):
        OUT_DIR = Path(os.environ["DSH_VOCAL_DIR"])

    import uvicorn

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[record-sink] out_dir={OUT_DIR}")
    print(f"[record-sink] ffmpeg={'ok: ' + str(FFMPEG) if FFMPEG else 'MISSING'}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
