"""Local web server: paste text, hear it read aloud as it renders."""

from __future__ import annotations

import base64
import binascii
import io
import ipaddress
import json
import os
import queue
import secrets
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

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

# No CORS headers on purpose. They would let any website open in the same
# browser read this server's answers, including the text being read aloud. The
# extensions do not need them: the Chrome one calls from its background worker
# and the editor one from outside a browser, and neither is held to CORS.

# Silence inserted between parts, in seconds.
GAP_SECONDS = 0.25

# What a part with nothing to say, like "---", plays. Not an empty file, which
# some browsers refuse to play, and which would stop the reading there.
QUIET_SECONDS = 0.1

# Set TTS_PASSWORD to require a password. Left unset (the local-only default),
# every request is allowed through.
PASSWORD = os.environ.get("TTS_PASSWORD", "").strip()


@app.middleware("http")
async def require_password(request: Request, call_next):
    """Gate every request behind HTTP basic auth when a password is set."""
    if not PASSWORD:
        return await call_next(request)

    # An <audio> element cannot send a password, so a part's audio is open to
    # anyone who has the reading's id. The id is long and random, and only comes
    # from routes that do need the password.
    if request.method == "GET" and request.url.path.startswith("/chunk/"):
        return await call_next(request)

    header = request.headers.get("authorization", "")
    if header.startswith("Basic "):
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8", "replace")
        except (ValueError, binascii.Error):
            decoded = ""
        _, _, supplied = decoded.partition(":")
        # Compared in constant time so the password cannot be guessed by
        # timing how long the check takes. As bytes, because the comparison
        # raises an error on text with any letter outside ASCII.
        if secrets.compare_digest(supplied.encode(), PASSWORD.encode()):
            return await call_next(request)

    return Response(
        status_code=401,
        content="Password required.",
        headers={"WWW-Authenticate": 'Basic realm="Earful"'},
    )


# Extra names this server answers to, comma separated, for anyone reaching it
# by a name of their own.
ALLOWED_HOSTS = {
    name.strip().lower()
    for name in os.environ.get("TTS_ALLOWED_HOSTS", "").split(",")
    if name.strip()
}

# Endings that only ever name something on a private network.
PRIVATE_ENDINGS = (".local", ".localhost", ".lan", ".home", ".internal", ".ts.net")


def _host_allowed(host: str) -> bool:
    """Whether a Host header names this machine, not a site on the internet."""
    try:
        name = (urlsplit(f"//{host}").hostname or "").lower()
    except ValueError:
        return False
    if name in ALLOWED_HOSTS or "." not in name or name.endswith(PRIVATE_ENDINGS):
        return True
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


@app.middleware("http")
async def refuse_other_names(request: Request, call_next):
    """Stop DNS rebinding: a website pointing its own name at this machine.

    The browser then treats that website and this server as one site, which gets
    past the rule against other sites. Only the Host header gives it away.
    """
    if not _host_allowed(request.headers.get("host", "")):
        return Response(
            status_code=403,
            content="This server does not answer to that name. See TTS_ALLOWED_HOSTS.",
        )
    return await call_next(request)


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
    # Bumped whenever a new render supersedes one in flight; the older thread
    # sees the change and stops instead of writing stale audio.
    generation: int = 0

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "voice": self.voice,
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


def _render_one(job: Job, body: str) -> tuple[np.ndarray, list[dict]]:
    """Speak one part's text, returning its audio and word timings."""
    audio_parts: list[np.ndarray] = []
    words: list[dict] = []
    offset = 0.0
    for segment in engine.stream(body, voice=job.voice, speed=job.speed):
        audio_parts.append(segment.audio)
        words.extend(
            {"t": w.text, "s": round(w.start + offset, 3), "e": round(w.end + offset, 3)}
            for w in segment.words
        )
        offset += len(segment.audio) / SAMPLE_RATE
    if not audio_parts:
        return np.zeros(int(SAMPLE_RATE * QUIET_SECONDS), dtype=np.float32), []
    return np.concatenate(audio_parts), words


