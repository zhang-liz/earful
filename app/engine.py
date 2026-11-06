"""Kokoro text-to-speech engine with chunking for long documents."""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
import threading
from pathlib import Path
from dataclasses import dataclass
from typing import Callable, Iterator

import numpy as np

SAMPLE_RATE = 24000

# espeak-ng (English sounds) cannot use a data folder whose real path is
# longer than this. It falls back to a folder that does not exist and ends the
# whole process. A deep clone, or a downloaded Mac app that macOS runs from its
# hidden App Translocation folder, gets a longer path than this.
ESPEAK_PATH_LIMIT = 159


def _cache_folders() -> list[Path]:
    """Places to keep a copy of espeak's data, shortest-lived last."""
    home = Path.home()
    if sys.platform == "darwin":
        first = home / "Library" / "Caches" / "Earful"
    else:
        first = Path(os.environ.get("XDG_CACHE_HOME") or home / ".cache") / "earful"
    return [first, Path(tempfile.gettempdir()) / f"earful-{os.getuid()}"]


def use_short_espeak_data() -> None:
    """Point espeak at a copy of its data on a short path, when it needs one.

    The copy is made once per espeakng_loader version (about 19 MB), then
    reused. Nothing changes when the installed path is short enough.
    """
    import espeakng_loader

    data = Path(espeakng_loader.get_data_path()).resolve()
    if len(str(data)) <= ESPEAK_PATH_LIMIT:
        return
    from importlib.metadata import version

    stamp = f"espeakng-loader {version('espeakng-loader')}"
    for folder in _cache_folders():
        target = (folder / "espeak-ng-data").resolve()
        if len(str(target)) > ESPEAK_PATH_LIMIT:
            continue
        marker = folder / "espeak-ng-data.version"
        try:
            if not (target.is_dir() and marker.exists() and marker.read_text() == stamp):
                folder.mkdir(parents=True, exist_ok=True)
                # Copy beside it, then swap in, so a half-made copy is never used.
                staging = Path(tempfile.mkdtemp(dir=folder))
                shutil.copytree(data, staging / "espeak-ng-data")
                shutil.rmtree(target, ignore_errors=True)
                try:
                    (staging / "espeak-ng-data").rename(target)
                except OSError:
                    # Another server made the same copy first; theirs will do.
                    if not target.is_dir():
                        raise
                finally:
                    shutil.rmtree(staging, ignore_errors=True)
                marker.write_text(stamp)
        except OSError:
            continue
        espeakng_loader.get_data_path = lambda path=str(target): path
        espeak = sys.modules.get("misaki.espeak")
        if espeak is not None:   # already imported with the long path
            espeak.EspeakWrapper.set_data_path(str(target))
        return


@dataclass(frozen=True)
class Language:
    """A language Earful reads, and the Kokoro model that reads it."""

    id: str             # "en", "zh": also the key apps use
    name: str           # in its own language, for pickers
    model: str          # Hugging Face repo of the Kokoro model
    default_voice: str
    sample: str         # what a voice preview says


LANGUAGES: dict[str, Language] = {
    "en": Language("en", "English", "hexgrad/Kokoro-82M", "af_heart",
                   "Hello! This is how I sound when I read to you."),
    # The Chinese model, not the first Kokoro model's Chinese voices: it reads
    # English words inside Chinese and changes tones the way speakers do.
    "zh": Language("zh", "中文", "hexgrad/Kokoro-82M-v1.1-zh", "zf_044",
                   "你好！我是 Earful，这就是我为你朗读时的声音。"),
}


@dataclass(frozen=True)
class Voice:
    id: str
    language: str              # a LANGUAGES key
    labels: dict[str, str]     # its name in each screen language
    accent: str = ""           # "US", "UK": what older apps show


def _v(vid: str, en: str, zh: str, language: str = "en", accent: str = "") -> Voice:
    return Voice(vid, language, {"en": en, "zh": zh}, accent)


