const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

test("a reading starts as soon as its first part exists", async () => {
  const page = await open();
  await page.read("First part.\n\nSecond part.");
  assert.strictEqual(page.state.plays.length, 0);

  await page.rendered(1, 2);
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/0.wav");
  assert.strictEqual(page.status(), "PART 1 / 2");
  await page.close();
});

test("with loop on, the end of the last part goes back to the first", async () => {
  const page = await open();
  await page.read("First part.\n\nSecond part.");
  await page.rendered(2, 2, "ready");
  page.state.audio.finish();
  page.state.audio.finish();
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/0.wav");
  assert.strictEqual(page.get("index"), 0);
  await page.close();
});