def _render_job(
    job: Job,
    texts: list[str],
    kept: list[bytes | None] | None = None,
    kept_words: list[list[dict] | None] | None = None,
    generation: int = 0,
) -> None:
    """Speak a known list of parts, reusing any audio passed in `kept`.

    Part by part, so that every part ends up with exactly one file, even one
    with no sound. A missing file would give all later parts the wrong audio.
    """
    try:
        for i, body in enumerate(texts):
            if job.generation != generation:
                return          # superseded by a newer edit or voice change
            reuse = kept[i] if kept else None
            if reuse is not None:
                wav, words = reuse, (kept_words[i] if kept_words else [])
                seconds = len(sf.read(io.BytesIO(reuse), dtype="float32")[0]) / SAMPLE_RATE
            else:
                audio, words = _render_one(job, body)
                wav, seconds = _to_wav(audio), len(audio) / SAMPLE_RATE
            with job.lock:
                if job.generation != generation:
                    return
                job.chunks.append(wav)
                job.words.append(words or [])
                job.seconds += seconds
            job.publish()
        if job.generation == generation:
            job.state = "ready"
    except Exception as exc:  # surfaced to the browser, not swallowed
        if job.generation == generation:
            job.state = "error"
            job.error = f"{type(exc).__name__}: {exc}"
    finally:
        job.publish()


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return (ROOT / "app" / "index.html").read_text()


@app.get("/icon.png")
def icon() -> FileResponse:
    """The Earful logo, for the browser tab and a phone's Home Screen."""
    return FileResponse(ROOT / "app" / "icon.png", media_type="image/png")


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


KNOWN_VOICES = {vid for entries in VOICES.values() for vid, _ in entries}


@app.post("/speak")
def speak(request: SpeakRequest) -> dict:
    chunks = chunk(request.text)
    if not chunks:
        raise HTTPException(status_code=400, detail="No readable text.")
    if request.voice not in KNOWN_VOICES:
        # Without this the engine tries to download a voice file named after
        # whatever was sent and fails with an unhelpful 404 from the model host.
        raise HTTPException(status_code=400, detail=f"Unknown voice: {request.voice!r}")

    job = Job(
        id=secrets.token_hex(16),
        voice=request.voice,
        # Render at a fixed 1.0 and let the browser change tempo live, so the
        # speed slider never forces a re-render.
        speed=1.0,
        total=len(chunks),
        texts=chunks,
    )
    JOBS[job.id] = job
    threading.Thread(
        target=_render_job, args=(job, chunks, None, None, job.generation), daemon=True
    ).start()
    return {**job.snapshot(), "texts": job.texts}


class RevoiceAllRequest(BaseModel):
    voice: str


@app.post("/voice/{job_id}")
def change_voice(job_id: str, request: RevoiceAllRequest) -> dict:
    """Read the whole article again in a different voice."""
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")
    if request.voice not in KNOWN_VOICES:
        raise HTTPException(status_code=400, detail=f"Unknown voice: {request.voice!r}")
    if request.voice == job.voice:
        return {"voice": job.voice, "changed": False}

    with job.lock:
        # A render may be in flight; bumping the generation stops it rather
        # than refusing the user's request.
        job.generation += 1
        generation = job.generation
        texts = list(job.texts)
        job.voice = request.voice
        # Drop the rendered audio so the reader shows every part as pending
        # while the new voice is produced, part by part, as it was at first.
        job.chunks.clear()
        job.words.clear()
        job.state = "running"
        job.started = time.time()
        job.seconds = 0.0

    (OUTPUT_DIR / f"{job_id}.wav").unlink(missing_ok=True)
    threading.Thread(
        target=_render_job, args=(job, texts, None, None, generation), daemon=True
    ).start()
    return {"voice": job.voice, "changed": True, "total": job.total}


