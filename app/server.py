"""Local web server: paste text, get a natural-sounding narration."""

from __future__ import annotations

import io
import json
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field

from .engine import DEFAULT_VOICE, SAMPLE_RATE, VOICES, chunk, engine

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="TTS Reader")


@dataclass
class Job:
    id: str
    voice: str
    speed: float
    total: int
    done: int = 0
    state: str = "running"  # running | ready | error
    error: str = ""
    path: Path | None = None
    seconds: float = 0.0
    started: float = field(default_factory=time.time)
    events: queue.Queue = field(default_factory=queue.Queue)

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "done": self.done,
            "total": self.total,
            "error": self.error,
            "seconds": round(self.seconds, 1),
            "elapsed": round(time.time() - self.started, 1),
            "url": f"/audio/{self.id}.wav" if self.state == "ready" else None,
        }


JOBS: dict[str, Job] = {}


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: str = DEFAULT_VOICE
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


def _run_job(job: Job, text: str) -> None:
    try:
        pieces: list[np.ndarray] = []

        def progress(update) -> None:
            job.done = update.done
            job.events.put(job.snapshot())

        for piece in engine.stream(
            text, voice=job.voice, speed=job.speed, on_progress=progress
        ):
            pieces.append(piece)

        audio = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
        path = OUTPUT_DIR / f"{job.id}.wav"
        sf.write(path, audio, SAMPLE_RATE)
        job.path = path
        job.seconds = len(audio) / SAMPLE_RATE
        job.state = "ready"
    except Exception as exc:  # surfaced to the browser, not swallowed
        job.state = "error"
        job.error = f"{type(exc).__name__}: {exc}"
    finally:
        job.events.put(job.snapshot())


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (ROOT / "app" / "index.html").read_text()


@app.get("/voices")
def voices() -> dict:
    return {
        "default": DEFAULT_VOICE,
        "voices": [
            {"id": vid, "label": label, "accent": "US" if lang == "a" else "UK"}
            for lang, entries in VOICES.items()
            for vid, label in entries
        ],
    }


@app.post("/speak")
def speak(request: SpeakRequest) -> dict:
    chunks = chunk(request.text)
    if not chunks:
        raise HTTPException(status_code=400, detail="No readable text.")

    job = Job(
        id=uuid.uuid4().hex[:12],
        voice=request.voice,
        speed=request.speed,
        total=len(chunks),
    )
    JOBS[job.id] = job
    threading.Thread(target=_run_job, args=(job, request.text), daemon=True).start()
    return job.snapshot()


@app.get("/progress/{job_id}")
def progress(job_id: str) -> StreamingResponse:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")

    def events():
        yield f"data: {json.dumps(job.snapshot())}\n\n"
        while True:
            if job.state != "running" and job.events.empty():
                break
            try:
                update = job.events.get(timeout=15)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(update)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/audio/{job_id}.wav")
def audio(job_id: str) -> FileResponse:
    job = JOBS.get(job_id)
    if job is None or job.path is None or not job.path.exists():
        raise HTTPException(status_code=404, detail="Audio not ready.")
    return FileResponse(job.path, media_type="audio/wav", filename=f"narration-{job_id}.wav")


@app.post("/preview")
def preview(request: SpeakRequest) -> StreamingResponse:
    """Short sample of one voice, rendered straight to a WAV in memory."""
    audio_data = engine.synthesize(request.text[:300], voice=request.voice, speed=request.speed)
    buffer = io.BytesIO()
    sf.write(buffer, audio_data, SAMPLE_RATE, format="WAV")
    buffer.seek(0)
    return StreamingResponse(buffer, media_type="audio/wav")


@app.on_event("startup")
def startup() -> None:
    threading.Thread(target=engine.warm, daemon=True).start()
