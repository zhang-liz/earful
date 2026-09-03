// Choosing what on a page is worth reading.

const assert = require("node:assert");
const { test } = require("node:test");
const { load } = require("./harness");

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Read a page and return the text that was sent to the server. */
async function sentText(html, message = { type: "read-page", settings: {} }) {
  let body = null;
  const fetch = async (url, options = {}) => {
    if (url.endsWith("/speak")) {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ id: "j", total: 1, texts: [body.text] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: "j", state: "ready", done: 1, total: 1, error: "" }) };
  };
  const h = load(html, { fetch });
  await h.send(message);
  await settle();
  return body ? body.text : null;
}

test("an article is preferred over the whole page", async () => {
  const text = await sentText(`
    <div><p>Site wide banner text.</p></div>
    <article><p>The real story starts here.</p></article>`);
  assert.match(text, /real story/);
  assert.ok(!/banner/.test(text), "the banner should not be read");
});

test("navigation, footers and sidebars are skipped", async () => {
  const text = await sentText(`<article>
    <nav><p>Home Articles About</p></nav>
    <p>The keeper had not spoken.</p>
    <aside><p>Related reading</p></aside>
    <footer><p>Copyright 1874</p></footer>
  </article>`);
  assert.match(text, /keeper had not spoken/);
  for (const junk of ["Home Articles", "Related reading", "Copyright"]) {
    assert.ok(!text.includes(junk), `"${junk}" should not be read`);
  }
});

test("a paragraph inside a list item is read once, not twice", async () => {
  const text = await sentText(`<article>
    <ul><li><p>He climbed the steps.</p></li></ul>
  </article>`);
  const times = text.split("He climbed the steps").length - 1;
  assert.strictEqual(times, 1, `read ${times} times, should be once`);
});

test("a paragraph inside a blockquote is read once", async () => {
  const text = await sentText(`<article>
    <blockquote><p>A boat appeared.</p></blockquote>
  </article>`);
  assert.strictEqual(text.split("A boat appeared").length - 1, 1);
});

test("code blocks are left out", async () => {
  const text = await sentText(`<article>
    <p>Here is how.</p>
    <pre><code>const x = { a: 1 };</code></pre>
    <p>That is all.</p>
  </article>`);
  assert.match(text, /Here is how/);
  assert.match(text, /That is all/);
  assert.ok(!text.includes("const x"), "code should not be read");
});

test("inline code is taken out of the sentence around it", async () => {
  const text = await sentText(`<article>
    <p>The config is <code>{"a":1,"b":[2,3]}</code> exactly.</p>
  </article>`);
  assert.ok(!text.includes('{"a":1'), "punctuation soup should not be read");
  assert.match(text, /The config is/);
  assert.match(text, /exactly/);
});

test("headings and captions are read", async () => {
  const text = await sentText(`<article>
    <h1>The Lighthouse</h1>
    <h5>A smaller heading</h5>
    <figure><figcaption>Figure one, the harbour.</figcaption></figure>
  </article>`);
  assert.match(text, /The Lighthouse/);
  assert.match(text, /A smaller heading/);
  assert.match(text, /Figure one/);
});

test("hidden parts of the page are not read", async () => {
  const text = await sentText(`<article>
    <p>Visible sentence here.</p>
    <p aria-hidden="true">Hidden sentence here.</p>
  </article>`);
  assert.match(text, /Visible sentence/);
  assert.ok(!text.includes("Hidden sentence"), "aria-hidden content should be skipped");
});

test("a page with no article falls back to the body", async () => {
  const text = await sentText(`<div><p>Just a plain page.</p></div>`);
  assert.match(text, /Just a plain page/);
});

test("the player's own controls are never read back", async () => {
  // Read once so the player exists, then read again.
  const seen = [];
  const fetch = async (url, options = {}) => {
    if (url.endsWith("/speak")) {
      seen.push(JSON.parse(options.body).text);
      return { ok: true, status: 200, json: async () => ({ id: "j", total: 1, texts: ["x"] }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: "j", state: "ready", done: 1, total: 1, error: "" }) };
  };
  const h = load(`<article><p>The keeper had not spoken.</p></article>`, { fetch });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  await h.send({ type: "read-page", settings: {} });
  await settle();

  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0], seen[1], "the second reading should be the same text");
});
