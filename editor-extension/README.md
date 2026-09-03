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
source code.

While it reads, that button becomes pause and stop.

Other ways in, if you prefer them:

- Right-click and pick **Read Whole File**, or select some text first and pick
  **Read Selection**.
- `Alt+R` reads the selection. `Alt+P` plays or pauses.

A small player opens beside the file with skip and speed buttons, and the
status bar at the bottom shows which part is being read.

**The first time you press play, click the Play button in the panel.** Editors
refuse to make any sound until you click something, so the panel asks you to.
After that click it plays on its own.

## Settings

In your editor's settings, search for "Read It To Me":

| Setting | What it does |
| --- | --- |
| `readItToMe.server` | Where the server is. Default `http://127.0.0.1:8888`. |
| `readItToMe.password` | Only if you started the server with `TTS_PASSWORD`. |
| `readItToMe.voice` | Which voice, for example `am_michael`. |
| `readItToMe.speed` | Starting speed. You can change it while it reads. |
| `readItToMe.stripCode` | Skip brackets and comment markers in source files. On by default. |

## Reading code

Source files are mostly punctuation, and reading `const x = {` aloud is noise.
So in code files the comment markers are dropped, lines that are only brackets
are skipped, and the words are read. Plain text and Markdown are read as
written.

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
node --test "test/*.test.js"
```

The tests talk to a real server on `http://127.0.0.1:8888`, so start it first.
Point them somewhere else with `TTS_SERVER=...`.
