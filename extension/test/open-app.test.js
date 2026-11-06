// The Earful app is closed: the player offers to open it, then reads what was
// asked once the app answers.

const assert = require("node:assert");
const { test } = require("node:test");
const { load, words } = require("./harness");

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const zh = words("zh");
const PAGE = "<article><p>One sentence to read.</p></article>";

/** A server that is closed until open() is called. */
function app() {
  const state = { open: false, spoke: [] };
  const fetch = async (url, init) => {
    if (!state.open) throw new Error("connection refused");
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/speak")) {
      state.spoke.push(JSON.parse(init.body).text);
      return reply({ id: "j", total: 1, texts: ["One sentence to read."] });
    }
    if (url.includes("/progress")) return reply({ id: "j", state: "ready", done: 1, total: 1, error: "" });
    if (url.includes("/words/")) return reply({ words: [] });
    return reply({ voices: [] });
  };
  return { state, fetch };
}

/** Record links the script clicks, as Chrome would hand them to macOS. */
function watchLinks(h) {
  const clicked = [];
  const make = h.doc.createElement;
  h.doc.createElement = (tag) => {
    const element = make(tag);
    if (tag === "a") element.click = () => clicked.push(element.href);
    return element;
  };
  return clicked;
}

const openButton = (h) => h.button("openApp");

test("a closed app on this computer is offered to be opened", async () => {
  const a = app();
  const h = load(PAGE, { fetch: a.fetch, language: "zh" });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  assert.strictEqual(h.status(), zh.statusAppClosed);
  assert.strictEqual(openButton(h).getAttribute("hidden"), null, "the button shows");
  assert.strictEqual(openButton(h).textContent, zh.playerOpenApp);
});

test("opening the app reads what was asked once it answers", async () => {
  const a = app();
  const h = load(PAGE, { fetch: a.fetch });
  const clicked = watchLinks(h);
  await h.send({ type: "read-page", settings: {} });
  await settle();
  openButton(h).click();
  await settle();
  assert.deepStrictEqual(clicked, ["earful://wake"]);
  assert.match(h.status(), /Opening Earful/);

  a.state.open = true;
  await settle(1300);
  assert.deepStrictEqual(a.state.spoke, ["One sentence to read."]);
  assert.match(h.status(), /Part 1 \/ 1/);
});

test("closing the player stops waiting for the app", async () => {
  const a = app();
  const h = load(PAGE, { fetch: a.fetch });
  watchLinks(h);
  await h.send({ type: "read-page", settings: {} });
  await settle();
  openButton(h).click();
  await settle();
  h.button("close").click();
  a.state.open = true;
  await settle(1300);
  assert.deepStrictEqual(a.state.spoke, [], "nothing is read after the player closed");
});

test("a server on another computer is not offered to be opened", async () => {
  const a = app();
  const h = load(PAGE, { fetch: a.fetch });
  await h.send({ type: "read-page", settings: { server: "http://192.168.1.5:8888" } });
  await settle();
  assert.match(h.status(), /Cannot reach/);
  assert.strictEqual(openButton(h).getAttribute("hidden"), "");
});
