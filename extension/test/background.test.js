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
  };

  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => { state.listeners.installed = fn; } },
      onMessage: { addListener: (fn) => { state.listeners.message = fn; } },
    },
    contextMenus: {
      create: (m) => state.menus.push(m),
      onClicked: { addListener: (fn) => { state.listeners.menuClick = fn; } },
    },
    commands: { onCommand: { addListener: (fn) => { state.listeners.command = fn; } } },
    storage: { sync: { get: async () => state.stored } },
    tabs: {
      sendMessage: async (tabId, message) => {
        if (message.type === "ping" && !options.hasScript) throw new Error("no receiver");
        state.sentTo.push({ tabId, message });
        return { ok: true };
      },
      query: async () => (options.noTab ? [] : [{ id: 7 }]),
    },
    scripting: {
      executeScript: async (o) => {
        if (options.cannotInject) throw new Error("cannot run on this page");
        state.injected.push(o);
      },
      insertCSS: async (o) => { state.injected.push(o); },
    },
  };

  const context = { chrome, console: { warn: (...a) => state.warnings.push(a.join(" ")), log: console.log } };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), context);
  return { state, chrome };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("installing adds both right-click entries", () => {
  const { state } = load();
  state.listeners.installed();
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

test("the keyboard shortcut reads the selection", async () => {
  const { state } = load({ hasScript: true });
  await state.listeners.command("read-selection", { id: 7 });
  await settle();
  assert.ok(state.sentTo.some((s) => s.message.type === "read-selection"));
});

test("a menu click with no tab does nothing rather than throwing", async () => {
  const { state } = load({ hasScript: true });
  state.listeners.menuClick({ menuItemId: "read-page" }, undefined);
  await settle();
  assert.strictEqual(state.sentTo.length, 0);
});

test("the popup's commands are passed on to the page", async () => {
  const { state } = load({ hasScript: true });
  let replied = null;
  const async_ = state.listeners.message(
    { type: "popup-command", command: { type: "stop" } }, null, (r) => { replied = r; }
  );
  assert.strictEqual(async_, true, "should keep the channel open to answer");
  await settle();
  assert.ok(state.sentTo.some((s) => s.message.type === "stop"));
  assert.ok(replied, "the popup should get an answer");
});

test("a popup command with no open tab does not throw", async () => {
  const { state } = load({ hasScript: true, noTab: true });
  let replied = null;
  state.listeners.message({ type: "popup-command", command: { type: "stop" } }, null, (r) => { replied = r; });
  await settle();
  assert.ok(replied, "should still answer the popup");
});

test("an unrelated message is left alone", () => {
  const { state } = load();
  const result = state.listeners.message({ type: "something-else" }, null, () => {});
  assert.strictEqual(result, false, "should not claim the channel it does not use");
});
