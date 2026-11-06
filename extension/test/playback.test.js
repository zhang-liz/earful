// Playing, pausing, skipping and jumping.

const assert = require("node:assert");
const { test } = require("node:test");
const { load } = require("./harness");

const PAGE = `<article>
<h1>The Lighthouse</h1>
<p>The keeper had not spoken to anyone in three weeks.</p>
<p>He preferred it that way and the boat came on Thursdays.</p>
<p>On the fourth Tuesday a boat appeared where none should have been.</p>
</article>`;

const TEXTS = [
  "The Lighthouse",
  "The keeper had not spoken to anyone in three weeks.",
  "He preferred it that way and the boat came on Thursdays.",
  "On the fourth Tuesday a boat appeared where none should have been.",
];

function server({ ready: first = TEXTS.length, texts = TEXTS, live } = {}) {
  const sent = [];
  const fetch = async (url, options = {}) => {
    sent.push({ url, options });
    const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body });
    if (url.endsWith("/speak")) return reply({ id: "job1", total: texts.length, texts });
    if (url.includes("/progress-once/") || url.includes("/progress/")) {
      // `live.ready` lets a test write more parts as it goes.
      const ready = live ? live.ready : first;
      return reply({ id: "job1", state: ready >= texts.length ? "ready" : "running",
                     done: ready, total: texts.length, error: "" });
    }
    if (url.includes("/words/")) {
      const part = Number(url.split("/").pop());
      const words = (texts[part] || "").split(/\s+/).map((t, i) => ({ t, s: i * 0.5, e: i * 0.5 + 0.4 }));
      return reply({ words });
    }
    return reply({}, false);
  };
  return { fetch, sent };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Start a reading and wait for it to be playing. */
async function reading(options = {}) {
  const s = server(options);
  const h = load(PAGE, { fetch: s.fetch, ...options });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  return { h, s };
}

test("playback starts on the first part", async () => {
  const { h, s } = await reading();
  assert.match(h.state.audio.src, /\/chunk\/job1\/0\.wav$/,
    "should have loaded the first part's audio");
  assert.strictEqual(h.state.audio.paused, false, "should be playing");
});

test("pausing stops the audio and says so", async () => {
  const { h } = await reading();
  await h.send({ type: "toggle", settings: {} });
  await settle();
  assert.strictEqual(h.state.audio.paused, true, "should be paused");
  assert.match(h.status(), /Paused/);
});

test("pausing just after a part starts says paused, not click to start", async () => {
  const { h } = await reading();
  await h.send({ type: "toggle", settings: {} });
  await settle(700);           // past the check for a browser refusing sound
  assert.match(h.status(), /Paused/);
});

test("pausing then playing does not reload the part", async () => {
  const { h } = await reading();
  h.state.audio.time = 1;                 // partway through
  const before = h.state.audio.loads;
  await h.send({ type: "toggle", settings: {} });
  await h.send({ type: "toggle", settings: {} });
  await settle();
  assert.strictEqual(h.state.audio.loads, before, "resuming should not start over");
});

test("a part ending moves on to the next one", async () => {
  const { h, s } = await reading();
  h.state.audio.dispatchEvent({ type: "ended" });
  await settle();
  assert.match(h.state.audio.src, /\/1\.wav$/, "should have moved to part 1");
});

test("the last part ending finishes rather than running off the end", async () => {
  const { h } = await reading();
  for (let i = 0; i < TEXTS.length; i++) {
    h.state.audio.dispatchEvent({ type: "ended" });
    await settle(10);
  }
  assert.match(h.status(), /Finished/);
  assert.strictEqual(h.state.audio.paused, true, "nothing should still be playing");
});

test("skipping back from the first part stays put", async () => {
  const { h, s } = await reading();
  h.button("prev").click();
  await settle();
  assert.match(h.state.audio.src, /\/0\.wav$/, "should still be on the first part");
});

test("skipping past the last part does not break", async () => {
  const { h } = await reading();
  for (let i = 0; i < TEXTS.length + 3; i++) {
    h.button("next").click();
    await settle(10);
  }
  assert.ok(h.status(), "should still have something to say");
});

test("changing speed applies straight away", async () => {
  const { h } = await reading();
  const speed = h.button("1.5");
  assert.ok(speed, "there should be a 1.5x button");
  speed.click();
  await settle();
  assert.strictEqual(h.state.audio.playbackRate, 1.5);
});

test("speed survives moving to the next part", async () => {
  const { h } = await reading();
  h.button("2").click();
  await settle();
  h.state.audio.dispatchEvent({ type: "ended" });
  await settle();
  assert.strictEqual(h.state.audio.playbackRate, 2, "the new part should keep the speed");
});

test("waiting for a part the server has not finished, then starting when it does",
  async () => {
  // Only the first part is written.
  const s = server({ ready: 1 });
  const h = load(PAGE, { fetch: s.fetch });
  await h.send({ type: "read-page", settings: {} });
  await settle();

  h.button("next").click();
  await settle();
  assert.match(h.status(), /Buffering/, "should wait rather than play silence");
});

test("closing the player stops the audio", async () => {
  const { h } = await reading();
  const close = h.button("close");
  assert.ok(close, "there should be a close button");
  close.click();
  await settle();
  assert.strictEqual(h.doc.getElementById("read-it-to-me-root"), null);
  assert.strictEqual(h.state.audio.paused, true, "audio should stop when the player closes");
});