VOICES: tuple[Voice, ...] = (
    _v("am_michael", "Michael — US male, warm", "Michael — 美式男声，温暖", accent="US"),
    _v("af_heart", "Heart — US female, warmest overall", "Heart — 美式女声，最温暖", accent="US"),
    _v("af_bella", "Bella — US female, expressive", "Bella — 美式女声，富有表现力", accent="US"),
    _v("af_nicole", "Nicole — US female, soft/ASMR", "Nicole — 美式女声，轻柔", accent="US"),
    _v("af_aoede", "Aoede — US female, calm", "Aoede — 美式女声，平静", accent="US"),
    _v("af_kore", "Kore — US female, clear", "Kore — 美式女声，清晰", accent="US"),
    _v("af_sarah", "Sarah — US female, bright", "Sarah — 美式女声，明亮", accent="US"),
    _v("am_fenrir", "Fenrir — US male, deep", "Fenrir — 美式男声，低沉", accent="US"),
    _v("am_puck", "Puck — US male, lively", "Puck — 美式男声，活泼", accent="US"),
    _v("am_adam", "Adam — US male, neutral", "Adam — 美式男声，中性", accent="US"),
    _v("bf_emma", "Emma — UK female, rich", "Emma — 英式女声，饱满", accent="UK"),
    _v("bf_isabella", "Isabella — UK female, poised", "Isabella — 英式女声，从容", accent="UK"),
    _v("bm_george", "George — UK male, classic narrator", "George — 英式男声，经典旁白", accent="UK"),
    _v("bm_fable", "Fable — UK male, storyteller", "Fable — 英式男声，讲故事", accent="UK"),
    _v("bm_daniel", "Daniel — UK male, measured", "Daniel — 英式男声，沉稳", accent="UK"),
    # Six of the Chinese model's hundred voices: all read clearly, so these
    # were picked for range, low to high, at an even pace.
    _v("zf_044", "Mandarin female — natural", "普通话女声 — 自然", "zh"),
    _v("zf_094", "Mandarin female — soft, low", "普通话女声 — 柔和", "zh"),
    _v("zf_092", "Mandarin female — bright", "普通话女声 — 清亮", "zh"),
    _v("zm_064", "Mandarin male — natural", "普通话男声 — 自然", "zh"),
    _v("zm_014", "Mandarin male — deep", "普通话男声 — 低沉", "zh"),
    _v("zm_016", "Mandarin male — bright", "普通话男声 — 明朗", "zh"),
)

KNOWN_VOICES: dict[str, Voice] = {v.id: v for v in VOICES}

DEFAULT_VOICE = LANGUAGES["en"].default_voice


def voice_language(voice: str) -> str:
    """The language a voice reads: "en" or "zh"."""
    known = KNOWN_VOICES.get(voice)
    return known.language if known else "en"


def voice_for(language: str, picks: dict[str, str]) -> str:
    """The voice to read a language with: the reader's pick, else the default."""
    pick = picks.get(language)
    return pick if pick and voice_language(pick) == language else LANGUAGES[language].default_voice


# A part is Chinese when Chinese characters are at least this share of its
# letters. One Chinese character is about one English word, so English words
# inside Chinese text do not tip it, and a Chinese name in English does not.
_HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN = re.compile(r"[A-Za-z]")
CHINESE_SHARE = 0.3


def detect_language(text: str) -> str:
    """Which language a part is written in."""
    han = len(_HAN.findall(text))
    if not han:
        return "en"
    latin = len(_LATIN.findall(text))
    return "zh" if han >= CHINESE_SHARE * (han + latin) else "en"


# Splitting a chunk: try paragraph breaks, then sentence ends, then any space.
_PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
# Python lookbehind must be fixed width, so spell out both cases: a bare
# sentence end, or one followed by a closing quote or bracket. Chinese
# sentence ends need no space after them.
_SENTENCE_SPLIT = re.compile(
    r"(?<=[.!?])\s+|(?<=[.!?][\"')\]])\s+"
    r"|(?<=[。！？；…])(?![”」』）\"')])\s*|(?<=[。！？][”」』）\"')])\s*"
)
# Inside a long Chinese sentence: after a comma-like mark.
_CLAUSE_SPLIT = re.compile(r"(?<=[，、：,;:])\s*")

# Roughly the length Kokoro handles in one pass without losing prosody.
MAX_CHUNK_CHARS = 800

# A chunk is also a jump target in the reader, so keep them paragraph-sized:
# never glue more than this many paragraphs together, however short they are.
MAX_PARAGRAPHS_PER_CHUNK = 1

# Kokoro cuts anything longer than this many sounds, silently. Chinese pieces
# are kept under it with room to spare.
MAX_PHONEMES = 500
# A Chinese character is about three sounds, so this is well under the limit.
ZH_PIECE_CHARS = 120


