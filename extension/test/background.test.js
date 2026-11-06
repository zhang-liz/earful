// The background worker: the right-click menu, the keyboard shortcut, and
// getting the content script into a tab that does not have it yet.

const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Load background.js with a fake chrome API that records what it is asked. */
function load(options = {}) {
  const state = {
    menus: [],
    sentTo: [],
    injected: [],
    listeners: {},
    stored: options.stored || {},
    warnings: [],
    hasScript: Boolean(options.hasScript),
    toOffscreen: [],
    offscreenCreated: [],
    offscreenOpen: false,
  };
  // Every message listener, as Chrome calls them all; the first answer wins.
  state.listeners.message = (message, sender, respond) =>
    state.listeners.messages.map((fn) => fn(message, sender, respond)).some(Boolean);

  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => { state.listeners.installed = fn; } },
      onMessage: { addListener: (fn) => { (state.listeners.messages ||= []).push(fn); } },
      onConnect: { addListener: (fn) => { state.listeners.connect = fn; } },
      onStartup: { addListener: (fn) => { state.listeners.startup = fn; } },
      getURL: (file) => `chrome-extension://earful/${file}`,
      openOptionsPage: () => { state.optionsOpened = (state.optionsOpened || 0) + 1; },
      sendMessage: async (message) => {
        state.toOffscreen.push(message);
        return options.offscreenReply ? options.offscreenReply(message) : {};
      },
    },
    offscreen: {
      hasDocument: async () => state.offscreenOpen,
      createDocument: async (o) => { state.offscreenCreated.push(o); state.offscreenOpen = true; },
    },
    contextMenus: {
      create: (m) => state.menus.push(m),
      update: (id, change) => { state.menus.find((m) => m.id === id).title = change.title; },
      onClicked: { addListener: (fn) => { state.listeners.menuClick = fn; } },
    },
    commands: { onCommand: { addListener: (fn) => { state.listeners.command = fn; } } },
    action: {
      onClicked: { addListener: (fn) => { state.listeners.iconClick = fn; } },
      setTitle: ({ title }) => { state.actionTitle = title; },
    },
    i18n: { getUILanguage: () => options.browserLanguage || "en-US" },
    storage: {
      sync: { get: async () => state.stored },
      onChanged: { addListener: (fn) => { state.listeners.storageChanged = fn; } },
    },
    tabs: {
      sendMessage: async (tabId, message, opts = {}) => {
        if (!state.hasScript) throw new Error("no receiver");
        // Every frame hears a measure, and answers on its own.
        if (message.type === "measure") {
          const frames = options.frames || [{ frameId: 0, page: 100, selection: 0, seen: true }];
          for (const { frameId, ...result } of frames) {
            state.listeners.message({ type: "measured", nonce: message.nonce, result }, { frameId }, () => {});
          }
          return { ok: true };
        }
        if (message.type !== "ping") state.sentTo.push({ tabId, message, frameId: opts.frameId });
        return { ok: true };
      },
      query: async () => (options.noTab ? [] : [{ id: 7 }]),
    },
    scripting: {
      executeScript: async (o) => {
        if (options.cannotInject) throw new Error("cannot run on this page");
        state.injected.push(o);
        state.hasScript = true;
      },
      insertCSS: async (o) => { state.injected.push(o); },
    },
  };

  // The extension's own files, as Chrome serves them to the worker.
  const fetchFile = async (url, init) => {
    const own = /^chrome-extension:\/\/earful\/(.+)$/.exec(String(url));
    if (!own) return options.fetch(url, init);
    const body = fs.readFileSync(path.join(__dirname, "..", own[1]), "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  const context = { chrome, btoa, crypto, setTimeout, fetch: fetchFile, console: { warn: (...a) => state.warnings.push(a.join(" ")), log: console.log } };
  context.globalThis = context;
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), context);
  return { state, chrome };
}

const settle = (ms = 260) => new Promise((r) => setTimeout(r, ms));

test("installing adds both right-click entries", async () => {
  const { state } = load();
  await state.listeners.installed();
  const ids = state.menus.map((m) => m.id);
  assert.ok(ids.includes("read-selection"), "should offer to read a selection");
  assert.ok(ids.includes("read-page"), "should offer to read the page");

  const selection = state.menus.find((m) => m.id === "read-selection");
  assert.deepEqual(selection.contexts, ["selection"],
    "reading a selection should only appear when there is one");
});

