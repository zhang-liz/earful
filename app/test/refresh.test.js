const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

const SAVED = {
  "readItToMe.job": JSON.stringify({ id: "job1", total: 3, texts: ["A.", "B.", "C."] }),
};
const READY = { state: "ready", done: 3, total: 3, texts: ["A.", "B.", "C."] };
const refreshed = (spot, saved = SAVED) => open({
  saved,
  progress: READY,
  answers: { "/handoff": spot },
});

test("after a refresh, Play carries on from the same spot", async () => {
  const page = await refreshed({ waiting: false, job: "job1", index: 1, at: 40 });
  assert.strictEqual(page.get("index"), 1);
  assert.strictEqual(page.state.plays.length, 0, "a page coming back must stay quiet");
  assert.strictEqual(page.status(), "READY - PRESS PLAY");

  page.$("toggle").click();
  await page.tick();
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/1.wav");
  assert.strictEqual(page.get("pendingSeek"), 40);
  await page.close();
});

test("after a refresh, the same spot is used only once", async () => {
  const page = await refreshed({ waiting: false, job: "job1", index: 1, at: 40 });
  page.$("toggle").click();
  await page.tick();
  page.state.audio.finish();
  await page.tick();
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/2.wav");
  assert.strictEqual(page.get("pendingSeek"), 0);
  await page.close();
});

test("after a refresh, a part still being made is waited for, then starts at the spot", async () => {
  const page = await open({
    saved: SAVED,
    progress: { ...READY, state: "running", done: 1 },
    answers: { "/handoff": { waiting: false, job: "job1", index: 2, at: 7 } },
  });
  page.$("toggle").click();
  await page.tick();
  assert.strictEqual(page.status(), "BUFFERING...");

  await page.rendered(3, 3, "ready");
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/2.wav");
  assert.strictEqual(page.get("pendingSeek"), 7);
  await page.close();
});

test("a spot in another reading does not move this one", async () => {
  const page = await refreshed({ waiting: false, job: "other", index: 2, at: 40 });
  assert.strictEqual(page.get("index"), 0);
  await page.close();
});

test("a spot past the end stays inside the reading", async () => {
  const page = await refreshed({ waiting: false, job: "job1", index: 9, at: 40 });
  assert.strictEqual(page.get("index"), 2);
  await page.close();
});

test("the speed survives a refresh", async () => {
  const first = await open();
  first.$("presets").children[2].click();
  const saved = first.window.localStorage.getItem("readItToMe.speed");
  const expected = first.$("speed").value;
  await first.close();
  assert.ok(saved);

  const page = await open({ saved: { "readItToMe.speed": saved } });
  assert.strictEqual(page.$("speed").value, expected);
  assert.strictEqual(page.$("speedLabel").textContent, `${Number(expected).toFixed(2)}x`);
  await page.read("One.");
  await page.rendered(1, 1, "ready");
  assert.strictEqual(page.state.audio.playbackRate, Number(expected));
  await page.close();
});
