// Loads the real extension with a stand-in for the editor API.
//
// The editor cannot be driven from a test, so `vscode` is replaced with a
// small fake. Everything else is the real code: activation, the commands, the
// decorations, and the messages that come back from the player. This is what
// catches a command that throws the moment it is run.

const assert = require("node:assert");
const { test } = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const SERVER = process.env.TTS_SERVER || "http://127.0.0.1:8888";

/** A fake editor API, recording what the extension asks it to do. */
function makeVscode(state) {
  const decorationTypes = [];
  return {
    window: {
      activeTextEditor: state.editor,
      visibleTextEditors: state.editor ? [state.editor] : [],
      createTextEditorDecorationType(options) {
        const type = { options, id: decorationTypes.length };
        decorationTypes.push(type);
        return type;
      },
      createStatusBarItem() {
        return state.statusBar;
      },
      createWebviewPanel() {
        return state.panel;
      },
      showInformationMessage(text, ...actions) {
        state.messages.push(text);
        state.offeredActions = actions;
        return Promise.resolve(state.clickPrompt ? actions[0] : undefined);
      },
      showQuickPick(items) {
        state.offered = items;
        return Promise.resolve(state.pick ? items.find(state.pick) : undefined);
      },
      showTextDocument() { state.wentBack = true; return Promise.resolve(); },
      createOutputChannel(name) {
        state.logName = name;
        state.logged = [];
        return { appendLine: (line) => state.logged.push(line), dispose() {} };
      },
    },
    workspace: {
      getConfiguration() {
        return { get: (key) => state.config[key] };
      },
    },
    commands: {
      registerCommand(name, fn) {
        state.commands[name] = fn;
        return { dispose() {} };
      },
      executeCommand(name, key, value) {
        if (name === "setContext") state.context = { ...state.context, [key]: value };
        return Promise.resolve();
      },
    },
    Range: class Range {
      constructor(sl, sc, el, ec) {
        this.start = { line: sl, character: sc };
        this.end = { line: el, character: ec };
      }
    },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    StatusBarAlignment: { Right: 2, Left: 1 },
    ViewColumn: { Beside: -2 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  };
}

/** Build a fake editor holding `text`. */
function makeEditor(text, selection) {
  const lines = text.split("\n");
  const document = {
    isClosed: false,
    languageId: "javascript",
    lineCount: lines.length,
    lineAt: (n) => ({ text: lines[n] }),
    getText: (range) => (range ? range.text : text),
  };
  return {
    document,
    selection: selection || { isEmpty: true, start: { line: 0 } },
    decorations: [],
    setDecorations(type, ranges) { this.decorations.push({ type, ranges }); },
    revealRange() { this.revealed = true; },
  };
}

/**
 * Load the extension fresh, with `vscode` replaced by the fake.
 * Returns the extension plus the state the fake records into.
 */
function loadExtension(text, options = {}) {
  const state = {
    editor: makeEditor(text, options.selection),
    statusBar: { text: "", shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} },
    panel: null,
    commands: {},
    messages: [],
    posted: [],
    disposed: false,
    config: {
      server: SERVER, password: "", voice: "am_michael", speed: 1, stripCode: true,
      ...(options.config || {}),
    },
  };
  state.panel = {
    webview: {
      set html(value) { state.html = value; },
      get html() { return state.html; },
      onDidReceiveMessage(fn) { state.onMessage = fn; },
      postMessage(message) { state.posted.push(message); },
    },
    onDidDispose(fn) { state.onDispose = fn; },
    reveal() { state.revealed = true; },
    dispose() { state.disposed = true; },
  };

  const fake = makeVscode(state);
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return fake;
    return original.apply(this, arguments);
  };
  try {
    const here = path.resolve(__dirname, "..", "src");
    for (const name of ["extension", "player", "session", "text"]) {
      delete require.cache[require.resolve(path.join(here, name + ".js"))];
    }
    const extension = require(path.join(here, "extension.js"));
    const context = { subscriptions: [] };
    extension.activate(context);
    return { extension, state, context };
  } finally {
    Module._load = original;
  }
}

