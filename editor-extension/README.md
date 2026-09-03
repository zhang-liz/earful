# Read It To Me — for VS Code, Cursor and Antigravity

Reads the file you are looking at aloud in a natural voice, and lights up each
word in the editor as it is spoken.

It talks to the Read It To Me server in the folder above this one, so the
voice runs on your own machine and nothing is sent anywhere else.

## Install

1. Start the server: `./run.sh` in the folder above this one.
2. Build the package:

   ```
   cd editor-extension
   npx @vscode/vsce package --allow-missing-repository --skip-license -o /tmp/read-it-to-me.vsix
   ```

3. Install it into whichever editor you use:

   ```
   # Cursor
   /Applications/Cursor.app/Contents/Resources/app/bin/cursor \
     --install-extension /tmp/read-it-to-me.vsix --force

   # Antigravity
   "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
     --install-extension /tmp/read-it-to-me.vsix --force

   # VS Code
   code --install-extension /tmp/read-it-to-me.vsix --force
   ```

4. Restart the editor. An extension is only picked up on a fresh start.

## Use

Open any file and press the **play button** in the top right of the editor.
That is the whole thing. It works the same in a `.txt` or `.md` file as in
source code, and in the Markdown preview as well as the text.

While it reads, the buttons in that same spot become:

| Button | What it does |
| --- | --- |
| `‹` | Back one paragraph |
| `⏸` | Pause, or play again |
| `›` | Forward one paragraph |
| `◎` | Change speed |
| `⏹` | Stop |

The status bar at the bottom shows which part is being read. Clicking it
plays or pauses.

**The first time you press play, a message asks you to click.** Editors refuse
to make any sound until you click something. Click **Start reading** and it
plays from then on.

## Jumping around

Put the cursor anywhere in the file and press `Alt+J`, or right-click and pick
**Read From Here**. It starts reading from that word.

This works while it is already reading, so you can skip ahead or go back over
something without stopping.

Other ways in:

- Right-click and pick **Read Whole File**, or select text first and pick
  **Read Selection**.
- `Alt+R` reads the selection. `Alt+P` plays or pauses.

## Settings

In your editor's settings, search for "Read It To Me":

| Setting | What it does |
| --- | --- |
| `readItToMe.server` | Where the server is. Default `http://127.0.0.1:8888`. |
| `readItToMe.password` | Only if you started the server with `TTS_PASSWORD`. |
| `readItToMe.voice` | Which voice, for example `am_michael`. |
| `readItToMe.speed` | Starting speed. You can change it while it reads. |
| `readItToMe.stripCode` | Skip brackets and comment markers in source files. On by default. |
| `readItToMe.showPlayerPanel` | Show the audio panel beside the file. Off by default; the controls are on the file's own title bar. |

## What gets skipped

Files are full of marks meant for the eye. They are taken out before reading,
so you hear the words and nothing else.

**Markdown:** heading hashes, bullets, quote arrows, the stars around bold and
italic, backticks, and horizontal rules. A link is read as its words, not its
address. Fenced code blocks are skipped. A table is read row by row.

**Source code:** comment markers, and lines that are only brackets.

**Plain text** is read exactly as written.

Underscores inside a name are left alone, so `max_retry_count` still reads as
itself rather than losing its middle.

## If nothing happens

Open the **Read It To Me** output channel (View, then Output, then pick it
from the list). It says whether the extension started and what went wrong.

Two things account for almost every problem:

- **The server is not running.** Start it with `./run.sh`.
- **The folder is not trusted.** Editors do not run extensions in an untrusted
  folder, and say nothing about it. Open the folder and accept the trust
  prompt, or work somewhere you have already trusted.

## Tests

```
npm test
```

The tests talk to a real server on `http://127.0.0.1:8888`, so start it first.
Point them somewhere else with `TTS_SERVER=...`.

They run one file at a time on purpose. Run in parallel they all ask the same
server to speak at once, and queue behind each other until they time out.
