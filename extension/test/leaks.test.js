// Things that keep running after they should have stopped.
//
// A poller left behind keeps asking a server that may be gone, forever, and
// nothing on screen shows it. These check that everything started is stopped.

const assert = require("node:assert");
const { test } = require("node:test");
const { load } = require("./harness");

const PAGE = `<article><p>The keeper had not spoken to anyone.</p></article>`;
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** A server that can be made to fail partway through. */
function server() {
  const state = { polls: 0, broken: false };
  const fetch = async (url) => {
    if (url.includes("/progress")) {
      state.polls++;
      if (state.broken) throw new Error("server went away");
    }
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/speak")) return reply({ id: "j", total: 1, texts: ["The keeper had not spoken to anyone."] });
    if (url.includes("/progress")) return reply({ id: "j", state: "running", done: 0, total: 1, error: "" });
    if (url.includes("/words/")) return reply({ words: [{ t: "The", s: 0, e: 0.4 }] });
    return reply({});
  };
  return { fetch, state };
}

test("stopping ends the progress polling", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: { password: "secret" } });
  await settle(200);

  await h.send({ type: "stop", settings: {} });
  const after = s.state.polls;
  await settle(400);
  assert.strictEqual(s.state.polls, after,
    `polling continued after stop: ${s.state.polls - after} more requests`);
});

test("a server that dies does not leave the polling running", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: { password: "secret" } });
  await settle(200);

  s.state.broken = true;                 // the server goes away
  // One more request discovers it is gone; after that there must be silence.
  await settle(1000);
  const after = s.state.polls;
  await settle(1000);
  assert.strictEqual(s.state.polls, after,
    `kept asking a dead server ${s.state.polls - after} more times`);
});

test("reading twice does not leave two pollers running", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: { password: "secret" } });
  await settle(100);
  await h.send({ type: "read-page", settings: { password: "secret" } });
  await settle(100);

  const before = s.state.polls;
  await settle(600);                      // the harness polls every 30ms
  const rate = s.state.polls - before;
  assert.ok(rate <= 30, `expected about 20 polls, got ${rate}: pollers are stacking`);
});

test("losing the server says so instead of failing quietly", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: { password: "secret" } });
  await settle(100);
  s.state.broken = true;
  await settle(1000);
  assert.match(h.status(), /Lost the Earful app/);
});

test("closing the player stops the polling too", async () => {
  const s = server();
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: { password: "secret" } });
  await settle(200);

  h.button("close").click();
  const after = s.state.polls;
  await settle(500);
  assert.strictEqual(s.state.polls, after, "closing should stop the polling");
});