class RewriteRequest(BaseModel):
    text: str = Field(min_length=1)


@app.post("/rewrite/{job_id}")
def rewrite(job_id: str, request: RewriteRequest) -> dict:
    """Replace the article, re-speaking only the parts whose text changed."""
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")

    parts = chunk(request.text)
    if not parts:
        raise HTTPException(status_code=400, detail="No readable text.")

    with job.lock:
        job.generation += 1
        generation = job.generation
        old_texts = list(job.texts)
        old_chunks = list(job.chunks)
        old_words = list(job.words)

        # Keep the audio of any part whose text is unchanged and in the same
        # position; everything else is re-spoken.
        kept: list[bytes | None] = []
        kept_words: list[list[dict] | None] = []
        for i, body in enumerate(parts):
            same = i < len(old_texts) and old_texts[i] == body and i < len(old_chunks)
            kept.append(old_chunks[i] if same else None)
            kept_words.append(old_words[i] if same else None)

        job.texts = parts
        job.total = len(parts)
        job.chunks.clear()
        job.words.clear()
        job.state = "running"
        job.started = time.time()
        job.seconds = 0.0

    (OUTPUT_DIR / f"{job_id}.wav").unlink(missing_ok=True)
    threading.Thread(
        target=_render_job, args=(job, parts, kept, kept_words, generation), daemon=True
    ).start()
    reused = sum(1 for c in kept if c is not None)
    return {"total": len(parts), "texts": parts, "reused": reused}


@app.get("/progress-once/{job_id}")
def progress_once(job_id: str) -> dict:
    """One snapshot of a job's progress.

    EventSource cannot send an Authorization header, so the extension polls
    this instead of /progress when a password is set.
    """
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")
    # The parts are included so a page coming back after a refresh shows the
    # text as it is now, not as it was when the page last saved it.
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


class HandoffRequest(BaseModel):
    """Where a reader has got to, so another device can take over."""

    job: str
    index: int = Field(default=0, ge=0)
    at: float = Field(default=0.0, ge=0.0)
    title: str = ""


# The most recent handoff. One is enough: this is "carry on where I left off",
# not a queue, and the phone that picks it up wants the latest position.
HANDOFF: dict | None = None
HANDOFF_LOCK = threading.Lock()


@app.post("/handoff")
def set_handoff(request: HandoffRequest) -> dict:
    """Record the spot a reader has reached, for another device to resume."""
    job = JOBS.get(request.job)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job.")

    global HANDOFF
    with HANDOFF_LOCK:
        HANDOFF = {
            "job": request.job,
            "index": min(request.index, max(job.total - 1, 0)),
            "at": request.at,
            "title": request.title[:200],
            "total": job.total,
            "when": time.time(),
        }
        return dict(HANDOFF)


@app.get("/handoff")
def get_handoff() -> dict:
    """The spot to carry on from, or nothing if there is none to resume."""
    with HANDOFF_LOCK:
        spot = dict(HANDOFF) if HANDOFF else None

    # A job that no longer exists cannot be resumed; the server forgets jobs
    # when it restarts, so say so plainly rather than handing back a dead id.
    if not spot or spot["job"] not in JOBS:
        return {"waiting": True}

    spot["waiting"] = False
    spot["age"] = round(time.time() - spot["when"], 1)
    return spot


@app.get("/continue", response_class=HTMLResponse)
@app.get("/go", response_class=HTMLResponse)
def continue_page() -> str:
    """The page a phone opens to carry on reading.

    Also answers at /go, because this is an address typed on a phone keyboard
    and every character saved is worth having.
    """
    return (ROOT / "app" / "continue.html").read_text()


