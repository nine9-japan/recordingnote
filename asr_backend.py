"""Haas-ja-v1.0 transcription for the local RecordingNote server.

The model is loaded once in a background thread so the page can be opened while
the download/load is still running. Transcription jobs are serialised because a
single GPU cannot process two lectures at the same time.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

LOGGER = logging.getLogger("recordingnote.asr")

MODEL_ID = os.environ.get("HAAS_MODEL", "third-intelligence/Haas-ja-v1.0").strip() or "third-intelligence/Haas-ja-v1.0"
BATCH_SIZE = max(1, int(os.environ.get("HAAS_BATCH_SIZE", "8") or 8))


def _ffmpeg_executable() -> str:
    """Use the system ffmpeg when present, otherwise the bundled one."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover - depends on the user's machine
        raise RuntimeError(
            "ffmpeg が見つかりません。`sudo apt install ffmpeg` で導入するか、"
            "`pip install imageio-ffmpeg` を実行してください。"
        ) from exc


def _to_wav(src: Path, dst: Path) -> None:
    """Convert any browser recording (webm/m4a/…) to 16 kHz mono WAV."""
    command = [
        _ffmpeg_executable(),
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(dst),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()[-1:] or ["不明なエラー"]
        raise RuntimeError(f"音声を変換できませんでした（{detail[0]}）。WAV・MP3 などに変換してから再実行してください。")


def _vocabulary_from_env(haas_asr):
    raw = os.environ.get("HAAS_VOCABULARY_JSON", "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
        words = {
            str(word): [str(reading) for reading in (readings if isinstance(readings, list) else [readings])]
            for word, readings in data.items()
        }
        return haas_asr.Vocabulary(words) if words else None
    except Exception as exc:
        raise RuntimeError(
            "HAAS_VOCABULARY_JSON の形式が正しくありません。"
            '例: {"考古学概説II": ["こうこがくがいせつ"]}'
        ) from exc


class Transcriber:
    def __init__(self) -> None:
        self._model = None
        self._haas_asr = None
        self._vocabulary = None
        self._gpu_lock = threading.Lock()
        self._load_started = False
        self.ready = False
        self.loading = False
        self.error: str | None = None

    def start_loading(self) -> None:
        if self._load_started:
            return
        self._load_started = True
        self.loading = True
        threading.Thread(target=self._load, name="haas-loader", daemon=True).start()

    def _load(self) -> None:
        try:
            try:
                import torch
            except ImportError as exc:
                raise RuntimeError(
                    "PyTorch が見つかりません。`pip install -r requirements.txt` を実行してください。"
                ) from exc

            if not torch.cuda.is_available():
                raise RuntimeError(
                    "NVIDIA GPU（CUDA）を利用できません。Haas-ja-v1.0 は Linux と NVIDIA GPU が必要です。"
                    "GPU のあるPCで起動するか、ブラウザ方式の文字起こしを使ってください。"
                )
            try:
                import haas_asr
            except ImportError as exc:
                raise RuntimeError(
                    "haas-asr が見つかりません。`pip install -r requirements.txt` を実行してください。"
                ) from exc

            self._haas_asr = haas_asr
            self._vocabulary = _vocabulary_from_env(haas_asr)
            LOGGER.info("Haas-ja モデルを読み込んでいます: %s", MODEL_ID)
            self._model = haas_asr.load_model(MODEL_ID)
            self.ready = True
            LOGGER.info("Haas-ja モデルの読み込みが完了しました。")
        except Exception as exc:  # noqa: BLE001 - reported through /health
            self.error = str(exc) or exc.__class__.__name__
            LOGGER.error("Haas-ja モデルを読み込めませんでした: %s", self.error)
        finally:
            self.loading = False

    def status(self) -> dict:
        return {
            "engine": MODEL_ID,
            "model_loaded": self.ready,
            "model_loading": self.loading,
            "model_error": self.error,
        }

    def unavailable_message(self) -> str:
        if self.error:
            return f"Haas-ja モデルを準備できませんでした: {self.error}"
        return "Haas-ja モデルを読み込み中です。初回はモデルの取得に数分かかります。しばらく待ってから再実行してください。"

    def transcribe(self, source: Path) -> str:
        if not self.ready or self._model is None or self._haas_asr is None:
            raise RuntimeError(self.unavailable_message())

        with tempfile.TemporaryDirectory(prefix="rn-audio-") as tmp:
            wav = Path(tmp) / "input.wav"
            _to_wav(source, wav)
            audio = self._haas_asr.load_audio(str(wav))

        # Only one job may use the GPU at a time.
        with self._gpu_lock:
            if self._vocabulary is not None:
                return self._haas_asr.transcribe_longform(
                    self._model, audio, batch_size=BATCH_SIZE, vocabulary=self._vocabulary
                )
            return self._haas_asr.transcribe_longform(self._model, audio, batch_size=BATCH_SIZE)
