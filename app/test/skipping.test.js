const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

async function reading() {
  const page = await open();
  await page.read("One.\n\nTwo.\n\nThree.\n\nFour.");
  await page.rendered(4, 4, "ready");
  await page.tick();
  return page;
}

test("skipping fast keeps the reading going", async () => {
  const page = await reading();
  for (let i = 0; i < 3; i++) page.key(page.window.document.body, { code: "ArrowRight" });
  await page.tick();

  assert.strictEqual(page.get("playing"), true);
  assert.strictEqual(page.status(), "PART 4 / 4");
  await page.close();
});

test("skipping right as the first part starts keeps the reading going", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.\n\nThree.");
  page.state.stream.send({ state: "ready", done: 3, total: 3, error: "" });
  page.key(page.window.document.body, { code: "ArrowRight" });
  await page.tick();

  assert.strictEqual(page.get("playing"), true);
  assert.strictEqual(page.status(), "PART 2 / 3");
  await page.close();
});

test("the next part follows after skipping fast", async () => {
  const page = await reading();
  page.key(page.window.document.body, { code: "ArrowRight" });
  page.key(page.window.document.body, { code: "ArrowRight" });
  await page.tick();

  page.state.audio.finish();
  await page.tick();
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/3.wav");
  await page.close();
});

test("a browser that refuses to play shows the reading as paused", async () => {
  const page = await reading();
  page.state.audio.play = () =>
    Promise.reject(new page.window.DOMException("Not allowed.", "NotAllowedError"));
  page.key(page.window.document.body, { code: "ArrowRight" });
  await page.tick();

  assert.strictEqual(page.get("playing"), false);
  assert.strictEqual(page.status(), "PAUSED");
  await page.close();
});
