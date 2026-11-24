#!/usr/bin/env python3
"""RecordingNote local server.

Serves the static page and provides the local Haas-ja transcription API and the
Gemini note API from the same origin. Only localhost is used: there is no login,
no tunnel, and no cloud transcription backend.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, Response  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402
import uvicorn  # noqa: E402

from asr_backend import Transcriber  # noqa: E402
from notes import NoteGenerationError, configured_model, load_provider  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
LOGGER = logging.getLogger("recordingnote")

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "2048") or 2048)
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
MAX_JOBS = 20
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/README.md": ("README.md", "text/markdown; charset=utf-8"),
}

transcriber = Transcriber()


class Job:
    __slots__ = ("id", "status", "phase", "progress", "text", "error", "chars", "created")

    def __init__(self) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.status = "queued"
        self.phase = "queued"
        self.progress: int | None = None
        self.text: str | None = None
        self.error: str | None = None
        self.chars = 0
        self.created = time.monotonic()


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()


class NoteRequest(BaseModel):
    transcript: str = Field(min_length=1)
    title: str = ""


def _store_job(job: Job) -> None:
    with JOBS_LOCK:
        JOBS[job.id] = job
        if len(JOBS) > MAX_JOBS:
            for old in sorted(JOBS.values(), key=lambda item: item.created)[: len(JOBS) - MAX_JOBS]:
                JOBS.pop(old.id, None)


def _job_payload(job: Job) -> dict:
    return {
        "job_id": job.id,
        "status": job.status,
        "phase": job.phase,
        "progress": job.progress,
        "text": job.text,
        "error": job.error,
        "chars": job.chars,
    }


def _run_job(job: Job, source: Path, workdir: Path) -> None:
    def on_progress(phase: str, progress: int | None) -> None:
        job.phase = phase
        job.progress = progress

    job.status = "running"
    job.phase = "converting"
    try:
        job.text = transcriber.transcribe(source, on_progress=on_progress)
        job.chars = len(job.text)
        job.progress = 100
        job.phase = "done"
        job.status = "done"
        LOGGER.info("文字起こし完了: job=%s chars=%s", job.id, job.chars)
    except Exception as exc:  # noqa: BLE001 - shown in the browser
        job.error = str(exc) or exc.__class__.__name__
        job.phase = "error"
        job.status = "error"
        LOGGER.exception("文字起こし失敗: job=%s", job.id)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    transcriber.start_loading()
    yield


app = FastAPI(title="RecordingNote", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict:
    provider = load_provider()
    return {
        "ok": True,
        **transcriber.status(),
        "notes": {
            "ready": provider is not None,
            "provider": provider.name if provider else None,
            "model": provider.model if provider else configured_model(),
        },
    }


@app.post("/jobs")
async def create_job(file: UploadFile = File(...)) -> dict:
    if not transcriber.ready:
        raise HTTPException(status_code=503, detail=transcriber.unavailable_message())

    job = Job()
    workdir = Path(tempfile.mkdtemp(prefix=f"rn-{job.id}-"))
    suffix = re.sub(r"[^a-z0-9.]", "", Path(file.filename or "").suffix.lower())[:10] or ".webm"
    source = workdir / f"input{suffix}"
    size = 0
    try:
        with source.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"音声ファイルが大きすぎます（上限 {MAX_UPLOAD_MB} MB）。短く分けて送信してください。",
                    )
                output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=422, detail="音声ファイルが空です。録音またはファイル選択をやり直してください。")
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise

    _store_job(job)
    threading.Thread(target=_run_job, args=(job, source, workdir), name=f"job-{job.id}", daemon=True).start()
    return {"job_id": job.id, "status": job.status}


@app.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="ジョブが見つかりません。音声を送り直してください。")
    return _job_payload(job)


@app.post("/notes")
def create_note(request: NoteRequest) -> dict:
    if not request.transcript.strip():
        raise HTTPException(status_code=422, detail="文字起こしが空です。")
    provider = load_provider()
    if provider is None:
        raise HTTPException(
            status_code=503,
            detail="Gemini APIキーが未設定です。プロジェクト直下の .env に GEMINI_API_KEY を設定してから再実行してください。",
        )
    try:
        note = provider.generate(request.transcript, title=request.title)
    except NoteGenerationError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"note": note}


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    return Response(status_code=204)


@app.get("/{path:path}", include_in_schema=False)
def static_file(path: str) -> FileResponse:
    key = "/" + path if path else "/"
    entry = STATIC_FILES.get(key)
    if entry is None:
        raise HTTPException(status_code=404, detail="Not found")
    name, media_type = entry
    return FileResponse(ROOT / name, media_type=media_type, headers={"Cache-Control": "no-store"})


def _open_browser_when_ready(host: str, port: int) -> None:
    connect_host = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    url = f"http://{connect_host}:{port}"
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((connect_host, port), timeout=0.5):
                webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.15)


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.environ.get("PORT", "8000") or 8000)
    display_host = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    provider = load_provider()
    notes_state = (
        f"Gemini（設定済み / {provider.model}）"
        if provider
        else "未設定（使う場合は .env に GEMINI_API_KEY を設定）"
    )
    print(
        "\nRecordingNote ローカルサーバー\n"
        f"  ページ: http://{display_host}:{port}\n"
        "  文字起こし: Haas-ja-v1.0（環境に応じて GPU / CPU ONNX を自動選択）\n"
        f"  ノート生成: {notes_state}\n"
        "  終了: Ctrl+C\n",
        flush=True,
    )
    if host not in ("127.0.0.1", "localhost", "::1"):
        print("警告: このサーバーには認証がありません。LANやインターネットへ公開しないでください。\n", flush=True)
    if "--open" in sys.argv[1:] and os.environ.get("NO_BROWSER", "").strip().lower() not in ("1", "true", "yes"):
        threading.Thread(target=_open_browser_when_ready, args=(host, port), name="open-browser", daemon=True).start()
    uvicorn.run(app, host=host, port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