def _lang_code(voice: str) -> str:
    """Kokoro picks its phonemizer from the voice name's first letter."""
    return voice[0] if voice and voice[0] in "abz" else "a"


def normalize(text: str) -> str:
    """Tidy pasted article text: strip odd whitespace, keep paragraph breaks."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace(" ", " ").replace("\u200b", "")
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


def _join(left: str, right: str) -> str:
    """Put two pieces of one paragraph back together: Chinese takes no space."""
    if not left:
        return right
    if _HAN.match(right[:1]) or _HAN.match(left[-1:]) or left[-1:] in "，。！？；：、”」』）":
        return left + right
    return f"{left} {right}"


def _cut(text: str, splitter: re.Pattern, limit: int) -> list[str]:
    """Pack the pieces a splitter makes into runs no longer than `limit`."""
    out: list[str] = []
    buffer = ""
    for piece in splitter.split(text):
        if not piece:
            continue
        joined = _join(buffer, piece)
        if len(joined) <= limit:
            buffer = joined
            continue
        if buffer:
            out.append(buffer)
        buffer = piece
    if buffer:
        out.append(buffer)
    return out


def _split_long(piece: str, limit: int) -> list[str]:
    """Break one oversized piece on sentence ends, then clauses, then words."""
    if len(piece) <= limit:
        return [piece]
    out: list[str] = []
    for sentence in _cut(piece, _SENTENCE_SPLIT, limit):
        if len(sentence) <= limit:
            out.append(sentence)
            continue
        for clause in _cut(sentence, _CLAUSE_SPLIT, limit):
            if len(clause) <= limit:
                out.append(clause)
            elif " " in clause:
                out.extend(_cut(clause, re.compile(" "), limit))
            else:
                # Chinese with no mark at all: cut by length, as nothing better
                # is known. Nothing is lost, the voice just pauses there.
                out.extend(clause[i:i + limit] for i in range(0, len(clause), limit))
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
class ZhToken:
    """One word of Chinese text, the sounds Kokoro reads for it, and what follows."""

    text: str
    phonemes: str
    gap: str = ""      # a word separator Kokoro also reads, such as "/" or " "


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
                use_short_espeak_data()
                from kokoro import KPipeline

                if lang == "z":
                    english = self._pipelines.get("a") or KPipeline(
                        lang_code="a", repo_id=LANGUAGES["en"].model
                    )
                    self._pipelines.setdefault("a", english)
                    self._pipelines[lang] = KPipeline(
                        lang_code="z",
                        repo_id=LANGUAGES["zh"].model,
                        # English words inside Chinese, read as English.
                        en_callable=lambda text: english.g2p(text)[0],
                    )
                else:
                    self._pipelines[lang] = KPipeline(lang_code=lang, repo_id=LANGUAGES["en"].model)
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

        render = self._render_zh if voice_language(voice) == "zh" else self._render_en
        gap = np.zeros(int(SAMPLE_RATE * 0.25), dtype=np.float32)

        for index, piece in enumerate(chunks, start=1):
            audio_parts, words = render(piece, voice, speed)
            if audio_parts:
                yield Segment(audio=np.concatenate(audio_parts), words=words)
                if index < len(chunks):
                    yield Segment(audio=gap, words=[])
            if on_progress:
                on_progress(Progress(done=index, total=len(chunks), text=piece))

    def _render_en(self, piece: str, voice: str, speed: float) -> tuple[list[np.ndarray], list[Word]]:
        """Kokoro reads and times English itself."""
        pipeline = self.pipeline(_lang_code(voice))
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
                words.append(Word(text=token.text, start=float(start) + offset, end=float(end) + offset))
            audio_parts.append(audio)
            offset += len(audio) / SAMPLE_RATE
        return audio_parts, words

    # ---- Chinese ---------------------------------------------------------
    # Kokoro's own Chinese path cuts long text at 510 sounds without a word
    # and times no words. So Earful turns the text into sounds itself, word by
    # word, sends short pieces, and times each word from the model's length
    # for each sound.

    def zh_tokens(self, text: str) -> list[ZhToken]:
        """Chinese text as words with their sounds, as Kokoro's Chinese reader makes them."""
        import cn2an
        from misaki.zh import ZHG2P

        pipeline = self.pipeline("z")
        g2p = pipeline.g2p
        text = ZHG2P.map_punctuation(cn2an.transform(text, "an2cn"))
        tokens: list[ZhToken] = []
        for english, chinese in re.findall(r"([A-Za-z \'-]*[A-Za-z][A-Za-z \'-]*)|([^A-Za-z]+)", text):
            english, chinese = english.strip(), chinese.strip()
            if tokens:
                tokens[-1].gap += " "      # Kokoro's reader puts a space between runs
            if chinese:
                _, found = g2p.frontend(chinese)
                for token in found:
                    tokens.append(ZhToken(token.text, token.phonemes or "", token.whitespace or ""))
            elif english:
                tokens.append(ZhToken(english, g2p.en_callable(english), ""))
        return tokens

    def zh_infer(self, phonemes: str, voice: str, speed: float) -> tuple[np.ndarray, int, list[int]]:
        """Speak sounds. Returns the audio, the lead-in frames, and the frames for each sound.

        A frame is 1/40 s. Sounds the model does not know take no frames.
        """
        pipeline = self.pipeline("z")
        result = next(pipeline.generate_from_tokens(phonemes, voice=voice, speed=speed))
        audio = result.audio.detach().cpu().numpy().astype(np.float32)
        durations = result.output.pred_dur.tolist() if result.output is not None else []
        vocab = pipeline.model.vocab
        known = [ch in vocab for ch in phonemes]
        if len(durations) != sum(known) + 2:
            return audio, 0, []
        frames, k = [], 1
        for is_known in known:
            frames.append(durations[k] if is_known else 0)
            k += is_known
        return audio, durations[0], frames

    def _render_zh(self, piece: str, voice: str, speed: float) -> tuple[list[np.ndarray], list[Word]]:
        audio_parts: list[np.ndarray] = []
        words: list[Word] = []
        offset = 0.0
        for short in _split_long(piece, ZH_PIECE_CHARS):
            for group in _fit(self.zh_tokens(short)):
                phonemes, _ = _sounds(group)
                if not phonemes:
                    continue
                audio, lead, frames = self.zh_infer(phonemes, voice, speed)
                words.extend(_time_words(group, lead, frames, len(audio), offset))
                audio_parts.append(audio)
                offset += len(audio) / SAMPLE_RATE
        return audio_parts, words


