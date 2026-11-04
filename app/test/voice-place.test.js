const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

async function atLastPart() {
  const page = await open();
  await page.read("One.\n\nTwo.\n\nThree.");
  await page.rendered(3, 3, "ready");
  await page.tick();
  page.key(page.window.document.body, { code: "ArrowRight" });
  page.key(page.window.document.body, { code: "ArrowRight" });
  await page.tick();
  return page;
}

async function pick(page, id) {
  const menu = page.$("voice");
  menu.value = id;
  menu.dispatchEvent(new page.window.Event("change"));
  await page.tick(20);
}

test("a new voice carries on from the same part", async () => {
  const page = await atLastPart();
  await pick(page, "af_bella");
  page.state.plays.length = 0;

  await page.rendered(1, 3);
  assert.deepStrictEqual(page.state.plays, [], "the top should not be read again");
  assert.strictEqual(page.status(), "BUFFERING...");

  await page.rendered(3, 3, "ready");
  assert.deepStrictEqual(page.state.plays, ["/chunk/job1/2.wav"]);
  assert.strictEqual(page.status(), "PART 3 / 3");
  await page.close();
});

test("a new voice after the end starts from the top", async () => {
  const page = await atLastPart();
  page.$("loop").click();                 // loop off, so the reading finishes
  page.state.audio.finish();
  await page.tick();
  assert.strictEqual(page.status(), "FINISHED");

  await pick(page, "af_bella");
  page.state.plays.length = 0;
  await page.rendered(1, 3);
  assert.deepStrictEqual(page.state.plays.slice(0, 1), ["/chunk/job1/0.wav"]);
  await page.close();
});
