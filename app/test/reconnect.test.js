const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

async function dropped(progress) {
  const page = await open({ progress });
  await page.read("One.\n\nTwo.\n\nThree.");
  await page.rendered(1, 3);
  const first = page.state.stream;
  first.fail();
  return { page, first };
}

const RUNNING = { state: "running", done: 1, total: 3, texts: ["One.", "Two.", "Three."] };

test("a dropped connection is followed again", async () => {
  const { page, first } = await dropped(RUNNING);
  assert.ok(first.closed);
  await page.tick(30);
  assert.notStrictEqual(page.state.stream, first, "a new stream should have opened");

  await page.rendered(3, 3, "ready");
  assert.strictEqual(page.get("ready"), 3);
  await page.close();
});

test("a part being waited for still starts after the connection comes back", async () => {
  const { page } = await dropped(RUNNING);
  page.state.audio.finish();
  assert.strictEqual(page.status(), "BUFFERING...");
  await page.tick(30);
  assert.ok(!page.state.stream.closed, "a new stream should be open");

  await page.rendered(2, 3);
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/1.wav");
  await page.close();
});

test("a server that is down is asked again until it answers", async () => {
  const page = await open({ progress: RUNNING });
  await page.read("One.\n\nTwo.\n\nThree.");
  await page.rendered(1, 3);
  const working = page.window.fetch;
  let asked = 0;
  page.window.fetch = async () => { asked++; throw new TypeError("Failed to fetch"); };
  const first = page.state.stream;
  first.fail();
  await page.tick(60);
  assert.ok(asked >= 2, `should keep asking, asked ${asked} times`);
  assert.strictEqual(page.state.stream, first, "no stream until the server answers");

  page.window.fetch = working;
  await page.tick(30);
  assert.notStrictEqual(page.state.stream, first);
  await page.close();
});

test("a reading the server has forgotten is reported, and not asked for again", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.");
  await page.rendered(1, 2);
  let asked = 0;
  page.window.fetch = async () => {
    asked++;
    return { ok: false, status: 404, json: async () => ({ detail: "Unknown job." }) };
  };
  page.state.stream.fail();
  await page.tick(40);

  assert.strictEqual(asked, 1);
  assert.match(page.$("readerError").textContent, /no longer has this reading/);
  await page.close();
});

test("a new reading is not disturbed by a retry for the old one", async () => {
  const page = await open({ progress: RUNNING });
  await page.read("One.\n\nTwo.\n\nThree.");
  await page.rendered(1, 3);
  page.state.stream.fail();
  page.get("job = null");
  await page.tick(30);
  assert.ok(page.state.stream.closed, "no new stream for a reading that is gone");
  await page.close();
});