def _fit(tokens: list[ZhToken]) -> list[list[ZhToken]]:
    """Split words into groups whose sounds fit in one pass, at punctuation if possible."""
    if len(_sounds(tokens)[0]) <= MAX_PHONEMES or len(tokens) < 2:
        return [tokens] if tokens else []
    middle = len(tokens) // 2
    stops = [i for i, t in enumerate(tokens[:-1], start=1) if not _HAN.search(t.text) and not _LATIN.search(t.text)]
    cut = min(stops, key=lambda i: abs(i - middle)) if stops else middle
    return _fit(tokens[:cut]) + _fit(tokens[cut:])


def _sounds(tokens: list[ZhToken]) -> tuple[str, list[tuple[int, int]]]:
    """The sounds sent for these words, and where each word's own sounds sit in it."""
    full, spans = "", []
    for t in tokens:
        begin = len(full)
        full += t.phonemes
        spans.append((begin, len(full)))
        full += t.gap
    lead = len(full) - len(full.lstrip())
    sent = full.strip()
    return sent, [(max(0, b - lead), max(0, min(len(sent), e - lead))) for b, e in spans]


def _time_words(tokens: list[ZhToken], lead: int, frames: list[int], samples: int, offset: float) -> list[Word]:
    """Word times from the frames of each sound, or spread by length if there are none."""
    total = samples / SAMPLE_RATE
    sent, spans = _sounds(tokens)
    spoken = [i for i, t in enumerate(tokens) if _HAN.search(t.text) or _LATIN.search(t.text)]
    if len(frames) == len(sent):
        at = [lead]
        for f in frames:
            at.append(at[-1] + f)
        words = [Word(tokens[i].text, offset + at[spans[i][0]] / 40, offset + at[spans[i][1]] / 40) for i in spoken]
        if all(w.end > w.start for w in words) and (not words or words[-1].end <= offset + total + 0.05):
            return words
    # Spread the audio over the words by their length.
    weights = [len(tokens[i].text) for i in spoken]
    if not weights:
        return []
    unit = total / sum(weights)
    words, at = [], offset
    for i, w in zip(spoken, weights, strict=True):
        words.append(Word(tokens[i].text, at, at + w * unit))
        at += w * unit
    return words


engine = Engine()
