const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

/** A page reading two parts, with the sample's audio faked and easy to find. */
async function playing() {
  const page = await open();
  page.window.URL.createObjectURL = () => "blob:sample";
  const server = page.window.fetch;
  page.window.fetch = async (url, init) => (url === "/preview"
    ? { ok: true, blob: async () => ({}) }
    : server(url, init));
  await page.read("One.\n\nTwo.");
  await page.rendered(2, 2, "ready");
  await page.tick();
  page.reader = page.state.audio;
  return page;
}

async function hearVoice(page) {
  page.$("sample").click();
  await page.tick(20);
  return page.state.audio;      // the newest audio made is the sample
}

test("the reading pauses while a voice sample plays", async () => {
  const page = await playing();
  const sample = await hearVoice(page);

  assert.notStrictEqual(sample, page.reader);
  assert.strictEqual(sample.paused, false);
  assert.strictEqual(page.reader.paused, true);
  assert.strictEqual(page.status(), "PAUSED");
  await page.close();
});

test("the reading carries on when the sample ends", async () => {
  const page = await playing();
  const sample = await hearVoice(page);
  sample.finish();
  await page.tick();

  assert.strictEqual(page.reader.paused, false);
  assert.strictEqual(page.get("playing"), true);
  await page.close();
});

test("a paused reading stays paused after the sample", async () => {
  const page = await playing();
  page.$("toggle").click();
  await page.tick();
  const sample = await hearVoice(page);
  sample.finish();
  await page.tick();

  assert.strictEqual(page.reader.paused, true);
  assert.strictEqual(page.get("playing"), false);
  await page.close();
});

test("pressing play stops the sample", async () => {
  const page = await playing();
  const sample = await hearVoice(page);
  page.$("toggle").click();
  await page.tick();

  assert.strictEqual(sample.paused, true);
  assert.strictEqual(page.reader.paused, false);
  await page.close();
});

test("a second sample replaces the first", async () => {
  const page = await playing();
  const first = await hearVoice(page);
  const second = await hearVoice(page);

  assert.strictEqual(first.paused, true);
  assert.strictEqual(second.paused, false);
  second.finish();
  await page.tick();
  assert.strictEqual(page.reader.paused, false, "the reading should still carry on");
  await page.close();
});
