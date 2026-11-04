const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

async function reading() {
  const page = await open();
  await page.read("One.\n\nTwo.\n\nThree.");
  await page.rendered(3, 3, "ready");
  await page.tick();
  return page;
}

async function pick(page, id) {
  const menu = page.$("voice");
  menu.value = id;
  menu.dispatchEvent(new page.window.Event("change"));
  await page.tick(20);
}

const hidden = (page) => page.$("error").classList.contains("hidden");

test("a voice that cannot load leaves the reading as it was", async () => {
  const page = await reading();
  page.state.voiceStatus = 503;
  page.state.voiceAnswer = { detail: "Could not load that voice." };
  await pick(page, "af_bella");

  assert.strictEqual(page.$("voice").value, page.get("job.voice"));
  assert.notStrictEqual(page.$("voice").value, "af_bella");
  assert.strictEqual(page.$("error").textContent, "Could not load that voice.");
  assert.strictEqual(page.status(), "STOPPED");
  assert.strictEqual(page.$("clock").textContent, "ALL PARTS READY");

  page.$("toggle").click();
  await page.tick();
  assert.strictEqual(page.get("playing"), true);
  assert.match(page.status(), /^PART \d \/ 3$/);
  await page.close();
});

test("the error goes away when the next voice works", async () => {
  const page = await reading();
  page.state.voiceStatus = 503;
  page.state.voiceAnswer = { detail: "Could not load that voice." };
  await pick(page, "af_bella");
  assert.strictEqual(hidden(page), false);

  page.state.voiceStatus = 200;
  page.state.voiceAnswer = { changed: true, voice: "bm_george", total: 3 };
  await pick(page, "bm_george");
  assert.strictEqual(hidden(page), true);
  await page.close();
});

test("a reading that fails says how many parts it has", async () => {
  const page = await reading();
  await pick(page, "af_bella");
  page.state.stream.send({ state: "error", done: 0, total: 3, error: "Out of memory." });
  await page.tick();

  assert.strictEqual(page.$("clock").textContent, "0/3 PARTS READY");
  assert.strictEqual(page.$("error").textContent, "Out of memory.");
  await page.close();
});

test("a reading that failed stops at the last part it has", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.\n\nThree.");
  await page.rendered(1, 3);
  page.state.stream.send({ state: "error", done: 1, total: 3, error: "Out of memory." });
  await page.tick();

  page.state.audio.finish();
  await page.tick();
  assert.strictEqual(page.status(), "STOPPED");
  assert.strictEqual(page.get("playing"), false);
  assert.strictEqual(page.$("toggle").innerHTML.charCodeAt(0), 9654);
  await page.close();
});

test("a part already being waited for stops when the reading fails", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.\n\nThree.");
  await page.rendered(1, 3);
  page.state.audio.finish();
  assert.strictEqual(page.status(), "BUFFERING...");

  page.state.stream.send({ state: "error", done: 1, total: 3, error: "Out of memory." });
  await page.tick();
  assert.strictEqual(page.status(), "STOPPED");
  assert.strictEqual(page.get("waiting"), false);
  assert.strictEqual(page.get("playing"), false);
  await page.close();
});

test("play after a failed reading does not wait for ever", async () => {
  const page = await reading();
  await pick(page, "af_bella");
  page.state.stream.send({ state: "error", done: 0, total: 3, error: "Out of memory." });
  await page.tick();

  page.$("toggle").click();
  await page.tick();
  assert.strictEqual(page.status(), "STOPPED");
  assert.strictEqual(page.get("playing"), false);
  assert.strictEqual(hidden(page), false, "the reason should stay on screen");
  await page.close();
});
