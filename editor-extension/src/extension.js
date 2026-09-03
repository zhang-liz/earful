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
  };
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

/** Drives which buttons the editor title bar shows. */
function setReading(reading) {
  vscode.commands.executeCommand("setContext", "readItToMe.reading", reading);
}

function setStatus(text) {
  if (!statusBar) return;
  statusBar.text = `$(unmute) ${text}`;
  statusBar.show();
}

function stop() {
  setReading(false);
  if (session) session.stop();
  session = null;
  if (player) { player.dispose(); player = null; }
  clearHighlight();
  editor = null;
  if (statusBar) statusBar.hide();
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
    // A hidden panel has its audio suspended, so bring it into view before
    // asking the user to do anything.
    if (player) {
      player.reveal();
      // The editor will not make sound until the user clicks something, so
      // say that plainly in the panel instead of sitting there silent.
      player.post({ type: "needsClick" });
    }
    setStatus("Click Play in the Read It To Me panel.");
    if (log) log.appendLine("The editor blocked sound until a click. Click Play in the panel.");
  } else if (message.type === "failed") {
    setStatus("That audio would not play.");
  }
}

async function read(whole) {
  const active = vscode.window.activeTextEditor;
  if (!active) {
    vscode.window.showInformationMessage("Open a file first.");
    return;
  }

  let text;
  let firstLine;
  if (whole || active.selection.isEmpty) {
    text = active.document.getText();
    firstLine = 0;
  } else {
    text = active.document.getText(active.selection);
    firstLine = active.selection.start.line;
  }

  stop();
  editor = active;

  const config = settings();
  // Prose files are not code; reading them should not strip anything.
  const language = active.document.languageId;
  if (language === "plaintext" || language === "markdown") config.stripCode = false;

  player = new Player(
    // The context is not needed beyond creation, so it is not stored.
    null,
    handle,
    () => { if (session) { session.stop(); session = null; } clearHighlight(); }
  );

  session = new Session({
    fetch: (url, options) => fetch(url, options),
    config,
    player,
    onHighlight: showHighlight,
    onStatus: setStatus,
  });

  const ok = await session.start(text, firstLine);
  if (!ok) { stop(); return; }
  setReading(true);
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

  context.subscriptions.push(
    vscode.commands.registerCommand("readItToMe.readSelection", () => read(false)),
    vscode.commands.registerCommand("readItToMe.readFile", () => read(true)),
    vscode.commands.registerCommand("readItToMe.toggle", () => {
      if (session) { session.toggle(); if (player) player.reveal(); }
      else read(false);
    }),
    vscode.commands.registerCommand("readItToMe.stop", stop),
    { dispose: stop }
  );
}

function deactivate() {
  stop();
}

module.exports = { activate, deactivate };
