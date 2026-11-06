// The "Read in Earful" bookmark: taking a page's text and reading it here.

const assert = require("node:assert");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { open } = require("./harness");

const KEY = "0123456789abcdef0123456789abcdef";
const SAVED = { "readItToMe.linkKey": KEY };
const linked = (key, text) => `http://127.0.0.1:8888/#read=${key}.${encodeURIComponent(text)}`;
const spoken = (page) => page.state.requests
  .filter((r) => r.url === "/speak")
  .map((r) => JSON.parse(r.init.body).text);

test("a link from the bookmark starts reading its text", async () => {
  const page = await open({ saved: SAVED, url: linked(KEY, "First part.\n\nSecond part.") });
  assert.deepStrictEqual(spoken(page), ["First part.\n\nSecond part."]);
  assert.strictEqual(page.window.location.hash, "", "a refresh must not start it again");
  assert.ok(page.$("inputBox").classList.contains("hidden"));
  await page.close();
});

test("a link without this browser's key is ignored", async () => {
  const page = await open({
    saved: { ...SAVED, "readItToMe.text": "My own notes." },
    url: linked("ffffffffffffffffffffffffffffffff", "Text from some website."),
  });
  assert.deepStrictEqual(spoken(page), []);
  assert.strictEqual(page.$("text").value, "My own notes.");
  await page.close();
});

test("a new link to the same tab starts the new text", async () => {
  const page = await open({ saved: SAVED });
  page.window.location.hash = `read=${KEY}.${encodeURIComponent("Fresh page.")}`;
  await page.tick(20);
  assert.deepStrictEqual(spoken(page), ["Fresh page."]);
  await page.close();
});

test("the bookmark is offered to drag, and clicking it here does nothing", async () => {
  const page = await open({ saved: SAVED });
  const link = page.$("bookmarklet");
  assert.ok(!page.$("bookmarkBox").classList.contains("hidden"));
  assert.match(link.href, /^javascript:/);
  link.click();
  await page.tick(20);
  assert.deepStrictEqual(spoken(page), []);
  assert.match(page.$("bookmarkHint").textContent, /DRAG IT/);
  await page.close();
});

/** Run the bookmark on another page and return the address it opens. */
async function runBookmark(html, select) {
  const earful = await open({ saved: SAVED });
  const source = decodeURIComponent(earful.$("bookmarklet").href.slice("javascript:".length));
  await earful.close();

  const { window } = new JSDOM(html, { url: "https://example.com/story", runScripts: "outside-only" });
  // jsdom has no layout, so no innerText; the text is close enough here.
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
  });
  if (select) window.getSelection().selectAllChildren(window.document.querySelector(select));
  const opened = [];
  window.open = (url, name) => opened.push({ url, name });
  window.alert = (message) => opened.push({ alert: message });
  window.eval(source);
  return opened;
}

test("the bookmark sends the article, without menus or code", async () => {
  const [opened] = await runBookmark(`
    <nav><p>Home and About links.</p></nav>
    <article><h1>Title here</h1><p>The real story.</p><pre><code>{"a":1}</code></pre>
    <p>More with <code>x = 1</code> inline.</p></article>
    <footer><p>Copyright.</p></footer>`);
  assert.strictEqual(opened.name, "earful");
  const prefix = `http://127.0.0.1:8888/#read=${KEY}.`;
  assert.ok(opened.url.startsWith(prefix), opened.url);
  const text = decodeURIComponent(opened.url.slice(prefix.length));
  assert.strictEqual(text, "Title here\n\nThe real story.\n\nMore with inline.");
});

test("the bookmark sends only the selection when there is one", async () => {
  const [opened] = await runBookmark(
    `<article><p id="one">Just this bit.</p><p>Not this.</p></article>`, "#one");
  assert.ok(opened.url.endsWith(encodeURIComponent("Just this bit.")), opened.url);
});

test("a page with no text says so instead of opening Earful", async () => {
  const opened = await runBookmark("<body></body>");
  assert.deepStrictEqual(opened, [{ alert: "Earful found no text on this page." }]);
});
