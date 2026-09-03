// Read It To Me, for VS Code and the editors built on it (Cursor,
// Antigravity). Sends the text you are looking at to your own server and
// reads it back, lighting each word in the editor as it is spoken.

const vscode = require("vscode");
const { Session } = require("./session");
const { Player } = require("./player");

/** The word being spoken. */
const wordStyle = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
  borderRadius: "2px",
});

/** The line being read, so the eye can find it without hunting. */
const lineStyle = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor("editor.lineHighlightBackground"),
  isWholeLine: true,
});

let session = null;
let player = null;
let editor = null;          // the editor being read
let statusBar = null;
let log = null;   // the output channel, for diagnosing problems

function settings() {
  const c = vscode.workspace.getConfiguration("readItToMe");
  return {
    server: c.get("server"),
    password: c.get("password"),
    voice: c.get("voice"),
    speed: c.get("speed"),
    stripCode: c.get("stripCode"),
    showPlayerPanel: c.get("showPlayerPanel"),
  };
}

/** How a file's text should be cleaned before it is spoken. */
function kindFor(language, stripCode) {
  if (language === "markdown" || language === "mdx" || language === "quarto") {
    return "markdown";
  }
  if (language === "plaintext") return "plain";
  return stripCode ? "code" : "plain";
}

function clearHighlight() {
  // The editor may have been closed while we were reading.
  for (const visible of vscode.window.visibleTextEditors) {
    visible.setDecorations(wordStyle, []);
    visible.setDecorations(lineStyle, []);
  }
}

