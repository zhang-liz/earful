// The extension's words: one table per language in _locales, and a reader
// who speaks only Chinese never meets an English word they need to read.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { load, words, parse } = require("./harness");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const en = words("en");
const zh = words("zh");
const holes = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// What may stay in Latin letters on a Chinese screen: the app's name, key
// names, the switch back to English, and the English voices' own names.
const ALLOWED = new Set(["Earful", "EARFUL", "Alt", "R", "x", "English", "Heart"]);
const latin = (text) => (text.match(/[A-Za-z]+/g) || []).filter((word) => !ALLOWED.has(word));

test("both languages have the same words, with the same blanks", () => {
  assert.deepStrictEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.deepStrictEqual(holes(zh[key]), holes(en[key]), `${key} fills different blanks`);
    assert.doesNotMatch(en[key] + zh[key], /["<>]/, `${key} would break the player's markup`);
  }
});

test("every word is used, and every word used exists", () => {
  const code = ["content.js", "background.js", "options.js", "options.html", "manifest.json"]
    .map(read).join("\n");
  for (const key of Object.keys(en)) {
    if (key.startsWith("error_")) continue;   // chosen by the server's code
    assert.ok(new RegExp(`["'\`_]${key}["'\`_]`).test(code), `${key} is never used`);
  }
  const asked = [...code.matchAll(/\bt\("(\w+)"/g), ...code.matchAll(/data-i18n(?:-title)?="(\w+)"/g)]
    .map((m) => m[1]);
  for (const key of asked) assert.ok(key in en, `${key} is used but has no words`);
});

test("every error the server can send has words in both languages", () => {
  const server = fs.readFileSync(path.join(root, "..", "app", "server.py"), "utf8");
  const codes = [...server.matchAll(/Refusal\(\d+, "(\w+)"/g)].map((m) => m[1]);
  assert.ok(codes.length > 3, "found the server's codes");
  for (const code of new Set(codes)) {
    assert.ok(en[`error_${code}`] && zh[`error_${code}`], `error_${code} is missing`);
  }
});

test("no English is typed straight into what the reader sees", () => {
  const content = read("content.js");
  assert.doesNotMatch(content, /setStatus\(\s*["`]/, "a status is typed in");
  assert.doesNotMatch(content, /title="[^$"]/, "a button title is typed in");
  const options = read("options.html").replace(/<style>[\s\S]*?<\/style>/, "");
  const shown = options.replace(/<[^>]*>/g, " ").replace(/<!doctype html>/i, "");
  assert.deepStrictEqual(latin(shown).filter((w) => w !== "doctype" && w !== "html"), [],
    "the settings page shows typed-in words");
});

/** A server that reads the given parts. */
function server(texts, refuse) {
  const sent = [];
  const fetch = async (url, init) => {
    const reply = (b, status = 200) => ({ ok: status < 300, status, json: async () => b });
    if (url.endsWith("/speak")) {
      sent.push(JSON.parse(init.body));
      if (refuse) return reply(refuse, 400);
      return reply({ id: "j", total: texts.length, texts });
    }
    if (url.includes("/progress")) {
      return reply({ id: "j", state: "ready", done: texts.length, total: texts.length, error: "" });
    }
    if (url.includes("/words/")) return reply({ words: [] });
    return reply({});
  };
  return { fetch, sent };
}

/** Everything the player shows: its status and every button's title. */
function playerWords(h) {
  const host = h.doc.getElementById("read-it-to-me-root");
  const all = [...host.shadowRoot.walk()];
  return [h.status(), ...all.map((el) => el.getAttribute?.("title")).filter(Boolean)].join(" ");
}

test("the player speaks Chinese to a Chinese reader", async () => {
  const s = server(["今天天气很好。"]);
  const h = load("<article><p>今天天气很好。</p></article>", { fetch: s.fetch, language: "zh" });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  assert.match(h.status(), /^第 1 \/ 1 段$/);
  assert.deepStrictEqual(latin(playerWords(h)), []);
});

test("a refusal is shown in the reader's language", async () => {
  const s = server([], { detail: "Unknown voice: 'zz'", code: "unknown_voice" });
  const h = load("<article><p>你好。</p></article>", { fetch: s.fetch, language: "zh" });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  assert.strictEqual(h.status(), zh.error_unknown_voice);
});

test("an English reader still sees English", async () => {
  const s = server(["Hello there."]);
  const h = load("<article><p>Hello there.</p></article>", { fetch: s.fetch });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  assert.match(h.status(), /^Part 1 \/ 1$/);
});

test("the Mandarin voice and a forced language go to the server", async () => {
  const s = server(["你好。"]);
  const h = load("<article><p>你好。</p></article>", { fetch: s.fetch });
  await h.send({ type: "read-page", settings: { voice: "af_bella", voiceZh: "zm_014", readLanguage: "zh" } });
  await settle();
  assert.deepStrictEqual({ ...s.sent[0] }, { text: "你好。", voice: "af_bella", voices: { zh: "zm_014" }, language: "zh" });
});

test("settings saved by an older version send only the one voice", async () => {
  const s = server(["Hi."]);
  const h = load("<article><p>Hi.</p></article>", { fetch: s.fetch });
  await h.send({ type: "read-page", settings: { voice: "am_adam" } });
  await settle();
  assert.deepStrictEqual({ ...s.sent[0] }, { text: "Hi.", voice: "am_adam" });
});

/* ---------------- the background worker ---------------- */

/** background.js with just enough of Chrome to name its menus. */
function worker({ browser = "en-US", stored = {} } = {}) {
  const state = { menus: [], listeners: {}, stored };
  const chrome = {
    runtime: {
      onInstalled: { addListener: (fn) => { state.listeners.installed = fn; } },
      onStartup: { addListener: (fn) => { state.listeners.startup = fn; } },
      onMessage: { addListener: () => {} },
      onConnect: { addListener: () => {} },
      getURL: (file) => `chrome-extension://earful/${file}`,
    },
    contextMenus: {
      create: (m) => state.menus.push(m),
      update: (id, change) => { state.menus.find((m) => m.id === id).title = change.title; },
      onClicked: { addListener: () => {} },
    },
    commands: { onCommand: { addListener: () => {} } },
    action: { onClicked: { addListener: () => {} }, setTitle: ({ title }) => { state.title = title; } },
    i18n: { getUILanguage: () => browser },
    storage: {
      sync: { get: async () => state.stored },
      onChanged: { addListener: (fn) => { state.listeners.changed = fn; } },
    },
  };
  const fetch = async (url) => {
    const file = String(url).replace("chrome-extension://earful/", "");
    return { json: async () => JSON.parse(read(file)) };
  };
  const context = { chrome, fetch, crypto, setTimeout, console };
  context.importScripts = (...files) => files.forEach((f) => vm.runInContext(read(f), context));
  vm.createContext(context);
  vm.runInContext(read("background.js"), context);
  return state;
}

const titles = (state) => state.menus.map((m) => m.title);

test("a Chinese browser gets Chinese menus", async () => {
  const state = worker({ browser: "zh-CN" });
  await state.listeners.installed();
  assert.deepStrictEqual(titles(state), [zh.menuReadSelection, zh.menuReadPage]);
  assert.strictEqual(state.title, zh.actionTitle);
});

test("switching language renames the menus at once", async () => {
  const state = worker({ browser: "en-US" });
  await state.listeners.installed();
  assert.deepStrictEqual(titles(state), [en.menuReadSelection, en.menuReadPage]);
  state.stored.language = "zh";
  await state.listeners.changed({ language: { newValue: "zh" } });
  assert.deepStrictEqual(titles(state), [zh.menuReadSelection, zh.menuReadPage]);
  assert.strictEqual(state.title, zh.actionTitle);
});

/* ---------------- the settings page ---------------- */

const VOICES = {
  default: "af_heart",
  languages: [{ id: "en", name: "English", default: "af_heart" }, { id: "zh", name: "中文", default: "zf_044" }],
  voices: [
    { id: "af_heart", label: "Heart — US female", labels: { en: "Heart — US female", zh: "Heart — 美式女声" }, language: "en" },
    { id: "zf_044", label: "Mandarin female — natural", labels: { en: "Mandarin female — natural", zh: "普通话女声 — 自然" }, language: "zh" },
    { id: "zm_014", label: "Mandarin male — deep", labels: { en: "Mandarin male — deep", zh: "普通话男声 — 低沉" }, language: "zh" },
  ],
};

/** options.html and options.js in a fake page, against a fake server. */
async function settingsPage({ browser = "en-US", stored = {}, voices = VOICES } = {}) {
  const state = { stored: { ...stored } };
  const doc = {};
  const body = parse(read("options.html"), doc);
  doc.body = body;
  doc.documentElement = { lang: "" };
  doc.getElementById = (id) => body.getElementById(id);
  doc.querySelectorAll = (s) => body.querySelectorAll(s);
  doc.createElement = (tag) => { const el = parse(`<${tag}></${tag}>`, doc).children[0]; return el; };
  const chrome = {
    runtime: { getURL: (file) => `chrome-extension://earful/${file}` },
    i18n: { getUILanguage: () => browser },
    storage: { sync: {
      get: async () => ({ ...state.stored }),
      set: async (change) => Object.assign(state.stored, change),
    } },
    permissions: { contains: async () => true },
  };
  const fetch = async (url) => {
    if (String(url).startsWith("chrome-extension://")) {
      return { ok: true, json: async () => JSON.parse(read(String(url).replace("chrome-extension://earful/", ""))) };
    }
    return { ok: true, status: 200, json: async () => voices };
  };
  const context = { document: doc, chrome, fetch, btoa, URL, console };
  vm.createContext(context);
  vm.runInContext(read("strings.js"), context);
  vm.runInContext(read("options.js"), context);
  await settle();
  const $ = (id) => body.getElementById(id);
  const shown = () => body.querySelectorAll("[data-i18n]").map((el) => el.textContent)
    .concat(body.querySelectorAll("option").map((el) => el.textContent)).join(" ");
  return { state, doc, $, shown };
}

test("the settings page is all Chinese for a Chinese browser", async () => {
  const page = await settingsPage({ browser: "zh-CN" });
  assert.strictEqual(page.doc.documentElement.lang, "zh-CN");
  assert.strictEqual(page.$("language").textContent, "English");
  assert.deepStrictEqual(latin(page.shown()), []);
  assert.strictEqual(page.$("zhRow").hidden, false);
  assert.strictEqual(page.$("voiceZh").value, "zf_044", "the Mandarin default is picked");
});

test("one click on the switch shows English, and it is remembered", async () => {
  const page = await settingsPage({ browser: "zh-CN" });
  page.$("language").click();
  await settle();
  assert.strictEqual(page.state.stored.language, "en");
  assert.strictEqual(page.$("language").textContent, "中文");
  assert.match(page.shown(), /English voice/);
  assert.match(page.$("note").textContent, /Connected\. 3 voices\./);
});

test("picking a Mandarin voice and a reading language saves them", async () => {
  const page = await settingsPage();
  page.$("voiceZh").value = "zm_014";
  page.$("voiceZh").dispatchEvent({ type: "change" });
  await settle();
  page.$("readLanguage").value = "zh";
  page.$("readLanguage").dispatchEvent({ type: "change" });
  await settle();
  assert.strictEqual(page.state.stored.voiceZh, "zm_014");
  assert.strictEqual(page.state.stored.readLanguage, "zh");
  assert.strictEqual(page.state.stored.voice, "af_heart");
});

test("an older server keeps the one voice picker and the old choice", async () => {
  const old = { default: "af_heart", voices: [{ id: "af_heart", label: "Heart" }, { id: "am_adam", label: "Adam" }] };
  const page = await settingsPage({ voices: old, stored: { voice: "am_adam", voiceZh: "zm_014" } });
  assert.strictEqual(page.$("zhRow").hidden, true);
  assert.strictEqual(page.$("voice").value, "am_adam");
  page.$("voice").dispatchEvent({ type: "change" });
  await settle();
  assert.strictEqual(page.state.stored.voiceZh, "zm_014", "a hidden picker must not wipe the choice");
});
