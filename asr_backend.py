"""Local Haas-ja-v1.0 transcription for RecordingNote.

Uses the official ``third-intelligence/Haas-ja-v1.0`` model on Linux with an
NVIDIA Ampere+ GPU when available, and automatically falls back to the quantized
ONNX conversion (``oboroge0/Haas-ja-v1.0-onnx-quantized`` via ``sherpa-onnx``)
so macOS, Windows, and CPU-only Linux machines work out of the box.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import wave
from collections.abc import Callable
from pathlib import Path

LOGGER = logging.getLogger("recordingnote.asr")

SAMPLE_RATE = 16000
GPU_MODEL_ID = (
    os.environ.get("HAAS_MODEL", "third-intelligence/Haas-ja-v1.0").strip()
    or "third-intelligence/Haas-ja-v1.0"
)
ONNX_MODEL_ID = (
    os.environ.get("HAAS_ONNX_MODEL", "oboroge0/Haas-ja-v1.0-onnx-quantized").strip()
    or "oboroge0/Haas-ja-v1.0-onnx-quantized"
)
ONNX_MODEL_REVISION = os.environ.get(
    "HAAS_ONNX_REVISION", "7f5ab0a4b1bf39db78afd6691eeecbc4f9d42e39"
).strip()
ONNX_ALLOW_PATTERNS = (
    "encoder.quantized.onnx",
    "encoder.onnx",
    "encoder.data",
    "decoder.onnx",
    "joiner.onnx",
    "tokens.txt",
)
DEVICE_PREF = os.environ.get("HAAS_DEVICE", "auto").strip().lower() or "auto"


def _parse_positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


BATCH_SIZE = _parse_positive_int("HAAS_BATCH_SIZE", 8)
CPU_THREADS = _parse_positive_int("HAAS_CPU_THREADS", min(4, os.cpu_count() or 1))

ProgressCallback = Callable[[str, int | None], None]


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
            "ffmpeg が見つかりません。`pip install imageio-ffmpeg` を実行するか、"
            "ffmpeg をインストールしてください。"
        ) from exc


def _to_wav(src: Path, dst: Path) -> None:
    """Convert any browser or user audio (webm/m4a/mp3/…) to 16 kHz mono WAV."""
    command = [
        _ffmpeg_executable(),
        "-nostdin",
        "-hide_banner",
        "-y",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-map",
        "0:a:0",
        "-map_metadata",
        "-1",
        "-ar",
        str(SAMPLE_RATE),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(dst),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()[-1:] or ["不明なエラー"]
        raise RuntimeError(
            f"音声を変換できませんでした（{detail[0]}）。WAV・MP3 などに変換してから再実行してください。"
        )


def _cpu_wav_chunks(wav: Path):
    """Yield (float32_samples, progress_ratio) chunks cut near quiet points."""
    import numpy as np

    min_frames = 20 * SAMPLE_RATE
    max_frames = 25 * SAMPLE_RATE
    radius = SAMPLE_RATE // 50

    with wave.open(str(wav), "rb") as source:
        total = source.getnframes()
        if total <= 0:
            raise RuntimeError("音声データが空か、読み取れませんでした。")
        while source.tell() < total:
            start = source.tell()
            raw = source.readframes(max_frames)
            samples = np.frombuffer(raw, dtype="<i2").astype(np.float32)
            if samples.size == 0:
                raise RuntimeError("音声データが空か、読み取れませんでした。")
            if source.tell() < total:
                # Pick a low-energy boundary near the end of the 20-25s window to avoid mid-word cuts,
                # while keeping at least 1 second for the trailing chunk.
                last_cut = min(len(samples) - radius, total - start - SAMPLE_RATE)
                if last_cut >= min_frames:
                    cut = min(
                        range(last_cut, min_frames - 1, -radius),
                        key=lambda offset: float(
                            np.mean(np.square(samples[offset - radius : offset + radius]))
                        ),
                    )
                    source.setpos(start + cut)
                    samples = samples[:cut]
            yield samples / 32768.0, min(1.0, source.tell() / total)


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
        self._torch = None
        self._vocabulary = None
        self._recognizer = None
        self._infer_lock = threading.Lock()
        self._load_started = False
        self.ready = False
        self.loading = False
        self.error: str | None = None
        self.backend: str | None = None
        self.model_id: str | None = None
        self.engine_label = "Haas-ja-v1.0"

    def start_loading(self) -> None:
        if self._load_started:
            return
        self._load_started = True
        self.loading = True
        threading.Thread(target=self._load, name="haas-loader", daemon=True).start()

    def _can_use_gpu(self) -> tuple[bool, str]:
        if sys.platform != "linux":
            return False, "公式の GPU 版 Haas-ja は Linux のみ対応です。"
        try:
            import torch
        except ImportError:
            return False, "PyTorch が見つかりません。GPU を使う場合は CUDA 対応の PyTorch を導入してください。"
        try:
            if not torch.cuda.is_available():
                return False, "NVIDIA GPU（CUDA）を利用できません。"
            major, _minor = torch.cuda.get_device_capability()
        except Exception as exc:
            return False, f"CUDA デバイスの確認に失敗しました: {exc}"
        if major < 8:
            return False, "公式の GPU 版 Haas-ja は NVIDIA Ampere 以降（Compute Capability 8.0 以上）が必要です。"
        try:
            import haas_asr  # noqa: F401
        except ImportError:
            return False, "haas-asr が見つかりません。`pip install -r requirements-gpu.txt` を実行してください。"
        return True, ""

    def _load_gpu(self) -> None:
        import haas_asr
        import torch

        self._torch = torch
        self._haas_asr = haas_asr
        self._vocabulary = _vocabulary_from_env(haas_asr)
        LOGGER.info("Haas-ja（GPU版）を読み込んでいます: %s", GPU_MODEL_ID)
        self._model = haas_asr.load_model(GPU_MODEL_ID, dtype=torch.bfloat16)
        self.backend = "gpu"
        self.model_id = GPU_MODEL_ID
        self.engine_label = "Haas-ja-v1.0（NVIDIA GPU）"
        self.ready = True
        LOGGER.info("Haas-ja（GPU版）の読み込みが完了しました。")

    def _load_cpu(self) -> None:
        try:
            from huggingface_hub import snapshot_download
        except ImportError as exc:
            raise RuntimeError(
                "huggingface-hub が見つかりません。`pip install -r requirements.txt` を実行してください。"
            ) from exc
        try:
            import sherpa_onnx
        except ImportError as exc:
            raise RuntimeError(
                "sherpa-onnx が見つかりません。`pip install -r requirements.txt` を実行してください。"
            ) from exc

        if os.environ.get("HAAS_VOCABULARY_JSON", "").strip():
            LOGGER.info("HAAS_VOCABULARY_JSON は GPU モードでのみ有効です（CPU / ONNX モードでは無視されます）。")

        LOGGER.info("Haas-ja（CPU / ONNX版）を読み込んでいます: %s", ONNX_MODEL_ID)
        download_kwargs: dict = {"allow_patterns": list(ONNX_ALLOW_PATTERNS)}
        if ONNX_MODEL_REVISION:
            download_kwargs["revision"] = ONNX_MODEL_REVISION
        model_dir = Path(snapshot_download(ONNX_MODEL_ID, **download_kwargs))

        encoder_path = model_dir / "encoder.quantized.onnx"
        if not encoder_path.is_file():
            encoder_path = model_dir / "encoder.onnx"
        decoder_path = model_dir / "decoder.onnx"
        joiner_path = model_dir / "joiner.onnx"
        tokens_path = model_dir / "tokens.txt"
        missing = [
            path.name
            for path in (encoder_path, decoder_path, joiner_path, tokens_path)
            if not path.is_file()
        ]
        if missing:
            raise RuntimeError(f"ONNX モデルファイルが見つかりません: {', '.join(missing)}")

        self._recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(encoder_path),
            decoder=str(decoder_path),
            joiner=str(joiner_path),
            tokens=str(tokens_path),
            num_threads=CPU_THREADS,
            model_type="nemo_transducer",
            feature_dim=128,
        )
        self.backend = "cpu"
        self.model_id = ONNX_MODEL_ID
        self.engine_label = "Haas-ja-v1.0（CPU / ONNX）"
        self.ready = True
        LOGGER.info("Haas-ja（CPU / ONNX版）の読み込みが完了しました（threads=%s）。", CPU_THREADS)

    def _load(self) -> None:
        try:
            if DEVICE_PREF == "gpu":
                ok, reason = self._can_use_gpu()
                if not ok:
                    raise RuntimeError(reason)
                self._load_gpu()
            elif DEVICE_PREF == "cpu":
                self._load_cpu()
            elif DEVICE_PREF == "auto":
                ok, reason = self._can_use_gpu()
                if ok:
                    self._load_gpu()
                else:
                    LOGGER.info("CPU（ONNX）モードを選択しました（理由: %s）", reason)
                    self._load_cpu()
            else:
                raise RuntimeError(
                    f"HAAS_DEVICE の設定が正しくありません: {DEVICE_PREF}（auto / gpu / cpu のいずれかを指定してください）"
                )
        except Exception as exc:  # noqa: BLE001 - reported through /health
            self.error = str(exc) or exc.__class__.__name__
            LOGGER.error("Haas-ja モデルを読み込めませんでした: %s", self.error)
        finally:
            self.loading = False

    def status(self) -> dict:
        return {
            "engine": self.engine_label,
            "backend": self.backend,
            "model_id": self.model_id,
            "model_loaded": self.ready,
            "model_loading": self.loading,
            "model_error": self.error,
        }

    def unavailable_message(self) -> str:
        if self.error:
            return f"Haas-ja モデルを準備できませんでした: {self.error}"
        return "Haas-ja モデルを読み込み中です。初回はモデルの取得に数分かかります。しばらく待ってから再実行してください。"

    def transcribe(self, source: Path, on_progress: ProgressCallback | None = None) -> str:
        if not self.ready or self.backend not in ("gpu", "cpu"):
            raise RuntimeError(self.unavailable_message())

        def report(phase: str, progress: int | None = None) -> None:
            if on_progress is not None:
                on_progress(phase, progress)

        report("converting", None)
        with tempfile.TemporaryDirectory(prefix="rn-audio-") as tmp:
            wav = Path(tmp) / "input.wav"
            _to_wav(source, wav)

            if self.backend == "gpu":
                if self._model is None or self._haas_asr is None or self._torch is None:
                    raise RuntimeError(self.unavailable_message())
                audio = self._haas_asr.load_audio(str(wav))
                # Only one job may run inference at a time.
                with self._infer_lock:
                    report("transcribing", 0)
                    with self._torch.inference_mode():
                        if self._vocabulary is not None:
                            text = self._haas_asr.transcribe_longform(
                                self._model, audio, batch_size=BATCH_SIZE, vocabulary=self._vocabulary
                            )
                        else:
                            text = self._haas_asr.transcribe_longform(
                                self._model, audio, batch_size=BATCH_SIZE
                            )
                    report("transcribing", 100)
                    return text

            if self._recognizer is None:
                raise RuntimeError(self.unavailable_message())
            with self._infer_lock:
                report("transcribing", 0)
                texts: list[str] = []
                for samples, ratio in _cpu_wav_chunks(wav):
                    stream = self._recognizer.create_stream()
                    stream.accept_waveform(SAMPLE_RATE, samples)
                    self._recognizer.decode_stream(stream)
                    chunk_text = stream.result.text.strip()
                    if chunk_text:
                        texts.append(chunk_text)
                    report("transcribing", min(100, max(0, int(round(ratio * 100)))))
                return "".join(texts)