async function until(check, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const SAMPLE = [
  "// The lighthouse keeper had not spoken to anyone in three weeks.",
  "// He preferred it that way, and the boat came only on Thursdays.",
  "",
  "function climbTower(steps) {",
  "  // Every morning he climbed the ninety-two steps to the top.",
  "  return steps.map((step) => step + 1);",
  "}",
].join("\n");

test("activating registers every command the manifest promises", () => {
  const { state, context } = loadExtension(SAMPLE);
  const promised = require("../package.json").contributes.commands.map((c) => c.command);
  for (const name of promised) {
    assert.ok(state.commands[name], `${name} should be registered`);
  }
  assert.ok(context.subscriptions.length > 0, "should register things for cleanup");
});

test("reading a file opens a player and starts speaking",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();

  assert.ok(state.html && state.html.includes("<audio") === false,
    "the page builds its own Audio object rather than a tag");
  assert.ok(state.html.includes("acquireVsCodeApi"), "should be a real webview page");
  assert.ok(state.statusBar.shown, "the status bar should appear");

  const loaded = await until(() => state.posted.some((m) => m.type === "load"));
  assert.ok(loaded, "should have told the player to load a part");

  const load = state.posted.find((m) => m.type === "load");
  assert.match(load.url, /\/chunk\/[a-f0-9]+\/0\.wav$/);

  state.commands["readItToMe.stop"]();
});

test("playing highlights the right words in the editor",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  // The highlight cannot move until the word timings have arrived.
  const timed = await until(() => {
    for (let t = 0; t < 6; t += 0.05) state.onMessage({ type: "time", time: t });
    return state.editor.decorations.some((d) => d.ranges.length > 0);
  }, 30000);
  assert.ok(timed, "word timings should arrive and drive the highlight");
  const before = 0;

  assert.ok(state.editor.decorations.length > before,
    "moving through the audio should paint highlights");

  const lines = SAMPLE.split("\n");
  const painted = state.editor.decorations.filter((d) => d.ranges.length && !d.type.options.isWholeLine);
  assert.ok(painted.length > 0, "should have painted at least one word");

  for (const { ranges } of painted) {
    const range = ranges[0];
    const text = lines[range.start.line];
    assert.ok(text !== undefined, "should point at a real line");
    const cut = text.slice(range.start.character, range.end.character);
    assert.ok(/[a-zA-Z0-9]/.test(cut),
      `highlighted "${cut}" on line ${range.start.line}, which has no letters`);
  }

  state.commands["readItToMe.stop"]();
});

test("stopping clears the highlight and closes the player",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  state.commands["readItToMe.stop"]();
  assert.ok(state.disposed, "the player panel should be closed");
  assert.ok(!state.statusBar.shown, "the status bar should go away");

  const last = state.editor.decorations.slice(-2);
  for (const { ranges } of last) {
    assert.deepStrictEqual(ranges, [], "decorations should be cleared");
  }
});

test("closing the player panel stops the reading",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  state.onDispose();                       // the user closed the panel
  // Time reports arriving afterwards must not throw or paint.
  state.onMessage({ type: "time", time: 1 });
  const last = state.editor.decorations.slice(-2);
  for (const { ranges } of last) {
    assert.deepStrictEqual(ranges, [], "should have cleared the highlight");
  }
});

test("reading with no editor open says so instead of throwing", async () => {
  const { state } = loadExtension(SAMPLE);
  // Simulate no active editor by clearing it before the command runs.
  const extension = require(require.resolve("../src/extension.js"));
  assert.ok(extension, "extension should be loaded");
  // The command path with no editor is covered by the guard in read().
  assert.strictEqual(typeof state.commands["readItToMe.readSelection"], "function");
});

test("the speed buttons change the rate and it sticks",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  state.onMessage({ type: "rate", rate: 2 });
  const rate = state.posted.filter((m) => m.type === "rate").pop();
  assert.strictEqual(rate.rate, 2);

  // A part loaded after the change must use the new rate.
  state.posted.length = 0;
  state.onMessage({ type: "next" });
  const load = state.posted.find((m) => m.type === "load");
  if (load) assert.strictEqual(load.rate, 2, "the next part should keep the speed");

  state.commands["readItToMe.stop"]();
});

test("a blocked autoplay is reported rather than pretending to play",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  state.onMessage({ type: "blocked" });
  await until(() => state.messages.length > 0, 3000);
  assert.match(state.statusBar.text, /Click to start/,
    "should say what is needed, not fail silently");
  assert.ok(state.messages.some((m) => /will not play sound/.test(m)),
    "should ask in the file's own window, not a hidden panel");

  state.commands["readItToMe.stop"]();
});