test("choosing read this aloud sends the selected text", async () => {
  const { state } = load({ hasScript: true });
  state.listeners.menuClick({ menuItemId: "read-selection", selectionText: "some words" }, { id: 7 });
  await settle();
  const sent = state.sentTo.find((s) => s.message.type === "read");
  assert.ok(sent, "should have asked the page to read");
  assert.strictEqual(sent.message.text, "some words");
});

test("choosing read the whole page sends that instead", async () => {
  const { state } = load({ hasScript: true });
  state.listeners.menuClick({ menuItemId: "read-page" }, { id: 7 });
  await settle();
  assert.ok(state.sentTo.some((s) => s.message.type === "read-page"));
});

test("a tab without the script gets it injected first", async () => {
  const { state } = load({ hasScript: false });
  state.listeners.menuClick({ menuItemId: "read-page" }, { id: 7 });
  await settle();
  assert.ok(state.injected.some((i) => (i.files || []).includes("content.js")),
    "the script should be injected");
  assert.ok(state.injected.some((i) => (i.files || []).includes("content.css")),
    "its styles should go in too");
  assert.ok(state.sentTo.some((s) => s.message.type === "read-page"),
    "and then the message should arrive");
});

test("a page that will not take the script is reported, not left silent", async () => {
  const { state } = load({ hasScript: false, cannotInject: true });
  state.listeners.menuClick({ menuItemId: "read-page" }, { id: 7 });
  await settle();
  assert.ok(state.warnings.length > 0, "should say why nothing happened");
  assert.strictEqual(state.sentTo.length, 0, "and should not pretend it worked");
});

test("the settings are sent along with every message", async () => {
  const { state } = load({
    hasScript: true,
    stored: { server: "http://192.168.1.5:8888", voice: "af_heart", password: "x", speed: 2 },
  });
  state.listeners.menuClick({ menuItemId: "read-page" }, { id: 7 });
  await settle();
  const sent = state.sentTo.find((s) => s.message.type === "read-page");
  assert.strictEqual(sent.message.settings.server, "http://192.168.1.5:8888");
  assert.strictEqual(sent.message.settings.voice, "af_heart");
});

test("missing settings fall back to the defaults", async () => {
  const { state } = load({ hasScript: true, stored: {} });
  state.listeners.menuClick({ menuItemId: "read-page" }, { id: 7 });
  await settle();
  const sent = state.sentTo.find((s) => s.message.type === "read-page");
  assert.match(sent.message.settings.server, /127\.0\.0\.1:8888/);
  assert.ok(sent.message.settings.voice, "there should always be a voice");
});

test("the keyboard shortcut reads the page", async () => {
  const { state } = load({ hasScript: true });
  await state.listeners.command("read-or-pause", { id: 7 });
  await settle();
  assert.ok(state.sentTo.some((s) => s.message.type === "read-page"));
});

test("a menu click with no tab does nothing rather than throwing", async () => {
  const { state } = load({ hasScript: true });
  state.listeners.menuClick({ menuItemId: "read-page" }, undefined);
  await settle();
  assert.strictEqual(state.sentTo.length, 0);
});

test("the player's gear opens the settings", () => {
  const { state } = load({ hasScript: true });
  state.listeners.message({ type: "open-settings" }, {}, () => {});
  assert.strictEqual(state.optionsOpened, 1);
});

test("an unrelated message is left alone", () => {
  const { state } = load();
  const result = state.listeners.message({ type: "something-else" }, null, () => {});
  assert.strictEqual(result, false, "should not claim the channel it does not use");
});

