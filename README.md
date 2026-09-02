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
2. Pick a voice. Press **Hear this voice** to sample one first.
3. Press **Read it to me**. It starts reading after a couple of seconds and
   keeps rendering the rest while you listen.

Drag the **Speed** slider at any time, including mid-sentence — it takes effect
straight away and the pitch stays natural. Press **Space** to play or pause.
**Download** appears once the whole thing has rendered, if you want to keep it.

Downloaded files are saved in `output/`. Delete them any time.

## Speed

Playback begins about 2 seconds after you press the button, whatever the length.
Rendering runs at roughly 13× real time on an M-series Mac, so it stays well
ahead of you.

## How it works

- **Kokoro-82M** — an open-weight (Apache 2.0) text-to-speech model. Small, and
  consistently rated at or near the top of open voice-quality comparisons.
- Long text is cut into ~800-character chunks on paragraph and sentence
  boundaries and rendered one at a time. Each chunk is playable the moment it
  is done, so listening starts long before rendering finishes.
- Audio is always rendered at 1× speed. The browser changes tempo during
  playback with `playbackRate` and `preservesPitch`, so moving the slider never
  triggers a re-render.
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
