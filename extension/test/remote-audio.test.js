// The stand-in for an Audio element that plays in the extension's hidden page.

const assert = require("node:assert");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Load remote-audio.js with a fake port to the background worker. */
function load() {
  const state = { sent: [], onMessage: null, onDisconnect: null, now: 0 };
  const port = {
    postMessage: (m) => state.sent.push(m),
    onMessage: { addListener: (fn) => { state.onMessage = fn; } },
    onDisconnect: { addListener: (fn) => { state.onDisconnect = fn; } },
  };
  const context = {
    chrome: { runtime: { connect: () => port } },
    performance: { now: () => state.now },
    Error, Promise, Number, Map, Boolean,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "remote-audio.js"), "utf8"), context);
  const audio = new context.EarfulAudio();
  /** The hidden page reports an event, with the audio's state. */
  const report = (event, fields = {}) => state.onMessage({
    type: "audio-event", event, gen: audio.gen, currentTime: 0, duration: 10,
    paused: false, ended: false, readyState: 4, ...fields,
  });
  return { audio, state, report };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test("calls travel to the hidden page in order", () => {
  const { audio, state } = load();
  audio.src = "http://127.0.0.1:8888/chunk/j/0.wav";
  audio.playbackRate = 1.5;
  audio.play();
  assert.deepStrictEqual(state.sent.map((m) => m.op), ["src", "rate", "play"]);
  assert.strictEqual(state.sent[2].src, "http://127.0.0.1:8888/chunk/j/0.wav",
    "play carries the source, for a hidden page Chrome has reopened");
  assert.strictEqual(audio.getAttribute("src"), "http://127.0.0.1:8888/chunk/j/0.wav");
});

test("play settles with the hidden page's answer", async () => {
  const { audio, state } = load();
  audio.src = "a.wav";
  const ok = audio.play();
  state.onMessage({ reply: state.sent.at(-1).call });
  await ok;

  const refused = audio.play();
  state.onMessage({ reply: state.sent.at(-1).call, error: "NotAllowedError" });
  await assert.rejects(refused, { name: "NotAllowedError" });
});

test("a new source cancels a waiting play, as a real element does", async () => {
  const { audio } = load();
  audio.src = "a.wav";
  const first = audio.play();
  audio.src = "b.wav";
  await assert.rejects(first, { name: "AbortError" });
});

test("events pass on, with the state they report", () => {
  const { audio, report } = load();
  audio.src = "a.wav";
  let heard = 0;
  audio.addEventListener("ended", () => heard++);
  report("ended", { ended: true, paused: true, currentTime: 10 });
  assert.strictEqual(heard, 1);
  assert.strictEqual(audio.ended, true);
  assert.strictEqual(audio.currentTime, 10);
});

test("news about audio since replaced is ignored", () => {
  const { audio, state } = load();
  audio.src = "a.wav";
  const oldGen = audio.gen;
  audio.src = "b.wav";
  let heard = 0;
  audio.addEventListener("ended", () => heard++);
  state.onMessage({ type: "audio-event", event: "ended", gen: oldGen, ended: true, paused: true });
  assert.strictEqual(heard, 0, "the old part ending must not skip the new one");
});

test("the time moves on between reports while playing, and stops on pause", () => {
  const { audio, state, report } = load();
  audio.src = "a.wav";
  audio.playbackRate = 2;
  state.now = 1000;
  report("timeupdate", { currentTime: 3 });
  state.now = 1500;
  assert.strictEqual(audio.currentTime, 4, "half a second at 2x is one second of audio");
  audio.pause();
  state.now = 5000;
  assert.strictEqual(audio.currentTime, 4);
});

test("once listeners run once", () => {
  const { audio, report } = load();
  audio.src = "a.wav";
  let heard = 0;
  audio.addEventListener("loadedmetadata", () => heard++, { once: true });
  report("loadedmetadata");
  report("loadedmetadata");
  assert.strictEqual(heard, 1);
});

test("losing the worker fails a waiting play so the player can say so", async () => {
  const { audio, state } = load();
  audio.src = "a.wav";
  const waiting = audio.play();
  state.onDisconnect();
  await assert.rejects(waiting, (error) => error.name !== "AbortError");
  await settle();
});
