"""Local web server: paste text, hear it read aloud as it renders."""

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
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from .engine import DEFAULT_VOICE, SAMPLE_RATE, VOICES, chunk, engine

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = ROOT / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="TTS Reader")

# Silence inserted between parts, in seconds.
GAP_SECONDS = 0.25


@dataclass
class Job:
    """One narration. Chunks become playable the moment each is rendered."""

    id: str
    voice: str
    speed: float
    total: int
    chunks: list[bytes] = field(default_factory=list)
    texts: list[str] = field(default_factory=list)
    words: list[list[dict]] = field(default_factory=list)
    state: str = "running"  # running | ready | error
    error: str = ""
    seconds: float = 0.0
    started: float = field(default_factory=time.time)
    listeners: list[queue.Queue] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "done": len(self.chunks),
            "total": self.total,
            "error": self.error,
            "seconds": round(self.seconds, 1),
            "elapsed": round(time.time() - self.started, 1),
        }

    def publish(self) -> None:
        """Tell every open progress stream that something changed."""
        update = self.snapshot()
        with self.lock:
            listeners = list(self.listeners)
        for listener in listeners:
            listener.put(update)


JOBS: dict[str, Job] = {}


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1)
    voice: str = DEFAULT_VOICE
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


def _to_wav(audio: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, audio, SAMPLE_RATE, format="WAV")
    return buffer.getvalue()


def _run_job(job: Job, text: str) -> None:
    try:
        for segment in engine.stream(text, voice=job.voice, speed=job.speed):
            if not segment.words:
                # The pause between chunks. It is not a part of its own, and
                # dropping it would run the paragraphs together, so it is left
                # for the browser to supply as a gap between parts.
                continue
            with job.lock:
                job.chunks.append(_to_wav(segment.audio))
                job.words.append(
                    [
                        {"t": w.text, "s": round(w.start, 3), "e": round(w.end, 3)}
                        for w in segment.words
                    ]
                )
                job.seconds += len(segment.audio) / SAMPLE_RATE
            job.publish()
        job.state = "ready"
    except Exception as exc:  # surfaced to the browser, not swallowed
        job.state = "error"
        job.error = f"{type(exc).__name__}: {exc}"
    finally:
        job.publish()


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
        # Render at a fixed 1.0 and let the browser change tempo live, so the
        # speed slider never forces a re-render.
        speed=1.0,
        total=len(chunks),
        texts=chunks,
    )
    JOBS[job.id] = job
    threading.Thread(target=_run_job, args=(job, request.text), daemon=True).start()
    return {**job.snapshot(), "texts": job.texts}


@app.get("/progress/{job_id}")
def progress(job_id: str) -> StreamingResponse:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")

    listener: queue.Queue = queue.Queue()
    with job.lock:
        job.listeners.append(listener)

    def events():
        try:
            yield f"data: {json.dumps(job.snapshot())}\n\n"
            while True:
                if job.state != "running" and listener.empty():
                    break
                try:
                    update = listener.get(timeout=15)
                except queue.Empty:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(update)}\n\n"
        finally:
            with job.lock:
                if listener in job.listeners:
                    job.listeners.remove(listener)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _range_response(data: bytes, range_header: str | None) -> Response:
    """Serve bytes, honoring Range. Browsers stall on media without this."""
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    if not range_header or not range_header.startswith("bytes="):
        headers["Content-Length"] = str(len(data))
        return Response(content=data, media_type="audio/wav", headers=headers)

    spec = range_header.removeprefix("bytes=").split(",")[0].strip()
    start_text, _, end_text = spec.partition("-")
    try:
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else len(data) - 1
        else:
            # A suffix range: the last N bytes.
            start = max(len(data) - int(end_text), 0)
            end = len(data) - 1
    except ValueError:
        raise HTTPException(status_code=416, detail="Bad range.")

    if start >= len(data):
        raise HTTPException(status_code=416, detail="Range out of bounds.")
    end = min(end, len(data) - 1)
    body = data[start : end + 1]
    headers["Content-Range"] = f"bytes {start}-{end}/{len(data)}"
    headers["Content-Length"] = str(len(body))
    return Response(content=body, status_code=206, media_type="audio/wav", headers=headers)


@app.get("/chunk/{job_id}/{index}.wav")
def chunk_audio(job_id: str, index: int, request: Request) -> Response:
    """One rendered chunk, fetched by the player as soon as it exists."""
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")
    with job.lock:
        if index >= len(job.chunks):
            raise HTTPException(status_code=404, detail="Chunk not ready.")
        data = job.chunks[index]
    return _range_response(data, request.headers.get("range"))


@app.get("/words/{job_id}/{index}")
def chunk_words(job_id: str, index: int) -> dict:
    """Word timings for one part, so the reader can follow along."""
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")
    with job.lock:
        if index >= len(job.words):
            raise HTTPException(status_code=404, detail="Part not ready.")
        return {"index": index, "words": job.words[index]}


@app.get("/download/{job_id}.wav")
def download(job_id: str) -> FileResponse:
    """Join every chunk into one file, for keeping."""
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")
    if job.state != "ready":
        raise HTTPException(status_code=409, detail="Still reading.")

    path = OUTPUT_DIR / f"{job_id}.wav"
    if not path.exists():
        with job.lock:
            parts = [sf.read(io.BytesIO(c), dtype="float32")[0] for c in job.chunks]
        # Put back the pause the player leaves between parts.
        gap = np.zeros(int(SAMPLE_RATE * GAP_SECONDS), dtype="float32")
        joined: list[np.ndarray] = []
        for i, part in enumerate(parts):
            joined.append(part)
            if i < len(parts) - 1:
                joined.append(gap)
        sf.write(path, np.concatenate(joined), SAMPLE_RATE)
    return FileResponse(path, media_type="audio/wav", filename=f"narration-{job_id}.wav")


@app.post("/preview")
def preview(request: SpeakRequest) -> Response:
    """Short sample of one voice, rendered straight to a WAV in memory."""
    audio = engine.synthesize(request.text[:300], voice=request.voice, speed=1.0)
    data = _to_wav(audio)
    return Response(
        content=data,
        media_type="audio/wav",
        headers={"Accept-Ranges": "bytes", "Content-Length": str(len(data))},
    )


@app.on_event("startup")
def startup() -> None:
    threading.Thread(target=engine.warm, daemon=True).start()