def _lan_address() -> str:
    """This machine's address on the local network, or "" if it has none."""
    import socket

    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Nothing is sent; connecting a UDP socket just picks the interface
        # that would carry traffic, which is the address a phone can reach.
        probe.connect(("192.0.2.1", 9))
        return probe.getsockname()[0]
    except OSError:
        return ""
    finally:
        probe.close()


def _listening_beyond_this_machine(port: int) -> bool:
    """Whether anything answers on the LAN address, not just on loopback.

    Asked of the running socket rather than the command line, because the
    command line is not visible to a worker process and says nothing about
    what actually ended up bound.
    """
    import socket

    address = _lan_address()
    if not address:
        return False

    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.3)
    try:
        probe.connect((address, port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def _tailscale() -> dict:
    """What Tailscale offers for reaching this machine.

    Returns the shortest name that works, and whether a proxy is set up that
    removes the port. Empty name when Tailscale is not up.

    A tunnel is worth preferring over the plain LAN address: many networks —
    most guest and office Wi-Fi — stop devices talking to each other. The
    machine's name is used rather than its number, because the name is the
    part that never changes.
    """
    import json
    import subprocess

    def run(*command: str) -> str:
        try:
            done = subprocess.run(
                command, capture_output=True, text=True, timeout=3,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        return done.stdout if done.returncode == 0 else ""

    raw = run("tailscale", "status", "--json")
    if not raw:
        return {"name": "", "proxied": False}

    try:
        status = json.loads(raw)
    except json.JSONDecodeError:
        return {"name": "", "proxied": False}

    # Tailscale answers even while switched off, naming a machine nobody can
    # reach. Only a running backend is an address worth offering.
    if status.get("BackendState") != "Running":
        return {"name": "", "proxied": False}

    self_node = status.get("Self") or {}
    # DNSName arrives with a trailing dot, which belongs in DNS but not a URL.
    full = (self_node.get("DNSName") or "").strip().rstrip(".")
    suffix = (status.get("MagicDNSSuffix") or "").strip().rstrip(".")

    # With MagicDNS the bare machine name resolves on its own, which is far
    # less to type on a phone than the whole tailnet name.
    name = full
    if full and suffix and full.endswith("." + suffix):
        name = full[: -len(suffix) - 1]

    if not name:
        addresses = self_node.get("TailscaleIPs") or []
        name = next((a for a in addresses if ":" not in a), "")

    # A proxy on port 80 means the address needs no port at all. Asked of the
    # serve config rather than guessed from its printed layout.
    served = run("tailscale", "serve", "status", "--json")
    proxied = False
    if served:
        try:
            handlers = (json.loads(served) or {}).get("Web") or {}
            proxied = any(host.endswith(":80") for host in handlers)
        except json.JSONDecodeError:
            proxied = False

    return {"name": name, "proxied": proxied}


@app.get("/phone")
def phone_link(request: Request) -> dict:
    """The address to open on a phone to carry on reading."""
    port = request.url.port or 80
    serving = _listening_beyond_this_machine(port)

    # A tunnel address works from anywhere and survives networks that keep
    # devices apart, so it is offered ahead of the plain local one.
    tunnel = _tailscale()
    if tunnel["name"]:
        # With a proxy in front there is no port to name, which leaves the
        # shortest address this machine can offer.
        host = tunnel["name"] if tunnel["proxied"] else f"{tunnel['name']}:{port}"
        return {
            "url": f"http://{host}/go",
            "reachable": True,
            "tunnel": True,
            "password": bool(PASSWORD),
        }

    address = _lan_address()
    return {
        "url": f"http://{address}:{port}/go" if address else "",
        # A server listening only on this machine cannot be reached by a phone
        # however good the address is, so say so rather than offering a link
        # that will quietly fail.
        "reachable": bool(address) and serving,
        "tunnel": False,
        "password": bool(PASSWORD),
    }


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
    if request.voice not in KNOWN_VOICES:
        raise HTTPException(status_code=400, detail=f"Unknown voice: {request.voice!r}")
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
