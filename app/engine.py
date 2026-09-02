"""Kokoro text-to-speech engine with chunking for long documents."""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Callable, Iterator

import numpy as np

SAMPLE_RATE = 24000

# Kokoro voices, grouped by the language code its pipeline needs.
VOICES: dict[str, list[tuple[str, str]]] = {
    "a": [
        ("af_heart", "Heart — US female, warmest overall"),
        ("af_bella", "Bella — US female, expressive"),
        ("af_nicole", "Nicole — US female, soft/ASMR"),
        ("af_aoede", "Aoede — US female, calm"),
        ("af_kore", "Kore — US female, clear"),
        ("af_sarah", "Sarah — US female, bright"),
        ("am_michael", "Michael — US male, warm"),
        ("am_fenrir", "Fenrir — US male, deep"),
        ("am_puck", "Puck — US male, lively"),
        ("am_adam", "Adam — US male, neutral"),
    ],
    "b": [
        ("bf_emma", "Emma — UK female, rich"),
        ("bf_isabella", "Isabella — UK female, poised"),
        ("bm_george", "George — UK male, classic narrator"),
        ("bm_fable", "Fable — UK male, storyteller"),
        ("bm_daniel", "Daniel — UK male, measured"),
    ],
}

DEFAULT_VOICE = "af_heart"

# Splitting a chunk: try paragraph breaks, then sentence ends, then any space.
_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
# Python lookbehind must be fixed width, so spell out both cases: a bare
# sentence end, or one followed by a closing quote or bracket.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|(?<=[.!?][\"')\]])\s+")

# Roughly the length Kokoro handles in one pass without losing prosody.
MAX_CHUNK_CHARS = 800

# A chunk is also a jump target in the reader, so keep them paragraph-sized:
# never glue more than this many paragraphs together, however short they are.
MAX_PARAGRAPHS_PER_CHUNK = 1


def _lang_code(voice: str) -> str:
    """Kokoro picks its phonemizer from the voice name's first letter."""
    return voice[0] if voice and voice[0] in VOICES else "a"


def normalize(text: str) -> str:
    """Tidy pasted article text: strip odd whitespace, keep paragraph breaks."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace(" ", " ").replace("​", "")
    # Curly quotes and dashes confuse the phonemizer more than they help.
    for bad, good in (
        ("‘", "'"), ("’", "'"),
        ("“", '"'), ("”", '"'),
        ("–", "-"), ("—", " - "),
        ("…", "..."),
    ):
        text = text.replace(bad, good)
    # Collapse runs of spaces/tabs, and runs of blank lines down to one break.
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _split_long(piece: str, limit: int) -> list[str]:
    """Break one oversized piece on sentence ends, then on spaces as a last resort."""
    if len(piece) <= limit:
        return [piece]

    out: list[str] = []
    buffer = ""
    for sentence in _SENTENCE_SPLIT.split(piece):
        if not sentence:
            continue
        if len(buffer) + len(sentence) + 1 <= limit:
            buffer = f"{buffer} {sentence}".strip()
            continue
        if buffer:
            out.append(buffer)
        if len(sentence) <= limit:
            buffer = sentence
            continue
        # A single sentence longer than the limit: cut it on word boundaries.
        words = sentence.split(" ")
        buffer = ""
        for word in words:
            if len(buffer) + len(word) + 1 <= limit:
                buffer = f"{buffer} {word}".strip()
            else:
                if buffer:
                    out.append(buffer)
                buffer = word
    if buffer:
        out.append(buffer)
    return out


def chunk(text: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Cut a document into speakable chunks, preferring paragraph boundaries."""
    text = normalize(text)
    if not text:
        return []

    chunks: list[str] = []
    buffer = ""
    held = 0  # paragraphs currently merged into buffer

    def flush() -> None:
        nonlocal buffer, held
        if buffer:
            chunks.append(buffer)
        buffer = ""
        held = 0

    for paragraph in _PARAGRAPH_SPLIT.split(text):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        # Merge only while both the length and the paragraph count allow it.
        if (
            held < MAX_PARAGRAPHS_PER_CHUNK
            and len(buffer) + len(paragraph) + 2 <= limit
        ):
            buffer = f"{buffer}\n\n{paragraph}".strip()
            held += 1
            continue
        flush()
        parts = _split_long(paragraph, limit)
        # A paragraph too long for one pass becomes several parts; the last
        # one stays open in case the next paragraph still fits beside it.
        for part in parts[:-1]:
            chunks.append(part)
        buffer = parts[-1]
        held = 1
    flush()
    return chunks


@dataclass
class Progress:
    done: int
    total: int
    text: str


@dataclass
class Word:
    """One spoken word, timed from the start of its chunk."""

    text: str
    start: float
    end: float


@dataclass
class Segment:
    """A piece of rendered audio plus the words heard in it."""

    audio: np.ndarray
    words: list[Word]


class Engine:
    """Lazily loads one Kokoro pipeline per language code and reuses it."""

    def __init__(self) -> None:
        self._pipelines: dict[str, object] = {}
        self._lock = threading.Lock()

    def pipeline(self, lang: str):
        with self._lock:
            if lang not in self._pipelines:
                from kokoro import KPipeline

                self._pipelines[lang] = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
            return self._pipelines[lang]

    def warm(self, voice: str = DEFAULT_VOICE) -> None:
        """Download and load weights up front so the first request is not slow."""
        self.pipeline(_lang_code(voice))

    def synthesize(
        self,
        text: str,
        voice: str = DEFAULT_VOICE,
        speed: float = 1.0,
        on_progress: Callable[[Progress], None] | None = None,
    ) -> np.ndarray:
        """Render the whole text to one audio array, chunk by chunk."""
        pieces = [
            segment.audio
            for segment in self.stream(
                text, voice=voice, speed=speed, on_progress=on_progress
            )
        ]
        if not pieces:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(pieces)

    def stream(
        self,
        text: str,
        voice: str = DEFAULT_VOICE,
        speed: float = 1.0,
        on_progress: Callable[[Progress], None] | None = None,
    ) -> Iterator["Segment"]:
        """Yield audio one chunk at a time, with a short pause between chunks."""
        chunks = chunk(text)
        if not chunks:
            return

        pipeline = self.pipeline(_lang_code(voice))
        gap = np.zeros(int(SAMPLE_RATE * 0.25), dtype=np.float32)

        for index, piece in enumerate(chunks, start=1):
            audio_parts: list[np.ndarray] = []
            words: list[Word] = []
            offset = 0.0  # seconds of audio already emitted for this chunk

            for result in pipeline(piece, voice=voice, speed=speed):
                if result.audio is None:
                    continue
                audio = result.audio.detach().cpu().numpy().astype(np.float32)
                # Kokoro times each token from the start of its own result, so
                # shift them by the audio already produced for this chunk.
                for token in getattr(result, "tokens", None) or []:
                    start, end = token.start_ts, token.end_ts
                    if start is None or end is None or not token.text.strip():
                        continue
                    words.append(
                        Word(
                            text=token.text,
                            start=float(start) + offset,
                            end=float(end) + offset,
                        )
                    )
                audio_parts.append(audio)
                offset += len(audio) / SAMPLE_RATE

            if audio_parts:
                yield Segment(audio=np.concatenate(audio_parts), words=words)
                if index < len(chunks):
                    yield Segment(audio=gap, words=[])
            if on_progress:
                on_progress(Progress(done=index, total=len(chunks), text=piece))


engine = Engine()
