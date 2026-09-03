// Tests the reading session end to end against the real server.
//
// The player is faked, because the point is to check the decisions the
// extension makes: what it asks for, when it starts, what it highlights, and
// what it does when things go wrong.

const assert = require("node:assert");
const { test } = require("node:test");
const { Session } = require("../src/session");

const SERVER = process.env.TTS_SERVER || "http://127.0.0.1:8888";

/** Stands in for the webview. Records what it was told to do. */
class FakePlayer {
  constructor() { this.sent = []; }
  post(message) { this.sent.push(message); }
  last(type) {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].type === type) return this.sent[i];
    }
    return null;
  }
  count(type) { return this.sent.filter((m) => m.type === type).length; }
}

function build(overrides = {}) {
  const player = new FakePlayer();
  const highlights = [];
  const statuses = [];
  const session = new Session({
    fetch: overrides.fetch || ((url, options) => fetch(url, options)),
    config: {
      server: SERVER, password: "", voice: "am_michael", speed: 1, stripCode: true,
      ...(overrides.config || {}),
    },
    player,
    onHighlight: (spot) => highlights.push(spot),
    onStatus: (text) => statuses.push(text),
  });
  return { session, player, highlights, statuses };
}

/** Wait until `check` is true, or give up. */
async function until(check, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("refuses text with nothing speakable in it", async () => {
  const { session, statuses } = build();
  const ok = await session.start("{\n}\n;\n", 0);
  assert.strictEqual(ok, false);
  assert.match(statuses.join(" "), /Nothing to read/);
  session.stop();
});

test("reports a server it cannot reach, rather than hanging", async () => {
  const { session, statuses } = build({ config: { server: "http://127.0.0.1:9" } });
  const ok = await session.start("Hello there friend.", 0);
  assert.strictEqual(ok, false);
  assert.match(statuses.join(" "), /Cannot reach/);
  session.stop();
});

test("reports a refusal from the server", async () => {
  const { session, statuses } = build({ config: { voice: "not_a_voice" } });
  const ok = await session.start("Hello there friend.", 0);
  assert.strictEqual(ok, false);
  assert.ok(statuses.join(" ").length > 0, "should say something");
  session.stop();
});

test("reads a file, starts before every part is written, and highlights words",
  { timeout: 120000 }, async () => {
  const source = [
    "// The keeper had not spoken to anyone in three weeks.",
    "function lighthouse() {",
    "  // Every morning he climbed the ninety-two steps.",
    "  return true;",
    "}",
    "// On the fourth Tuesday a boat appeared where none should have been.",
  ].join("\n");

  const { session, player, highlights, statuses } = build();
  const ok = await session.start(source, 0);
  assert.strictEqual(ok, true, "should have started");

  // It must begin playing as soon as the first part exists, not at the end.
  const began = await until(() => player.last("load") !== null);
  assert.ok(began, "should have asked the player to load a part");
  assert.ok(session.job.total > 1, "this text should split into parts");
  assert.ok(session.ready < session.job.total || session.job.total === 1,
    "should not have waited for every part");

  const first = player.last("load");
  assert.match(first.url, /\/chunk\/[a-f0-9]+\/0\.wav$/, "should load part 0 first");
  assert.strictEqual(first.rate, 1);

  // Wait for the word timings, then drive playback by hand.
  const timed = await until(() => (session.spans.get(0) || []).length > 0);
  assert.ok(timed, "should have loaded word timings for part 0");

  const spans = session.spans.get(0);
  session.time(spans[0].s + 0.001);
  session.time(spans[1].s + 0.001);

  assert.ok(highlights.length >= 2, "should have highlighted at least two words");
  for (const spot of highlights) {
    assert.ok(spot.line >= 0 && spot.line < 6, `line ${spot.line} should be in the file`);
    assert.ok(spot.end > spot.start, "a highlight should cover something");
  }

  // The comment marker was stripped, so offsets are into the trimmed line.
  const firstSpot = highlights[0];
  assert.strictEqual(firstSpot.line, 0, "the first word is on the first line");

  session.stop();
  assert.strictEqual(player.last("stop").type, "stop");
  assert.strictEqual(highlights[highlights.length - 1], null, "stopping clears the highlight");
});

test("moves to the next part when one ends, and stops after the last",
  { timeout: 120000 }, async () => {
  const text = [
    "The first paragraph is here and it says something.",
    "",
    "The second paragraph follows on afterwards.",
    "",
    "The third paragraph finishes the whole thing off.",
  ].join("\n");

  const { session, player, highlights } = build({ config: { stripCode: false } });
  await session.start(text, 0);
  await until(() => session.ready >= session.job.total, 120000);
  const total = session.job.total;
  assert.ok(total >= 3, `expected several parts, got ${total}`);

  session.playPart(0);
  for (let i = 0; i < total - 1; i++) {
    const before = session.index;
    session.ended();
    assert.strictEqual(session.index, before + 1, "should advance one part");
  }
  // Ending the last part finishes rather than running off the end.
  session.ended();
  assert.strictEqual(session.index, total - 1, "should stay on the last part");
  assert.strictEqual(highlights[highlights.length - 1], null, "should clear the highlight");
  session.stop();
});

test("skipping past the ends does not break", { timeout: 120000 }, async () => {
  const { session } = build({ config: { stripCode: false } });
  await session.start("One two three.\n\nFour five six.\n\nSeven eight nine.", 0);
  await until(() => session.ready >= session.job.total, 120000);

  session.playPart(0);
  session.prev();
  assert.strictEqual(session.index, 0, "back from the first part stays put");

  session.playPart(session.job.total - 1);
  session.next();
  assert.strictEqual(session.index, session.job.total - 1, "forward from the last stays put");
  session.stop();
});

test("waits when asked for a part the server has not written yet",
  { timeout: 120000 }, async () => {
  const { session, player } = build({ config: { stripCode: false } });
  await session.start("Alpha one.\n\nBeta two.\n\nGamma three.\n\nDelta four.", 0);

  // Pretend nothing is ready, then ask for a later part.
  session.ready = 1;
  const loadsBefore = player.count("load");
  session.playPart(3);
  assert.strictEqual(session.waiting, true, "should be waiting");
  assert.strictEqual(player.count("load"), loadsBefore, "should not load an unwritten part");

  // When the server catches up, it starts on its own.
  session.progress({ done: 4, total: 4, state: "ready", error: "" });
  assert.strictEqual(session.waiting, false, "should stop waiting");
  assert.ok(player.count("load") > loadsBefore, "should load once it is ready");
  session.stop();
});

test("changing speed tells the player and remembers the choice", async () => {
  const { session, player } = build();
  session.job = { id: "x", total: 1 };
  session.rate(1.5);
  assert.strictEqual(player.last("rate").rate, 1.5);
  assert.strictEqual(session.config.speed, 1.5);
  // A part loaded afterwards should use the new speed.
  session.ready = 1;
  session.playPart(0);
  assert.strictEqual(player.last("load").rate, 1.5);
  session.stop();
});

test("a server error during rendering is reported, not swallowed", async () => {
  const { session, statuses } = build();
  session.job = { id: "x", total: 2 };
  session.progress({ done: 0, total: 2, state: "error", error: "Ran out of memory." });
  assert.match(statuses.join(" "), /Ran out of memory/);
  assert.strictEqual(session.poll, null, "should stop asking after an error");
  session.stop();
});

test("sends the password when one is set", async () => {
  const seen = [];
  const { session } = build({
    config: { password: "hunter2" },
    fetch: async (url, options) => {
      seen.push(options && options.headers && options.headers.Authorization);
      return { ok: true, json: async () => ({ id: "x", total: 1, texts: ["Hello there."] }) };
    },
  });
  await session.start("Hello there.", 0);
  assert.strictEqual(seen[0], "Basic " + Buffer.from(":hunter2").toString("base64"));
  session.stop();
});

test("survives a part it cannot place in the text", async () => {
  const { session } = build({
    fetch: async (url) => {
      if (url.endsWith("/speak")) {
        return { ok: true, json: async () => ({ id: "x", total: 1, texts: ["nowhere to be found"] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  await session.start("Completely different words here.", 0);
  assert.strictEqual(session.parts[0], null, "the part could not be placed");
  // Asking for its timings must not throw.
  await session.loadWords(0);
  session.time(1);
  session.stop();
});

test("missing word timings still play, just without a highlight", async () => {
  const { session, highlights } = build({
    fetch: async (url) => {
      if (url.endsWith("/speak")) {
        return { ok: true, json: async () => ({ id: "x", total: 1, texts: ["Hello there."] }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    },
  });
  await session.start("Hello there.", 0);
  session.ready = 1;
  session.playPart(0);
  await session.loadWords(0);
  session.time(0.5);
  assert.strictEqual(highlights.length, 0, "no timings means no highlight");
  session.stop();
});

test("playing again after the whole thing finished starts from the beginning",
  { timeout: 120000 }, async () => {
  const { session, player } = build({ config: { stripCode: false } });
  await session.start("Alpha one here.\n\nBeta two here.\n\nGamma three here.", 0);
  await until(() => session.ready >= session.job.total, 120000);

  // Run to the end.
  session.playPart(session.job.total - 1);
  session.setPlaying(true);
  session.ended();
  assert.strictEqual(session.playing, false, "should have stopped at the end");

  // Pressing play now must restart, not replay the final part alone.
  player.sent.length = 0;
  session.toggle();
  const load = player.last("load");
  assert.ok(load, "should load a part rather than resume a finished one");
  assert.match(load.url, /\/0\.wav$/, "should start again from the first part");
  session.stop();
});

test("pausing then playing resumes where it was, without reloading", async () => {
  const { session, player } = build();
  session.job = { id: "x", total: 2 };
  session.ready = 2;
  session.playPart(0);
  session.setPlaying(true);

  player.sent.length = 0;
  session.toggle();
  assert.strictEqual(player.last("pause").type, "pause", "should pause");
  session.setPlaying(false);

  player.sent.length = 0;
  session.toggle();
  assert.ok(player.last("play"), "should resume");
  assert.strictEqual(player.last("load"), null, "resuming must not reload the part");
  session.stop();
});

test("the button label follows playback in both directions", async () => {
  const { session, player } = build();
  session.job = { id: "x", total: 2 };
  session.ready = 2;
  session.playPart(0);

  // Playback actually begins: the panel must be told, so it shows Pause.
  player.sent.length = 0;
  session.setPlaying(true);
  const started = player.last("status");
  assert.ok(started, "starting should refresh the panel");
  assert.strictEqual(started.playing, true, "should show as playing");

  player.sent.length = 0;
  session.setPlaying(false);
  const paused = player.last("status");
  assert.ok(paused, "pausing should refresh the panel");
  assert.strictEqual(paused.playing, false, "should show as paused");
  session.stop();
});

test("progress updates keep flowing while waiting for a click", async () => {
  // The panel makes the click prompt sticky, so the extension is free to keep
  // sending status. This checks it does not stop reporting.
  const { session, player } = build();
  session.job = { id: "x", total: 3 };
  session.ready = 1;
  session.playPart(0);
  session.setPlaying(false);

  player.sent.length = 0;
  session.progress({ done: 2, total: 3, state: "running", error: "" });
  assert.ok(player.last("status"), "should still report progress");
  assert.strictEqual(session.ready, 2);
  session.stop();
});
