const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

async function phone() {
  const page = await open({
    page: "continue.html",
    answers: {
      "/handoff": { waiting: false, job: "job1", index: 0, at: 0, total: 3, title: "A reading" },
    },
  });
  page.$("play").click();
  await page.tick();
  return page;
}

test("back on the first part starts that part again, and does not stop", async () => {
  const page = await phone();
  page.state.audio.currentTime = 4;
  page.$("back").click();
  await page.tick();

  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/0.wav");
  assert.strictEqual(page.state.audio.paused, false);
  assert.doesNotMatch(page.$("status").textContent, /Finished/);
  await page.close();
});

test("back from a later part goes to the part before it", async () => {
  const page = await phone();
  page.$("forward").click();
  await page.tick();
  page.$("back").click();
  await page.tick();
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/0.wav");
  await page.close();
});

test("forward past the last part still finishes", async () => {
  const page = await phone();
  page.$("forward").click();
  page.$("forward").click();
  await page.tick();
  page.$("forward").click();
  await page.tick();
  assert.match(page.$("status").textContent, /Finished/);
  await page.close();
});

test("skipping fast does not ask for another tap", async () => {
  const page = await phone();
  page.$("forward").click();
  page.$("forward").click();
  await page.tick();
  assert.doesNotMatch(page.$("status").textContent, /Tap Play again/);
  assert.strictEqual(page.$("play").textContent, "Pause");

  // Pause and play again: it stays on the part it skipped to.
  page.$("play").click();
  page.$("play").click();
  await page.tick();
  assert.strictEqual(page.state.plays.at(-1), "/chunk/job1/2.wav");
  await page.close();
});
