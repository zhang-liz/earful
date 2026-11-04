# Earful

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

### Or as a Mac app: Earful

```sh
./mac/build-app.sh
```

This puts **Earful** in `/Applications`. Open it like any app, or keep it in
the Dock. It starts the server and opens the page. Click the Dock icon again to
reopen the page. Quit Earful to stop the server and free its memory.

It serves this Mac only. With Tailscale signed in, the phone address still
works. Server output goes to `~/Library/Logs/Earful.log`. Run the build again
if you move this folder.

## Use it from your phone

Same Wi-Fi as the Mac:

```sh
TTS_PASSWORD=pick-a-password ./run.sh --lan
```

It prints the address to open on your phone, like `http://192.168.86.20:8888`.
Leave the username blank and enter the password. In Safari, **Share → Add to
Home Screen** gives it an app icon and hides the browser bars.

The Mac does all the work, so it must be awake and on the same network. A
sleeping or closed Mac cannot answer. Note the address changes if your router
gives the Mac a different one; check with `ipconfig getifaddr en0`.

To reach the server by a name of your own on a public domain, list it in
`TTS_ALLOWED_HOSTS`, separated by commas. Other names on the internet are refused.

`TTS_PASSWORD` is optional but strongly recommended: without it, anyone on the
network can open the page. With no password set, `./run.sh` alone stays
local-only and unprotected, which is fine.

Away from home you would also need a tunnel (Tailscale is the simplest) and the
Mac still has to be awake — plugged in, since `womp` (wake on network) is off on
battery.

### Refreshing does not lose your place

The text box and the reading you had open both come back after a refresh, so
reloading the page or closing the tab by accident costs nothing. Nothing is
sent anywhere: the text stays in your own browser.

A reading only comes back while the server still has it. Restart the server
and the page quietly falls back to the text box, with your text still in it.

### Carry on where you left off

Start something reading on the Mac — the web page, the browser extension, or
the editor extension — then open `/continue` on your phone. It picks up the
same text at the same spot and carries on from there.

The address appears in the **ON YOUR PHONE** panel on the main page whenever
the server is reachable from other devices, so there is no address to type.

If the phone cannot open it, the network is probably keeping devices apart —
most office and guest Wi-Fi does, and the panel says so when that is a risk.
Nothing on this machine can lift that. A tunnel goes around it: sign in to
Tailscale on the Mac and the phone, and the panel switches to the tunnel
address on its own, which then works from anywhere.

With Tailscale signed in, `./run.sh` puts it in front of the server and the
address becomes as short as it gets — `http://your-mac/go`. No port, no
domain, no long path. That name stays the same for good, so it is the one to
bookmark or add to the home screen. A plain Wi-Fi address is handed out by
whatever router you are on and changes when you move between networks.

Two things worth knowing. The Mac remembers only the most recent spot, because
this is "carry on where I left off" rather than a queue. And readings live in
memory, so restarting the server forgets them; the phone then says there is
nothing to carry on, instead of failing on a reading that is gone.

## Use it

1. Paste your text — an article, a chapter, anything. Length does not matter.
2. Pick a voice. Press **Hear voice** to sample one first. Changing the voice
   while an article is open re-reads the whole thing in the new one.
3. Press **Read it to me**. It starts reading after a couple of seconds and
   keeps rendering the rest while you listen.

The article fills the middle, split into parts. The part being read is boxed
and marked with a caret, and **each word lights up as it is spoken**.

**Click any word to start reading from there.** Clicking the space around the
words starts from the top of that part.

**Double-click anywhere in the article to edit all of it**, in one box, with
the caret placed where you clicked (`EDIT TEXT` does the same). A blank line
starts a new part. Cmd+Enter (Ctrl+Enter) saves, Escape cancels.

Saving re-records only the paragraphs whose text actually changed, so fixing a
word in a long article takes a second or two rather than redoing everything.

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
- Editing the article posts it to `/rewrite/<job>`, which re-speaks only the
  paragraphs whose text changed and reuses the audio for the rest. The joined
  download file is deleted so it is rebuilt with the new audio.
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
extension/       Chrome extension: read any web page aloud
editor-extension/ VS Code, Cursor and Antigravity: read the file you are editing
run.sh           starts the server and opens the browser
output/          generated audio (git-ignored)
```

## Browser extension

Reads any web page aloud, highlighting each word in the page itself.

Install it once. Chrome will not let anything but you do this, so these four
steps have to be done by hand:

1. Start the server: `./run.sh`
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**, the switch in the top right.
4. Click **Load unpacked** and pick the `extension/` folder in this project.

An amber speaker icon appears in the toolbar. If you do not see it, click the
puzzle piece and pin it.

After changing any of these files, go back to `chrome://extensions` and press
the refresh arrow on the card. Chrome keeps running the old copy until you
do.

To check the extension will load before trying it:

```
python3 extension/check-manifest.py extension
```

It applies the rules Chrome applies, so an unknown permission or a bad host
pattern is caught here rather than as a red error on the extensions page.

To use it: right-click a page and choose **Read the whole page**, or select
text and choose **Read this aloud**. `Alt+R` reads the selection. A small
player appears at the bottom with play, skip and speed buttons.

Menus, sidebars and footers are left out, and so is code: a `<pre>` block or
an inline `<code>` span is punctuation when read aloud, so it is skipped.

Click the toolbar icon to set the server address, the voice, and the password
if you set one. The defaults match `./run.sh` on the same machine.

The server must be running, because it does the speaking. To point the
extension at a server on another machine, run `./run.sh --lan`, set
`TTS_PASSWORD`, and put that address and password in the extension's settings.
Chrome will ask once for permission to reach that address.

## Editor extension

Reads the file you are editing aloud, lighting each word in the editor. Works
in VS Code, Cursor and Antigravity. Comment markers and brackets are skipped
in source files, so you hear the words rather than the punctuation.

See `editor-extension/README.md` for how to install and use it.
