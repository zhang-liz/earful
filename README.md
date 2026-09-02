# Read It To Me

Paste text. Get it read aloud in a natural human voice. Everything runs on your
own Mac — no accounts, no API keys, no internet after the first run.

## Start it

```sh
./run.sh
```

Your browser opens at http://127.0.0.1:8888

The first run downloads the voice model (~350 MB). After that it starts in a
few seconds. Press `Ctrl+C` in the terminal to stop.

To use a different port: `PORT=9000 ./run.sh`

## Use it

1. Paste your text — an article, a chapter, anything. Length does not matter.
2. Pick a voice. Press **Hear voice** to sample one first.
3. Press **Read it to me**. It starts reading after a couple of seconds and
   keeps rendering the rest while you listen.

The article fills the middle, split into parts. The part being read is boxed
and marked with a caret, and **each word lights up as it is spoken**.

**Click any word to start reading from there.** Clicking the space around the
words starts from the top of that part.

Controls live in the left sidebar:

| Control | What it does |
|---|---|
| `1x` `1.5x` `2x` | One-press speed presets |
| Slider | Any speed from 0.5x to 3x |
| ⏮ ▶ ⏭ | Previous part, play/pause, next part |
| Meter | One cell per part; green once rendered |
| `SAVE .WAV` | Appears when the whole thing is done |

Keyboard: **Space** plays or pauses, **←** and **→** move between parts.

Speed changes apply instantly, mid-sentence, and pitch stays natural.

Saved files go to `output/`. Delete them any time.

## Speed

Playback begins about 2 seconds after you press the button, whatever the length.
Rendering runs at roughly 13× real time on an M-series Mac, so it stays well
ahead of you.

## How it works

- **Kokoro-82M** — an open-weight (Apache 2.0) text-to-speech model. Small, and
  consistently rated at or near the top of open voice-quality comparisons.
- Text is cut one paragraph per chunk (splitting any paragraph longer than
  ~800 characters on sentence boundaries). One paragraph per chunk keeps jump
  targets small enough to be useful. Each chunk is playable the moment it is
  done, so listening starts long before rendering finishes.
- Audio is always rendered at 1× speed. The browser changes tempo during
  playback with `playbackRate` and `preservesPitch`, so moving the slider never
  triggers a re-render.
- Kokoro reports a start and end time for every token it speaks. Those timings
  are kept per part and served from `/words/<job>/<part>`; the page maps them
  onto its word spans and lights the one under the playhead each frame. Because
  the highlight follows `currentTime`, it tracks any playback speed for free.
- The same map makes every word a seek target: clicking one seeks to its start
  time. Within the loaded part that is an immediate seek; across parts the
  target is held until the new source reports its metadata.
- FastAPI serves the page, streams progress over SSE, and serves each chunk
  with HTTP range support (browsers stall on media without it).

## Requirements

- macOS with Apple Silicon (uses the GPU via MPS; falls back to CPU)
- [uv](https://docs.astral.sh/uv/) — installs Python and dependencies
- `espeak-ng` — sounds out unusual words: `brew install espeak-ng`

## Layout

```
app/engine.py    chunking + Kokoro synthesis
app/server.py    HTTP endpoints, job tracking, progress stream
app/index.html   the page
run.sh           starts the server and opens the browser
output/          generated audio (git-ignored)
```
