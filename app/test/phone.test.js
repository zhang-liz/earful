const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

const SAVED = {
  "readItToMe.job": JSON.stringify({ id: "job1", total: 3, texts: ["A.", "B.", "C."] }),
};
const posts = (page) => page.state.requests.filter(
  (r) => r.url === "/handoff" && r.init.method === "POST");

test("a refresh does not move the phone's spot back to the start", async () => {
  const page = await open({
    saved: SAVED,
    progress: { state: "ready", done: 3, total: 3, texts: ["A.", "B.", "C."] },
    answers: { "/handoff": { waiting: false, job: "job1", index: 2, at: 40 } },
  });
  assert.strictEqual(posts(page).length, 0);
  await page.close();
});

test("a reading the phone has no spot for is still offered to it", async () => {
  const page = await open({
    saved: SAVED,
    progress: { state: "ready", done: 3, total: 3, texts: ["A.", "B.", "C."] },
    answers: { "/handoff": { waiting: true } },
  });
  assert.strictEqual(posts(page).length, 1);
  await page.close();
});
