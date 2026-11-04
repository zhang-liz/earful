const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

/** A page reading three parts, with only the first one rendered so far. */
async function buffering() {
  const page = await open();
  await page.read("One.\n\nTwo.\n\nThree.");
  await page.rendered(1, 3);
  page.state.audio.finish();
  assert.strictEqual(page.status(), "BUFFERING...");
  return page;
}

test("pausing while buffering stays paused when the part arrives", async () => {
  const page = await buffering();
  page.$("toggle").click();
  await page.tick();
  const before = page.state.plays.length;

  await page.rendered(2, 3);
  assert.strictEqual(page.state.plays.length, before, "nothing should start on its own");
  assert.strictEqual(page.status(), "PAUSED");
  await page.close();
});

test("after pausing while buffering, play carries on with that part", async () => {
  const page = await buffering();
  page.$("toggle").click();
  await page.tick();
  await page.rendered(2, 3);

  page.$("toggle").click();
  await page.tick();
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/1.wav");
  assert.strictEqual(page.status(), "PART 2 / 3");
  await page.close();
});

test("opening the editor while buffering keeps the audio stopped", async () => {
  const page = await buffering();
  page.$("edit").click();
  const before = page.state.plays.length;

  await page.rendered(2, 3);
  assert.strictEqual(page.state.plays.length, before);
  await page.close();
});

test("an unreachable server is reported, and the button still works", async () => {
  const page = await open();
  page.window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  await page.read("Some words.");

  assert.strictEqual(page.$("go").disabled, false);
  assert.strictEqual(page.status(), "STOPPED");
  assert.match(page.$("error").textContent, /reach the server/);
  assert.ok(!page.$("error").classList.contains("hidden"));
  await page.close();
});

test("an unreachable server does not leave the sample button off", async () => {
  const page = await open();
  page.window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  page.$("sample").click();
  await page.tick(20);
  assert.strictEqual(page.$("sample").disabled, false);
  await page.close();
});

test("an unreachable server is reported when changing voice", async () => {
  const page = await open();
  await page.read("Some words.");
  await page.rendered(1, 1, "ready");
  page.window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));

  page.$("voice").value = "af_bella";
  page.$("voice").dispatchEvent(new page.window.Event("change"));
  await page.tick(20);
  assert.strictEqual(page.status(), "STOPPED");
  await page.close();
});

test("with loop off, play at the end starts again from the top", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.");
  await page.rendered(2, 2, "ready");
  page.$("loop").click();
  page.state.audio.finish();
  page.state.audio.finish();
  assert.strictEqual(page.status(), "FINISHED");

  page.$("toggle").click();
  await page.tick();
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/0.wav");
  assert.strictEqual(page.status(), "PART 1 / 2");
  await page.close();
});

test("arrow keys on the speed slider belong to the slider", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.");
  await page.rendered(2, 2, "ready");

  const event = page.key(page.$("speed"), { code: "ArrowRight", key: "ArrowRight" });
  assert.strictEqual(event.defaultPrevented, false);
  assert.strictEqual(page.get("index"), 0);
  await page.close();
});

test("keys on the voice menu belong to the menu", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.");
  await page.rendered(2, 2, "ready");

  const event = page.key(page.$("voice"), { code: "Space", key: " " });
  assert.strictEqual(event.defaultPrevented, false);
  await page.close();
});

test("Cmd+Left is left to the browser", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.");
  await page.rendered(2, 2, "ready");

  const event = page.key(page.window.document.body,
    { code: "ArrowLeft", key: "ArrowLeft", metaKey: true });
  assert.strictEqual(event.defaultPrevented, false);
  await page.close();
});

test("arrow keys still move between parts everywhere else", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.");
  await page.rendered(2, 2, "ready");

  const event = page.key(page.window.document.body, { code: "ArrowRight", key: "ArrowRight" });
  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(page.get("index"), 1);
  await page.close();
});

test("arrow keys do nothing while the editor is open", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.");
  await page.rendered(2, 2, "ready");
  page.$("edit").click();
  const before = page.state.plays.length;

  page.key(page.window.document.body, { code: "ArrowRight", key: "ArrowRight" });
  await page.tick();
  assert.strictEqual(page.state.plays.length, before);
  await page.close();
});

const SAVED = {
  "readItToMe.job": JSON.stringify({ id: "job1", total: 1, texts: ["Saved."] }),
};
const READY = { state: "ready", done: 1, total: 1, texts: ["Saved."], voice: "bm_george" };

test("after a refresh the voice menu shows the reading's voice", async () => {
  const page = await open({ saved: SAVED, progress: READY });
  assert.strictEqual(page.$("voice").value, "bm_george");
  await page.close();
});

test("picking the voice already in use changes nothing", async () => {
  const page = await open({ saved: SAVED, progress: READY });
  assert.ok(!page.$("download").classList.contains("hidden"));

  page.$("voice").value = "bm_george";
  page.$("voice").dispatchEvent(new page.window.Event("change"));
  await page.tick(20);
  assert.ok(!page.$("download").classList.contains("hidden"), "SAVE .WAV should stay");
  assert.ok(!page.state.requests.some((r) => r.url.startsWith("/voice/")));
  await page.close();
});

test("a voice the server says is unchanged keeps SAVE .WAV", async () => {
  const page = await open({ saved: SAVED, progress: { ...READY, voice: undefined } });
  page.state.voiceAnswer = { changed: false, voice: "af_bella" };

  page.$("voice").value = "af_bella";
  page.$("voice").dispatchEvent(new page.window.Event("change"));
  await page.tick(20);
  assert.ok(!page.$("download").classList.contains("hidden"));
  await page.close();
});

test("opening the editor while playing says paused", async () => {
  const page = await open();
  await page.read("One.\n\nTwo.");
  await page.rendered(2, 2, "ready");
  await page.tick();
  assert.strictEqual(page.status(), "PART 1 / 2");

  page.$("edit").click();
  assert.strictEqual(page.status(), "PAUSED");
  await page.close();
});