function showHighlight(spot) {
  if (!editor || editor.document.isClosed) return;
  const live = vscode.window.visibleTextEditors.find((e) => e.document === editor.document);
  if (!live) return;

  if (!spot) {
    live.setDecorations(wordStyle, []);
    live.setDecorations(lineStyle, []);
    return;
  }
  if (spot.line >= live.document.lineCount) return;

  const text = live.document.lineAt(spot.line).text;
  // The offsets already account for indentation and any comment marker that
  // was stripped before speaking.
  const from = Math.min(spot.start, text.length);
  const to = Math.min(spot.end, text.length);

  const range = new vscode.Range(spot.line, from, spot.line, to);
  live.setDecorations(wordStyle, [range]);
  live.setDecorations(lineStyle, [new vscode.Range(spot.line, 0, spot.line, 0)]);

  // Keep the word on screen, without yanking the view around.
  live.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/**
 * File names a preview can be showing. Only documents get a preview, so this
 * stays deliberately narrow; every other file is caught by the editor check.
 */
const READABLE = /\.(md|mdx|markdown|qmd|txt|rst|adoc)$/i;

/** Drives which buttons the editor title bar shows. */
function setReading(reading) {
  vscode.commands.executeCommand("setContext", "readItToMe.reading", reading);
}

function setStatus(text) {
  if (!statusBar) return;
  // Clicking it plays or pauses, so the commonest control is always one
  // click away without leaving the file.
  statusBar.text = `$(unmute) ${text}`;
  statusBar.tooltip = "Read It To Me \u2014 click to play or pause";
  statusBar.show();
}

/**
 * Show a plain "Read" button whenever a file is open and nothing is playing.
 *
 * The title bar is not dependable: some editors built on VS Code drop an
 * extension's title-bar buttons without reporting an error, which leaves the
 * feature with no visible way in. The status bar is drawn from code, so it
 * always appears. This is that guaranteed way in.
 */
function showIdleButton() {
  if (!statusBar || session) return;
  if (!somethingToRead()) { statusBar.hide(); return; }
  statusBar.text = "$(play) Read";
  statusBar.tooltip = "Read It To Me \u2014 click to read this file out loud";
  statusBar.show();
}

/**
 * Whether there is anything worth offering to read.
 *
 * A Markdown preview is not a text editor and does not appear among the
 * visible ones, so asking only about editors hides the button on exactly the
 * files people most want read aloud. The open tabs still name the file behind
 * the preview, so they are consulted as well.
 */
function somethingToRead() {
  if (editorToRead()) return true;

  const groups = vscode.window.tabGroups;
  if (!groups || !groups.all) return false;
  for (const group of groups.all) {
    for (const tab of group.tabs || []) {
      const uri = tab.input && (tab.input.uri || tab.input.modified);
      if (uri && uri.path && READABLE.test(uri.path)) return true;
    }
  }
  return false;
}

function stop(keepMessage) {
  setReading(false);
  if (session) session.stop();
  session = null;
  if (player) { player.dispose(); player = null; }
  clearHighlight();
  editor = null;
  // A message explaining why reading stopped is more use than a Read button,
  // so it is left on screen; otherwise offer the way back in.
  if (!keepMessage) showIdleButton();
}

/** Everything the webview can tell us. */
function handle(message) {
  if (!session) return;
  if (message.type === "time") session.time(message.time);
  else if (message.type === "ended") session.ended();
  else if (message.type === "playing") session.setPlaying(message.playing);
  else if (message.type === "toggle") session.toggle();
  else if (message.type === "next") session.next();
  else if (message.type === "prev") session.prev();
  else if (message.type === "rate") session.rate(message.rate);
  else if (message.type === "blocked") {
    session.setPlaying(false);
    askForClick();
  } else if (message.type === "failed") {
    setStatus("That audio would not play.");
  }
}

/**
 * The editor whose text should be read.
 *
 * A Markdown preview is a webview, not a text editor, so nothing is active
 * while one is in front. The file it is previewing is still open behind it,
 * so fall back to that rather than refusing.
 */
function editorToRead() {
  if (vscode.window.activeTextEditor) return vscode.window.activeTextEditor;

  const visible = vscode.window.visibleTextEditors || [];
  // Prefer something that looks like prose, since that is what a preview is.
  return visible.find((e) => ["markdown", "plaintext"].includes(e.document.languageId))
    || visible[0]
    || null;
}

/**
 * The document a Markdown preview is showing.
 *
 * A preview is not a text editor, so there is nothing to read from directly.
 * The open tabs still name the file, and a document can be loaded without
 * opening an editor for it, so the preview is left exactly as it is.
 *
 * Returns null when no open tab names a readable file.
 */
async function documentBehindPreview() {
  const groups = vscode.window.tabGroups;
  if (!groups || !groups.all) return null;

  for (const group of groups.all) {
    for (const tab of group.tabs || []) {
      const input = tab.input || {};
      const uri = input.uri || input.modified;
      if (!uri || !uri.path || !READABLE.test(uri.path)) continue;
      try {
        return await vscode.workspace.openTextDocument(uri);
      } catch (error) {
        if (log) log.appendLine(`Could not open ${uri.path}: ${error && error.message}`);
      }
    }
  }
  return null;
}

async function read(whole) {
  // Reading needs a document. An editor is only needed to paint the highlight,
  // and a Markdown preview has none, so the two are looked up separately: the
  // preview is left in front, and the words are simply read without a
  // highlight to follow.
  const active = editorToRead();
  const document = active ? active.document : await documentBehindPreview();
  if (!document) {
    vscode.window.showInformationMessage("Open a file to read.");
    return;
  }

  let text;
  let firstLine;
  const selection = active && active.selection;
  if (whole || !selection || selection.isEmpty) {
    text = document.getText();
    firstLine = 0;
  } else {
    text = document.getText(selection);
    firstLine = selection.start.line;
  }

  stop();
  editor = active;  // null from a preview: nothing to highlight

  const config = settings();
  // Each kind of file carries different marks that are meant to be seen
  // rather than heard.
  config.kind = kindFor(document.languageId, config.stripCode);
  // Named so a phone picking this up shows the file, not a bare job id.
  config.title = document.fileName ? document.fileName.split("/").pop() : "";

  player = new Player(
    config.showPlayerPanel,
    handle,
    () => { if (session) { session.stop(); session = null; } clearHighlight(); setReading(false); }
  );

  session = new Session({
    fetch: (url, options) => fetch(url, options),
    config,
    player,
    onHighlight: showHighlight,
    onStatus: setStatus,
  });

  const ok = await session.start(text, firstLine);
  // start() has already explained the failure; leave that message showing.
  if (!ok) { stop(true); return; }
  setReading(true);
}

/**
 * The editor refuses to make sound until the user clicks something, and the
 * refusal is silent. Ask for that click here rather than making them go and
 * find the panel, which is normally hidden.
 */
async function askForClick() {
  setStatus("Click to start reading");
  if (log) log.appendLine("The editor blocked sound until a click.");

  const START = "Start reading";
  const choice = await vscode.window.showInformationMessage(
    "The editor will not play sound until you click.",
    START
  );
  if (choice !== START || !session) return;
  session.toggle();          // this click is the gesture it was waiting for
}

/** Start reading from wherever the cursor is. */
async function jumpHere() {
  if (!session) { await read(false); return; }
  const active = editorToRead();
  if (!active || !active.selection) return;
  const at = active.selection.active;
  const found = await session.jumpTo(at.line, at.character);
  if (!found) setStatus("Nothing is read from that line.");
}

/** Pick a speed, without leaving the file. */
async function chooseSpeed() {
  if (!session) return;
  const choices = ["0.75", "1", "1.25", "1.5", "1.75", "2"];
  const picked = await vscode.window.showQuickPick(
    choices.map((value) => ({
      label: `${value}x`,
      description: Number(value) === session.config.speed ? "current" : undefined,
      value: Number(value),
    })),
    { placeHolder: "Reading speed" }
  );
  if (picked) session.rate(picked.value);
}

function activate(context) {
  setReading(false);

  // A one-line note that activation happened, so a problem in a real editor
  // can be told apart from the extension never starting at all.
  try {
    const channel = vscode.window.createOutputChannel("Read It To Me");
    channel.appendLine(`Ready. Server: ${settings().server}`);
    context.subscriptions.push(channel);
    log = channel;
  } catch { /* older hosts */ }

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "readItToMe.toggle";
  context.subscriptions.push(statusBar);
  showIdleButton();

  // Follow the user from file to file, so the button is present on every
  // file worth reading and absent everywhere else.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => showIdleButton()),
    vscode.window.onDidChangeVisibleTextEditors(() => showIdleButton())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("readItToMe.readSelection", () => read(false)),
    vscode.commands.registerCommand("readItToMe.readFile", () => read(true)),
    vscode.commands.registerCommand("readItToMe.toggle", () => {
      if (session) { session.toggle(); if (player) player.reveal(); }
      else read(false);
    }),
    vscode.commands.registerCommand("readItToMe.stop", stop),
    vscode.commands.registerCommand("readItToMe.previous", () => session?.prev()),
    vscode.commands.registerCommand("readItToMe.next", () => session?.next()),
    vscode.commands.registerCommand("readItToMe.jumpHere", jumpHere),
    vscode.commands.registerCommand("readItToMe.speed", chooseSpeed),
    { dispose: stop }
  );
}

function deactivate() {
  stop();
}

module.exports = { activate, deactivate };