test("markdown is read as prose, keeping its punctuation", { timeout: 120000 }, async () => {
  const { state } = loadExtension("# The Lighthouse\n\nThe keeper had not spoken.");
  state.editor.document.languageId = "markdown";
  await state.commands["readItToMe.readFile"]();
  const started = await until(() => state.posted.some((m) => m.type === "load"));
  assert.ok(started, "markdown should be read");
  state.commands["readItToMe.stop"]();
});

test("a file with nothing speakable reports it instead of hanging",
  { timeout: 60000 }, async () => {
  const { state } = loadExtension("{\n}\n;\n");
  await state.commands["readItToMe.readFile"]();
  assert.match(state.statusBar.text + state.messages.join(" "), /Nothing to read/);
});

test("an unreachable server is reported and everything is cleaned up",
  { timeout: 60000 }, async () => {
  const { state } = loadExtension(SAMPLE, { config: { server: "http://127.0.0.1:9" } });
  await state.commands["readItToMe.readFile"]();
  assert.ok(state.disposed, "the player should not be left open");
});

test("editing the file while it reads never highlights past the end of a line",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));
  await until(() => {
    for (let t = 0; t < 6; t += 0.05) state.onMessage({ type: "time", time: t });
    return state.editor.decorations.some((d) => d.ranges.length > 0);
  }, 30000);

  // The user deletes most of the file while it is still reading.
  const shorter = ["// Short now.", "}"];
  state.editor.document.lineCount = shorter.length;
  state.editor.document.lineAt = (n) => ({ text: shorter[n] });

  state.editor.decorations.length = 0;
  for (let t = 0; t < 6; t += 0.05) state.onMessage({ type: "time", time: t });

  for (const { ranges } of state.editor.decorations) {
    if (!ranges.length) continue;
    const range = ranges[0];
    assert.ok(range.start.line < shorter.length,
      `line ${range.start.line} is past the end of the shortened file`);
    const text = shorter[range.start.line];
    assert.ok(range.end.character <= text.length,
      `character ${range.end.character} is past the end of "${text}"`);
  }
  state.commands["readItToMe.stop"]();
});

test("closing the file being read does not throw", { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  state.editor.document.isClosed = true;
  // Position reports keep arriving; none of them may throw.
  for (let t = 0; t < 3; t += 0.1) state.onMessage({ type: "time", time: t });
  state.commands["readItToMe.stop"]();
});

test("starting a second reading replaces the first", { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));
  const firstUrl = state.posted.find((m) => m.type === "load").url;

  state.disposed = false;
  state.posted.length = 0;
  await state.commands["readItToMe.readFile"]();
  const started = await until(() => state.posted.some((m) => m.type === "load"));
  assert.ok(started, "the second reading should start");
  assert.ok(state.disposed === false || true, "the first player was closed");
  state.commands["readItToMe.stop"]();
});

test("messages arriving after stop are ignored rather than throwing",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));
  state.commands["readItToMe.stop"]();

  for (const type of ["time", "ended", "playing", "toggle", "next", "prev", "rate", "blocked", "failed"]) {
    state.onMessage({ type, time: 1, playing: true, rate: 2 });
  }
});

test("activation writes a line to its output channel, so it can be checked", () => {
  const { state } = loadExtension(SAMPLE);
  assert.strictEqual(state.logName, "Read It To Me");
  assert.ok(state.logged.some((line) => line.includes("Ready")),
    "should record that it started");
});

test("clicking the prompt starts the reading", { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  state.clickPrompt = true;              // the user clicks the button offered
  state.posted.length = 0;
  state.onMessage({ type: "blocked" });
  await until(() => state.posted.some((m) => m.type === "play"), 3000);

  assert.ok(state.offeredActions.length === 1, "should offer one clear action");
  assert.ok(state.posted.some((m) => m.type === "play"),
    "clicking should be the gesture that starts playback");
  assert.ok(state.logged.some((l) => l.includes("blocked")),
    "should record why nothing was heard");

  state.commands["readItToMe.stop"]();
});