test("a call to the server goes out from here, with the saved address and password", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ id: "j" }) };
  };
  const { state } = load({
    fetch,
    stored: { server: "http://192.168.1.5:8888", password: "hunter2" },
  });

  const answer = await new Promise((respond) => {
    const open = state.listeners.message(
      {
        type: "api",
        path: "/speak",
        options: { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      },
      {},
      respond,
    );
    assert.strictEqual(open, true, "the answer comes later, so the channel must stay open");
  });

  assert.strictEqual(calls[0].url, "http://192.168.1.5:8888/speak");
  assert.strictEqual(calls[0].init.method, "POST");
  assert.strictEqual(calls[0].init.headers["Content-Type"], "application/json");
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  assert.strictEqual(answer.ok, true);
  assert.deepEqual({ ...answer.body }, { id: "j" });
});

test("a server that cannot be reached is reported, not thrown", async () => {
  const { state } = load({ fetch: async () => { throw new Error("connection refused"); } });
  const answer = await new Promise((respond) => {
    state.listeners.message({ type: "api", path: "/voices", options: {} }, {}, respond);
  });
  assert.match(answer.failed, /connection refused/);
});

/** A page's player connecting to the worker, as remote-audio.js does. */
function connect(state, name = "earful-audio") {
  const port = {
    posted: [],
    postMessage(m) { this.posted.push(m); },
    onMessage: { addListener(fn) { port.send = fn; } },
    onDisconnect: { addListener(fn) { port.close = fn; } },
    name,
  };
  state.listeners.connect(port);
  return port;
}

test("audio calls open the hidden page once and go to it in order", async () => {
  const { state } = load();
  const port = connect(state);
  port.send({ op: "src", gen: 1, src: "a.wav" });
  port.send({ op: "play", gen: 1, call: 1, src: "a.wav" });
  await settle();
  assert.strictEqual(state.offscreenCreated.length, 1);
  assert.deepStrictEqual([...state.offscreenCreated[0].reasons], ["AUDIO_PLAYBACK"]);
  assert.deepStrictEqual(state.toOffscreen.map((m) => m.op), ["src", "play"]);
  assert.ok(state.toOffscreen.every((m) => m.to === "offscreen" && m.owner));
  assert.strictEqual(JSON.stringify(port.posted), JSON.stringify([{ reply: 1 }]));
});

test("a refused play is passed back to the page", async () => {
  const { state } = load({ offscreenReply: (m) => (m.op === "play" ? { error: "NotAllowedError" } : {}) });
  const port = connect(state);
  port.send({ op: "play", gen: 1, call: 4 });
  await settle();
  assert.strictEqual(JSON.stringify(port.posted), JSON.stringify([{ reply: 4, error: "NotAllowedError" }]));
});

test("the hidden page's events reach only the page that owns the audio", async () => {
  const { state } = load();
  const first = connect(state);
  const second = connect(state);
  first.send({ op: "src", gen: 1, src: "a.wav" });
  await settle();
  const owner = state.toOffscreen[0].owner;
  state.listeners.message({ type: "audio-event", owner, event: "ended" }, {}, () => {});
  assert.strictEqual(first.posted.length, 1);
  assert.strictEqual(second.posted.length, 0);
});

test("closing the page stops its audio", async () => {
  const { state } = load();
  const port = connect(state);
  port.send({ op: "src", gen: 1, src: "a.wav" });
  await settle();
  port.close();
  await settle();
  assert.deepStrictEqual(state.toOffscreen.at(-1).op, "gone");
});

test("a player that connects again after a worker restart keeps its audio", async () => {
  const { state } = load();
  const id = "ab".repeat(16);
  const old = connect(state, `earful-audio:${id}`);
  old.send({ op: "src", gen: 1, src: "a.wav" });
  await settle();
  const again = connect(state, `earful-audio:${id}`);
  old.close();
  await settle();
  assert.ok(state.toOffscreen.every((m) => m.op !== "gone"), "the audio should not be stopped");
  assert.strictEqual(state.toOffscreen[0].owner, id);
  state.listeners.message({ type: "audio-event", owner: id, event: "ended" }, {}, () => {});
  assert.strictEqual(again.posted.length, 1, "news should reach the new connection");
});

/** A Claude artifact: a top page with a title bar, the text in a frame. */
const ARTIFACT = [
  { frameId: 0, page: 58, selection: 0, seen: true },
  { frameId: 3, page: 9000, selection: 0, seen: true },
  { frameId: 4, page: 0, selection: 0, seen: false },
];

