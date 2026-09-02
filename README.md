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
3. Press **Read it to me**.
4. Play it in the page, or press **Download the audio file** to keep it.

Audio files are saved in `output/`. Delete them any time.

## Speed

Roughly 13× faster than real time on an M-series Mac. A 30-minute article takes
about 2 minutes to render.

## How it works

- **Kokoro-82M** — an open-weight (Apache 2.0) text-to-speech model. Small, and
  consistently rated at or near the top of open voice-quality comparisons.
- Long text is cut into ~800-character chunks on paragraph and sentence
  boundaries, rendered one at a time, then joined with a short pause between
  each. This keeps prosody natural and lets the progress bar move.
- FastAPI serves the page and streams progress to the browser over SSE.

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