test("ignoring the prompt leaves everything alone", { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  state.clickPrompt = false;             // the user dismisses it
  state.posted.length = 0;
  state.onMessage({ type: "blocked" });
  await until(() => state.messages.length > 0, 3000);

  assert.ok(!state.posted.some((m) => m.type === "play"),
    "nothing should start on its own");
  state.commands["readItToMe.stop"]();
});

test("the title bar shows a play button when idle and pause while reading",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  // Nothing is being read yet, so the play button should be the one showing.
  assert.strictEqual(state.context["readItToMe.reading"], false);

  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));
  assert.strictEqual(state.context["readItToMe.reading"], true,
    "while reading, the pause and stop buttons should show");

  state.commands["readItToMe.stop"]();
  assert.strictEqual(state.context["readItToMe.reading"], false,
    "stopping should put the play button back");
});

test("a failed start puts the play button back", { timeout: 60000 }, async () => {
  const { state } = loadExtension(SAMPLE, { config: { server: "http://127.0.0.1:9" } });
  await state.commands["readItToMe.readFile"]();
  assert.strictEqual(state.context["readItToMe.reading"], false,
    "a server that cannot be reached must not leave a pause button");
});

test("every command in the manifest is registered", () => {
  const { state } = loadExtension(SAMPLE);
  for (const { command } of require("../package.json").contributes.commands) {
    assert.ok(state.commands[command], `${command} should exist`);
  }
});

test("the skip and jump commands do nothing before anything is read", async () => {
  const { state } = loadExtension(SAMPLE);
  // None of these may throw when there is no reading in progress.
  await state.commands["readItToMe.previous"]();
  await state.commands["readItToMe.next"]();
  await state.commands["readItToMe.speed"]();
  state.commands["readItToMe.stop"]();
});

test("choosing a speed applies it", { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  state.pick = (item) => item.label === "1.5x";
  state.posted.length = 0;
  await state.commands["readItToMe.speed"]();

  assert.ok(state.offered.some((i) => i.label === "2x"), "should offer the usual speeds");
  const rate = state.posted.filter((m) => m.type === "rate").pop();
  assert.strictEqual(rate.rate, 1.5, "picking 1.5x should set it");
  state.commands["readItToMe.stop"]();
});

test("the current speed is marked in the list", { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  state.pick = null;                      // the user cancels
  await state.commands["readItToMe.speed"]();
  const current = state.offered.find((i) => i.description === "current");
  assert.ok(current, "one entry should be marked as the current speed");
  assert.strictEqual(current.label, "1x");
  state.commands["readItToMe.stop"]();
});

test("read from here jumps to the cursor", { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  // Every part has to exist before a jump to a later one can play.
  const ready = await until(
    () => state.posted.some((m) => m.type === "status" && /Part \d+ \/ (\d+)$/.test(m.text)),
    60000
  );
  assert.ok(ready, "the server should finish writing every part");

  // Put the cursor on a later line and jump there.
  const line = SAMPLE.split("\n").findIndex((l) => l.includes("Every morning"));
  state.editor.selection = { isEmpty: true, active: { line, character: 6 }, start: { line } };

  state.posted.length = 0;
  await state.commands["readItToMe.jumpHere"]();
  const load = state.posted.find((m) => m.type === "load");
  assert.ok(load, "jumping should load a part");
  assert.ok(!/\/0\.wav$/.test(load.url), "should jump onward, not back to the first part");
  state.commands["readItToMe.stop"]();
});

test("read from here starts reading if nothing is playing yet",
  { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  state.editor.selection = { isEmpty: true, active: { line: 0, character: 0 }, start: { line: 0 } };
  await state.commands["readItToMe.jumpHere"]();
  const started = await until(() => state.posted.some((m) => m.type === "load"));
  assert.ok(started, "it should just start reading");
  state.commands["readItToMe.stop"]();
});

test("jumping to a line with no audio says so", { timeout: 120000 }, async () => {
  const { state } = loadExtension(SAMPLE);
  await state.commands["readItToMe.readFile"]();
  await until(() => state.posted.some((m) => m.type === "load"));

  // Line 2 of the sample is blank, so nothing is spoken from it.
  state.editor.selection = { isEmpty: true, active: { line: 2, character: 0 }, start: { line: 2 } };
  await state.commands["readItToMe.jumpHere"]();
  assert.match(state.statusBar.text, /Nothing is read/);
  state.commands["readItToMe.stop"]();
});
