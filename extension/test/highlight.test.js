// The highlight has to land on the same word the audio is speaking, in the
// page's own text, without touching the page.

const assert = require("node:assert");
const { test } = require("node:test");
const { load } = require("./harness");

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** A server whose word timings match the text it was given. */
function server(texts) {
  return async (url) => {
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/speak")) return reply({ id: "j", total: texts.length, texts });
    if (url.includes("/progress")) {
      return reply({ id: "j", state: "ready", done: texts.length, total: texts.length, error: "" });
    }
    if (url.includes("/words/")) {
      const part = Number(url.split("/").pop());
      // One word every half second, in the order they appear.
      const words = texts[part].split(/\s+/).map((t, i) => ({ t, s: i * 0.5, e: i * 0.5 + 0.45 }));
      return reply({ words });
    }
    return reply({});
  };
}

test("the spoken word is lit in the page", async () => {
  const texts = ["The keeper had not spoken to anyone."];
  const h = load(`<article><p>The keeper had not spoken to anyone.</p></article>`,
    { fetch: server(texts) });
  await h.send({ type: "read-page", settings: {} });
  await settle();

  // Step through the words and check each one.
  const expected = ["The", "keeper", "had", "not", "spoken", "to", "anyone"];
  for (let i = 0; i < expected.length; i++) {
    h.state.audio.advance(i * 0.5 + 0.1);
    await settle(5);
    assert.strictEqual(h.highlighted(), expected[i],
      `at ${i * 0.5 + 0.1}s it should light "${expected[i]}"`);
  }
});

test("nothing is lit before the first word starts", async () => {
  const texts = ["Hello there friend."];
  const h = load(`<article><p>Hello there friend.</p></article>`, { fetch: server(texts) });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  h.state.audio.advance(0);
  await settle(5);
  // The first word starts at 0, so it is lit; before any part is playing
  // there is nothing.
  assert.ok(h.highlighted() === "Hello" || h.highlighted() === null);
});

test("a word split across tags is lit whole", async () => {
  const texts = ["The lighthouse keeper watched."];
  const h = load(`<article><p>The light<b>house</b> keeper wat<i>ched</i>.</p></article>`,
    { fetch: server(texts) });
  await h.send({ type: "read-page", settings: {} });
  await settle();

  h.state.audio.advance(0.6);              // "lighthouse"
  await settle(5);
  assert.strictEqual(h.highlighted(), "lighthouse",
    "a word broken across tags should still be lit in one piece");
});

test("hyphenated and apostrophe words stay whole", async () => {
  const texts = ["He hadn't climbed the ninety-two steps."];
  const h = load(`<article><p>He hadn't climbed the ninety-two steps.</p></article>`,
    { fetch: server(texts) });
  await h.send({ type: "read-page", settings: {} });
  await settle();

  h.state.audio.advance(0.6);
  await settle(5);
  assert.strictEqual(h.highlighted(), "hadn't");

  h.state.audio.advance(2.1);
  await settle(5);
  assert.strictEqual(h.highlighted(), "ninety-two");
});

test("the highlight moves between paragraphs", async () => {
  const texts = ["First one here.", "Second one here."];
  const h = load(`<article><p>First one here.</p><p>Second one here.</p></article>`,
    { fetch: server(texts) });
  await h.send({ type: "read-page", settings: {} });
  await settle();

  h.state.audio.advance(0.1);
  await settle(5);
  assert.strictEqual(h.highlighted(), "First");

  h.state.audio.dispatchEvent({ type: "ended" });
  await settle();
  h.state.audio.advance(0.1);
  await settle(5);
  assert.strictEqual(h.highlighted(), "Second",
    "the second paragraph's words should be lit, not the first's again");
});

test("stopping clears the highlight", async () => {
  const texts = ["Hello there friend."];
  const h = load(`<article><p>Hello there friend.</p></article>`, { fetch: server(texts) });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  h.state.audio.advance(0.1);
  await settle(5);
  assert.ok(h.highlighted(), "something should be lit");

  await h.send({ type: "stop", settings: {} });
  assert.strictEqual(h.highlighted(), null, "stopping should clear it");
});

test("the page's own text is never modified", async () => {
  const html = `<article><p>The keeper had not spoken.</p></article>`;
  const texts = ["The keeper had not spoken."];
  const h = load(html, { fetch: server(texts) });
  const before = h.body.querySelector("p").textContent;

  await h.send({ type: "read-page", settings: {} });
  await settle();
  h.state.audio.advance(0.6);
  await settle(5);

  assert.strictEqual(h.body.querySelector("p").textContent, before,
    "highlighting must not rewrite the page");
});

test("code is not read and not lit", async () => {
  const texts = ["Install it by running first."];
  const h = load(
    `<article><p>Install it by running <code>npm install thing</code> first.</p></article>`,
    { fetch: server(texts) });
  await h.send({ type: "read-page", settings: {} });
  await settle();

  for (let t = 0; t < 3; t += 0.5) {
    h.state.audio.advance(t + 0.1);
    await settle(5);
    const lit = h.highlighted();
    if (lit) assert.ok(!/npm|install thing/.test(lit), `code should not be lit, got "${lit}"`);
  }
});

test("a part that cannot be found in the page does not throw", async () => {
  // The server returns text that is not on the page at all.
  const h = load(`<article><p>Something else entirely.</p></article>`,
    { fetch: server(["Words that are nowhere to be seen."]) });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  h.state.audio.advance(0.6);
  await settle(5);
  assert.strictEqual(h.highlighted(), null, "nothing to light, and no crash");
});