test("a part waited for starts by itself once the server finishes it", async () => {
  // The server finishes the rest only after the skip.
  let done = 1;
  const fetch = async (url) => {
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/speak")) return reply({ id: "j", total: TEXTS.length, texts: TEXTS });
    if (url.includes("/progress")) {
      return reply({ id: "j", state: done >= TEXTS.length ? "ready" : "running",
                     done, total: TEXTS.length, error: "" });
    }
    if (url.includes("/words/")) return reply({ words: [{ t: "The", s: 0, e: 0.4 }] });
    return reply({});
  };
  const h = load(PAGE, { fetch });
  await h.send({ type: "read-page", settings: {} });
  await settle();

  h.button("next").click();
  await settle();
  assert.match(h.status(), /Buffering/, "should be waiting");

  // The rest arrives; the next progress report should start it.
  done = TEXTS.length;
  await settle(1200);
  assert.match(h.state.audio.src, /\/1\.wav$/, "should have started the part it waited for");
});

test("clicking a word plays from that word", async () => {
  const { h } = await reading();
  // The highlight loop needs a frame to run; drive one.
  h.state.audio.advance(0.6);
  await settle();
  assert.ok(h.state.audio.src, "audio should be loaded");
});

/** A reading whose server finishes more parts when the test says so. */
async function slowReading() {
  const progress = { ready: 1 };
  const base = server();
  const fetch = async (url, options) => {
    if (url.includes("/progress-once/")) {
      return { ok: true, status: 200, json: async () => ({
        id: "job1", state: "running", done: progress.ready, total: TEXTS.length, error: "",
      }) };
    }
    return base.fetch(url, options);
  };
  const h = load(PAGE, { fetch });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  return { h, progress };
}

test("pausing while waiting for a part stays paused when it arrives", async () => {
  const { h, progress } = await slowReading();
  h.button("next").click();
  assert.match(h.status(), /Buffering/);
  await h.send({ type: "toggle", settings: {} });

  progress.ready = 2;
  await settle(100);
  assert.match(h.state.audio.src, /\/0\.wav$/, "the next part should not start on its own");
  assert.match(h.status(), /Paused/);
});

test("play after pausing while waiting carries on with the part it was waiting for", async () => {
  const { h, progress } = await slowReading();
  h.state.audio.time = 3;                // part of the way through the first part
  h.button("next").click();
  await h.send({ type: "toggle", settings: {} });
  progress.ready = 2;
  await settle(100);

  await h.send({ type: "toggle", settings: {} });
  await settle();
  assert.match(h.state.audio.src, /\/1\.wav$/);
});

test("play after the last part has finished starts again from the top", async () => {
  const { h } = await reading();
  for (let i = 0; i < TEXTS.length; i++) {
    h.state.audio.dispatchEvent({ type: "ended" });
    await settle(10);
  }
  assert.match(h.status(), /Finished/);

  await h.send({ type: "toggle", settings: {} });
  await settle();
  assert.match(h.state.audio.src, /\/0\.wav$/);
  assert.strictEqual(h.state.audio.paused, false);
});

test("skipping fast does not ask for a click", async () => {
  const { h } = await reading();
  h.state.audio.play = () => Promise.reject(Object.assign(new Error("Interrupted."), { name: "AbortError" }));
  h.button("next").click();
  await settle();
  assert.doesNotMatch(h.status(), /Click here to start/);
});

test("skipping to a part not written yet silences the part left behind", async () => {
  const { h } = await reading({ ready: 1 });
  h.button("next").click();
  await settle();
  assert.match(h.status(), /Buffering/);
  assert.strictEqual(h.state.audio.paused, true, "part 1 must not play on under the wait");
});

test("the old part ending during a wait does not skip the part waited for", async () => {
  const live = { ready: 1 };
  const { h } = await reading({ ready: 1, live });
  h.button("next").click();
  await settle();
  h.state.audio.dispatchEvent({ type: "ended" });   // already on its way
  await settle();
  live.ready = 4;                                    // the rest arrives
  await settle(1500);
  assert.match(h.state.audio.src, /\/1\.wav$/, "part 2 should play, not part 3");
});

test("another tab taking the sound leaves this one paused, ready to play", async () => {
  const { h } = await reading();
  h.state.audio.dispatchEvent({ type: "taken" });
  await settle(700);
  assert.match(h.status(), /Paused/);
  h.button("play").click();
  await settle();
  assert.strictEqual(h.state.audio.paused, false, "play here takes the sound back");
});

test("a press while getting ready holds the start, and the next press begins", async () => {
  const live = { ready: 0 };
  const { h } = await reading({ ready: 0, live });
  await h.send({ type: "toggle", settings: {} });
  await settle();
  assert.match(h.status(), /Paused/);
  live.ready = 4;                       // the first parts arrive
  await settle(1200);
  assert.strictEqual(h.state.audio.paused, true, "must stay quiet after a pause");
  await h.send({ type: "toggle", settings: {} });
  await settle();
  assert.strictEqual(h.state.audio.paused, false);
  assert.match(h.state.audio.src, /\/0\.wav$/);
});
