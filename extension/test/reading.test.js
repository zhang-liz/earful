// What the browser extension does when asked to read a page.
//
// The content script is loaded unmodified against a small fake browser, so
// these exercise its real decisions: what it sends, what it says, and what it
// does when the browser or the server behaves badly.

const assert = require("node:assert");
const { test } = require("node:test");
const { load } = require("./harness");

const PAGE = `<article>
<h1>The Lighthouse</h1>
<p>The keeper had not spoken to anyone in three weeks.</p>
<p>He preferred it that way, and the boat came on Thursdays.</p>
</article>`;

/** A server that answers the way the real one does. */
function server(overrides = {}) {
  const sent = [];
  const texts = overrides.texts || [
    "The Lighthouse",
    "The keeper had not spoken to anyone in three weeks.",
    "He preferred it that way, and the boat came on Thursdays.",
  ];
  const fetch = async (url, options = {}) => {
    sent.push({ url, options });
    const reply = (body, ok = true, status = 200) => ({
      ok, status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (overrides.fail) throw new Error("unreachable");
    if (url.endsWith("/speak")) {
      if (overrides.refuse) return reply({ detail: overrides.refuse }, false, 400);
      return reply({ id: "job1", total: texts.length, texts });
    }
    if (url.includes("/progress-once/")) {
      return reply({ id: "job1", state: "ready", done: texts.length, total: texts.length, error: "" });
    }
    if (url.includes("/words/")) {
      const part = Number(url.split("/").pop());
      const words = texts[part].split(/\s+/).map((t, i) => ({ t, s: i * 0.5, e: i * 0.5 + 0.4 }));
      return reply({ words });
    }
    return reply({}, false, 404);
  };
  return { fetch, sent };
}

/** Let queued promises settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

test("reading a page sends its text and shows a player", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: {} });
  await settle();

  const speak = s.sent.find((r) => r.url.endsWith("/speak"));
  assert.ok(speak, "should have asked the server to speak");
  const body = JSON.parse(speak.options.body);
  assert.match(body.text, /The keeper had not spoken/);
  assert.ok(h.doc.getElementById("read-it-to-me-root"), "the player should be on the page");
});

test("an unreachable server is reported in the player", async () => {
  const s = server({ fail: true });
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: { server: "http://192.168.1.5:8888" } });
  await settle();
  assert.match(h.status(), /Cannot reach http:\/\/192\.168\.1\.5:8888/);
});

test("a refusal from the server is shown, not swallowed", async () => {
  const s = server({ refuse: "That voice does not exist." });
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  assert.match(h.status(), /voice does not exist/);
});

test("an empty selection is not sent to the server", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read", text: "   ", settings: {} });
  await settle();
  assert.strictEqual(s.sent.length, 0, "nothing should have been sent");
});

test("a blocked browser is noticed rather than pretending to read", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch, blocked: true });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  await new Promise((r) => setTimeout(r, 800));   // the check runs after a moment
  assert.match(h.status(), /Click here to start/);
});

test("stopping after a blocked read does not leave the click message behind",
  async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch, blocked: true });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  await new Promise((r) => setTimeout(r, 800));
  assert.match(h.status(), /Click here to start/);

  // Sound works now, and a fresh read begins.
  h.state.audio.silent = false;
  await h.send({ type: "stop", settings: {} });
  await h.send({ type: "read-page", settings: {} });
  await settle();

  assert.ok(!/Click here to start/.test(h.status()),
    `a new reading should not still say to click: "${h.status()}"`);
});

test("stopping takes the player off the page", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  assert.ok(h.doc.getElementById("read-it-to-me-root"));

  await h.send({ type: "stop", settings: {} });
  assert.strictEqual(h.doc.getElementById("read-it-to-me-root"), null,
    "the player should be gone");
});

test("reading again replaces the first reading rather than stacking", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  await h.send({ type: "read-page", settings: {} });
  await settle();

  const hosts = h.body.querySelectorAll("#read-it-to-me-root");
  assert.strictEqual(hosts.length, 1, "there should only ever be one player");
});

test("settings sent with the message are used", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({
    type: "read-page",
    settings: { server: "http://192.168.1.5:8888", voice: "af_heart", speed: 1.5 },
  });
  await settle();

  const speak = s.sent.find((r) => r.url.endsWith("/speak"));
  assert.match(speak.url, /192\.168\.1\.5/, "should use the server it was given");
  assert.strictEqual(JSON.parse(speak.options.body).voice, "af_heart");
});

test("a ping is answered, so the worker knows the script is there", async () => {
  const h = load(PAGE, { fetch: server().fetch });
  const reply = await h.send({ type: "ping" });
  assert.deepEqual(reply, { ok: true });
});

test("calls to the server go through the background worker, not this page", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  h.context.fetch = () => { throw new Error("the page's own fetch is held to the page's rules"); };
  const asked = [];
  const relay = h.context.chrome.runtime.sendMessage;
  h.context.chrome.runtime.sendMessage = (message) => {
    asked.push(message.path);
    h.context.fetch = s.fetch;
    const answer = relay(message);
    h.context.fetch = () => { throw new Error("the page's own fetch is held to the page's rules"); };
    return answer;
  };
  await h.send({ type: "read-page", settings: {} });
  await settle();
  assert.ok(asked.includes("/speak"), "the reading should be asked for through the worker");
});