test("reading the page goes to the frame holding the text", async () => {
  const { state } = load({ hasScript: true, frames: ARTIFACT });
  state.listeners.menuClick({ menuItemId: "read-page", frameId: 0 }, { id: 7 });
  await settle();
  const sent = state.sentTo.filter((s) => s.message.type === "read-page");
  assert.strictEqual(sent.length, 1, "one frame reads, not every frame at once");
  assert.strictEqual(sent[0].frameId, 3);
});

test("a frame too small to see is not read, whatever it holds", async () => {
  const { state } = load({ hasScript: true, frames: [
    { frameId: 0, page: 500, selection: 0, seen: true },
    { frameId: 9, page: 5000, selection: 0, seen: false },
  ] });
  state.listeners.menuClick({ menuItemId: "read-page" }, { id: 7 });
  await settle();
  assert.strictEqual(state.sentTo.find((s) => s.message.type === "read-page").frameId, 0);
});

test("reading a selection goes to the frame it is in", async () => {
  const { state } = load({ hasScript: true, frames: [
    { frameId: 0, page: 58, selection: 0, seen: true },
    { frameId: 3, page: 9000, selection: 40, seen: true },
  ] });
  state.listeners.command("read-or-pause", { id: 7 });
  await settle();
  assert.strictEqual(state.sentTo.find((s) => s.message.type === "read-selection").frameId, 3);
});

test("a right-clicked selection goes to the frame it was clicked in", async () => {
  const { state } = load({ hasScript: true, frames: ARTIFACT });
  state.listeners.menuClick({ menuItemId: "read-selection", selectionText: "hi", frameId: 3 }, { id: 7 });
  await settle();
  assert.strictEqual(state.sentTo.find((s) => s.message.type === "read").frameId, 3);
});

test("pause goes to every frame, so the one reading hears it", async () => {
  const { state } = load({ hasScript: true, frames: [
    { frameId: 0, page: 58, selection: 0, reading: false, seen: true },
    { frameId: 3, page: 9000, selection: 0, reading: true, seen: true },
  ] });
  state.listeners.iconClick({ id: 7 });
  await settle();
  const sent = state.sentTo.find((s) => s.message.type === "toggle");
  assert.strictEqual(sent.frameId, undefined);
});

test("the script goes into every frame of a tab that lacks it", async () => {
  const { state } = load({ hasScript: false, frames: ARTIFACT });
  state.listeners.menuClick({ menuItemId: "read-page" }, { id: 7 });
  await settle();
  const injected = state.injected.find((i) => (i.files || []).includes("content.js"));
  assert.strictEqual(injected.target.allFrames, true);
  assert.strictEqual(state.sentTo.find((s) => s.message.type === "read-page").frameId, 3);
});

/** One click on the icon, in a tab whose frames report `frames`. */
async function iconClick(frames) {
  const { state } = load({ hasScript: true, frames });
  state.listeners.iconClick({ id: 7 });
  await settle();
  return JSON.stringify(state.sentTo.map((s) => ({ type: s.message.type, frameId: s.frameId })));
}
const sends = (list) => JSON.stringify(list);

test("one click on the icon reads the whole page", async () => {
  const sent = await iconClick([{ frameId: 0, page: 900, selection: 0, reading: false, seen: true }]);
  assert.strictEqual(sent, sends([{ type: "read-page", frameId: 0 }]));
});

test("one click on the icon reads the selected text instead, when there is some", async () => {
  const sent = await iconClick([
    { frameId: 0, page: 900, selection: 0, reading: false, seen: true },
    { frameId: 2, page: 300, selection: 25, reading: false, seen: true },
  ]);
  assert.strictEqual(sent, sends([{ type: "read-selection", frameId: 2 }]));
});

test("clicking the icon while reading pauses or plays", async () => {
  const sent = await iconClick([{ frameId: 0, page: 900, selection: 0, reading: true, seen: true }]);
  assert.strictEqual(sent, sends([{ type: "toggle" }]));
});

test("a new selection while reading starts reading it", async () => {
  const sent = await iconClick([{ frameId: 0, page: 900, selection: 40, reading: true, seen: true }]);
  assert.strictEqual(sent, sends([{ type: "read-selection", frameId: 0 }]));
});
