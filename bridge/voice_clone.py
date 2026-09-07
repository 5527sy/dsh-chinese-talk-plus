"""voice_clone — Qwen3-TTS 本地音色复刻引擎（懒加载，GPU bf16）。

复刻：上传参考 wav → FunASR 转写 ref_text → create_voice_clone_prompt 抽取音色。
合成：generate_voice_clone 用缓存的 prompt 生成复刻音色音频。

持久化：voices/cloned/<voice_id>/ref.wav + meta.json（name / ref_text / created_at）。
prompt 是内存态（含张量），不可跨进程序列化；重启后由 ref.wav + ref_text 懒重建。

模型目录解析（优先级从高到低）：
  环境变量 QWEN_TTS_DIR  >  <启动目录>/models/qwen3-tts/Qwen3-TTS-12Hz-1.7B-Base
  > HuggingFace 模型 id（首次联网下载）。
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

RUNTIME_ROOT = Path.cwd()
VOICE_ROOT = RUNTIME_ROOT / "voices" / "cloned"

_MODEL = None
_MODEL_LOCK = threading.Lock()
_MODEL_STATE = "cold"  # cold | loading | ready

# voice_id -> {"name", "ref_path", "ref_text", "prompt"}
_VOICES: dict = {}
_VOICES_LOCK = threading.Lock()


def _default_model_dir() -> Path:
    return RUNTIME_ROOT / "models" / "qwen3-tts" / "Qwen3-TTS-12Hz-1.7B-Base"


def _resolve_model_path() -> str:
    env = os.environ.get("QWEN_TTS_DIR")
    if env:
        return env
    d = _default_model_dir()
    if d.is_dir():
        return str(d)
    return "Qwen/Qwen3-TTS-12Hz-1.7B-Base"  # 兜底：HF 在线下载


def _load_model():
    """懒加载 Qwen3-TTS 模型。线程安全，只加载一次。"""
    global _MODEL, _MODEL_STATE  # noqa: PLW0603
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        _MODEL_STATE = "loading"
        try:
            import torch
            from qwen_tts import Qwen3TTSModel

            path = _resolve_model_path()
            use_cuda = torch.cuda.is_available()
            print(f"[voice-clone] 加载 Qwen3-TTS 模型: {path} (cuda={use_cuda})", flush=True)
            _MODEL = Qwen3TTSModel.from_pretrained(
                path,
                device_map="cuda:0" if use_cuda else "cpu",
                dtype=torch.bfloat16 if use_cuda else torch.float32,
            )
            _MODEL_STATE = "ready"
        except Exception:  # noqa: BLE001
            _MODEL_STATE = "cold"
            raise
    return _MODEL


def model_state() -> str:
    return _MODEL_STATE


def register_voice(ref_path: str, ref_text: str) -> str:
    """从参考音频建立复刻音色，返回 voice_id（内存态，尚未持久化）。"""
    model = _load_model()
    prompt = model.create_voice_clone_prompt(
        ref_audio=ref_path, ref_text=ref_text, x_vector_only_mode=False
    )
    voice_id = uuid.uuid4().hex[:16]
    with _VOICES_LOCK:
        _VOICES[voice_id] = {
            "name": None,
            "ref_path": ref_path,
            "ref_text": ref_text,
            "prompt": prompt,
        }
    return voice_id


def _ensure_prompt(entry: dict) -> list:
    if entry.get("prompt") is not None:
        return entry["prompt"]
    model = _load_model()
    prompt = model.create_voice_clone_prompt(
        ref_audio=entry["ref_path"], ref_text=entry["ref_text"], x_vector_only_mode=False
    )
    entry["prompt"] = prompt
    return prompt


def ensure_voice(voice_id: str) -> Optional[dict]:
    """取内存里的音色；没有则从磁盘懒加载（不建 prompt，首次合成时再建）。"""
    with _VOICES_LOCK:
        entry = _VOICES.get(voice_id)
    if entry is not None:
        return entry
    meta_path = VOICE_ROOT / voice_id / "meta.json"
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            ref_path = meta_path.parent / "ref.wav"
            if ref_path.is_file():
                load_saved_voice(
                    voice_id,
                    str(ref_path),
                    meta.get("ref_text", ""),
                    meta.get("name", ""),
                )
                with _VOICES_LOCK:
                    return _VOICES.get(voice_id)
        except Exception:  # noqa: BLE001
            pass
    return None


def synthesize(voice_id: str, text: str, language: str = "Auto"):
    """复刻音色合成，返回 (numpy float32 波形, sample_rate)。"""
    model = _load_model()
    entry = ensure_voice(voice_id)
    if entry is None:
        raise KeyError(f"voice_id 不存在: {voice_id}")
    prompt = _ensure_prompt(entry)
    wavs, sr = model.generate_voice_clone(
        text=text, language=language, voice_clone_prompt=prompt
    )
    return wavs[0], sr


def get_voice(voice_id: str) -> Optional[dict]:
    with _VOICES_LOCK:
        return _VOICES.get(voice_id)


def save_voice(voice_id: str, name: str) -> dict:
    """持久化音色：复制 ref.wav + 写 meta.json。"""
    with _VOICES_LOCK:
        entry = _VOICES.get(voice_id)
        if entry is None:
            raise KeyError(f"voice_id 不存在: {voice_id}")
    vdir = VOICE_ROOT / voice_id
    vdir.mkdir(parents=True, exist_ok=True)
    ref_dst = vdir / "ref.wav"
    shutil.copyfile(entry["ref_path"], ref_dst)
    meta = {
        "voice_id": voice_id,
        "name": name,
        "ref_text": entry["ref_text"],
        "engine": "qwen3-tts-1.7b",
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    (vdir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with _VOICES_LOCK:
        _VOICES[voice_id]["name"] = name
    return meta


def list_voices() -> list:
    """列出已持久化的音色（扫描 voices/cloned/*/meta.json）。"""
    out = []
    if not VOICE_ROOT.is_dir():
        return out
    for meta_path in sorted(VOICE_ROOT.glob("*/meta.json")):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            ref_path = meta_path.parent / "ref.wav"
            meta["ref_path"] = str(ref_path) if ref_path.is_file() else None
            out.append(meta)
        except Exception:  # noqa: BLE001
            continue
    return out


def load_saved_voice(voice_id: str, ref_path: str, ref_text: str, name: str) -> None:
    """把持久化音色注册进内存（懒：prompt 首次合成时才建）。"""
    with _VOICES_LOCK:
        if voice_id in _VOICES:
            return
        _VOICES[voice_id] = {
            "name": name,
            "ref_path": ref_path,
            "ref_text": ref_text,
            "prompt": None,
        }


def delete_voice(voice_id: str) -> bool:
    with _VOICES_LOCK:
        _VOICES.pop(voice_id, None)
    vdir = VOICE_ROOT / voice_id
    if vdir.is_dir():
        shutil.rmtree(vdir, ignore_errors=True)
        return True
    return False
