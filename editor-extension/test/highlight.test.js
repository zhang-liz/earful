// Checks that the word the server is speaking lines up with the exact
// characters in the original file.
//
// This is the part that can be quietly wrong: the audio sounds right, the
// highlight moves, but it points at the wrong word. So here the whole path is
// walked with the real server, and every highlight is compared against the
// spoken word it claims to be.

const assert = require("node:assert");
const { test } = require("node:test");
const { Session } = require("../src/session");
const { clean } = require("../src/text");

const SERVER = process.env.TTS_SERVER || "http://127.0.0.1:8888";

class FakePlayer {
  constructor() { this.sent = []; }
  post(message) { this.sent.push(message); }
  last(type) {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].type === type) return this.sent[i];
    }
    return null;
  }
}

async function until(check, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Read `source`, then step through every word of every part and check that
 * the highlight points at that same word in the original file.
 *
 * This repeats what the extension does when it paints: take the line and cut
 * out the highlighted characters.
 */
async function checkEveryWord(source, options = {}) {
  const lines = source.split("\n");
  const player = new FakePlayer();
  const spots = [];
  const session = new Session({
    fetch: (url, o) => fetch(url, o),
    config: {
      server: SERVER, password: "", voice: "am_michael", speed: 1,
      stripCode: options.stripCode !== false,
    },
    player,
    onHighlight: (spot) => spots.push(spot),
    onStatus: () => {},
  });

  const ok = await session.start(source, 0);
  assert.ok(ok, "reading should start");
  await until(() => session.ready >= session.job.total, 120000);
  assert.strictEqual(session.ready, session.job.total, "server should finish");

  const checked = [];
  for (let part = 0; part < session.job.total; part++) {
    await session.loadWords(part);
    const spans = session.spans.get(part);
    if (!spans) continue;

    session.index = part;
    for (const span of spans) {
      session.lit = -1;                     // force a fresh highlight
      spots.length = 0;
      session.time((span.s + span.e) / 2);
      if (!spots.length || !spots[0]) continue;

      const spot = spots[0];
      const text = lines[spot.line];
      assert.ok(text !== undefined, `line ${spot.line} should exist in the file`);

      // Offsets are already into the original line.
      const cut = text.slice(spot.start, spot.end);
      const spoken = session.speech.slice(span.start, span.end);
      checked.push({ cut, spoken, line: spot.line });
    }
  }
  session.stop();
  return checked;
}

test("every highlight lands on the word being spoken, in prose",
  { timeout: 180000 }, async () => {
  const source = [
    "The keeper had not spoken to anyone in three weeks.",
    "",
    "He preferred it that way, and the supply boat came only on Thursdays.",
    "",
    "Every morning he climbed the ninety-two steps and wiped the salt away.",
  ].join("\n");

  const checked = await checkEveryWord(source, { stripCode: false });
  assert.ok(checked.length >= 25, `expected many words, got ${checked.length}`);
  for (const { cut, spoken, line } of checked) {
    assert.strictEqual(clean(cut), clean(spoken),
      `line ${line}: highlighted "${cut}" but was speaking "${spoken}"`);
  }
});

test("every highlight lands on the word being spoken, in source code",
  { timeout: 180000 }, async () => {
  const source = [
    "// The lighthouse keeper counts the steps each morning.",
    "function climb(steps) {",
    "  // Ninety-two of them, and he has never missed one.",
    "  return steps.map((step) => step + 1);",
    "}",
    "",
    "// On the fourth Tuesday a boat appeared where none should have been.",
    "const boat = { small: true, low: true };",
  ].join("\n");

  const checked = await checkEveryWord(source);
  assert.ok(checked.length >= 20, `expected many words, got ${checked.length}`);
  for (const { cut, spoken, line } of checked) {
    assert.strictEqual(clean(cut), clean(spoken),
      `line ${line}: highlighted "${cut}" but was speaking "${spoken}"`);
  }
});

test("highlights stay correct on deeply indented lines",
  { timeout: 180000 }, async () => {
  const source = [
    "class Tower {",
    "        // The keeper climbed the stairs every single morning.",
    "                // He wiped the salt from the glass with a cloth.",
    "}",
  ].join("\n");

  const checked = await checkEveryWord(source);
  assert.ok(checked.length >= 10, `expected words, got ${checked.length}`);
  for (const { cut, spoken, line } of checked) {
    assert.strictEqual(clean(cut), clean(spoken),
      `line ${line}: highlighted "${cut}" but was speaking "${spoken}"`);
  }
});

test("highlights land correctly when reading a selection from mid-file",
  { timeout: 180000 }, async () => {
  // The selection starts on line 10, so every highlight must be offset.
  const selection = [
    "The keeper had not spoken to anyone.",
    "",
    "He preferred it that way entirely.",
  ].join("\n");

  const player = new FakePlayer();
  const spots = [];
  const session = new Session({
    fetch: (url, o) => fetch(url, o),
    config: { server: SERVER, password: "", voice: "am_michael", speed: 1, stripCode: false },
    player,
    onHighlight: (spot) => spots.push(spot),
    onStatus: () => {},
  });

  await session.start(selection, 10);
  await until(() => session.ready >= session.job.total, 120000);

  const lines = selection.split("\n");
  for (let part = 0; part < session.job.total; part++) {
    await session.loadWords(part);
    const spans = session.spans.get(part) || [];
    session.index = part;
    for (const span of spans) {
      session.lit = -1;
      spots.length = 0;
      session.time((span.s + span.e) / 2);
      if (!spots.length || !spots[0]) continue;
      const spot = spots[0];
      assert.ok(spot.line >= 10, `line ${spot.line} should be at or after the selection start`);
      const text = lines[spot.line - 10];
      const cut = text.slice(spot.start, spot.end);
      const spoken = session.speech.slice(span.start, span.end);
      assert.strictEqual(clean(cut), clean(spoken),
        `line ${spot.line}: highlighted "${cut}" but was speaking "${spoken}"`);
    }
  }
  session.stop();
});

test("every highlight lands on the right word in markdown",
  { timeout: 180000 }, async () => {
  const source = [
    "# The Lighthouse",
    "",
    "The keeper had **not** spoken to anyone in three weeks.",
    "",
    "- He climbed the ninety-two steps each morning",
    "- He wiped the salt from the glass",
    "",
    "> A boat appeared where none should have been.",
    "",
    "See [the record](https://example.com/log) for what happened next.",
  ].join("\n");

  const lines = source.split("\n");
  const player = new FakePlayer();
  const spots = [];
  const session = new Session({
    fetch: (url, o) => fetch(url, o),
    config: { server: SERVER, password: "", voice: "am_michael", speed: 1, kind: "markdown" },
    player,
    onHighlight: (spot) => spots.push(spot),
    onStatus: () => {},
  });

  const ok = await session.start(source, 0);
  assert.ok(ok, "markdown should be read");
  await until(() => session.ready >= session.job.total, 120000);

  // None of the marks should have been spoken.
  assert.ok(!/[#*>]/.test(session.speech), `marks were left in: ${session.speech}`);
  assert.ok(!session.speech.includes("example.com"), "a link address should not be read");

  let checked = 0;
  for (let part = 0; part < session.job.total; part++) {
    await session.loadWords(part);
    const spans = session.spans.get(part) || [];
    session.index = part;
    for (const span of spans) {
      session.lit = -1;
      spots.length = 0;
      session.time((span.s + span.e) / 2);
      if (!spots.length || !spots[0]) continue;

      const spot = spots[0];
      const raw = lines[spot.line];
      assert.ok(raw !== undefined, `line ${spot.line} should exist`);
      const cut = raw.slice(spot.start, spot.end);
      const spoken = session.speech.slice(span.start, span.end);
      assert.strictEqual(clean(cut), clean(spoken),
        `line ${spot.line}: highlighted "${cut}" but was speaking "${spoken}"`);
      checked++;
    }
  }
  assert.ok(checked >= 25, `expected many words, checked ${checked}`);
  session.stop();
});

test("jumping in markdown lands on the word under the cursor",
  { timeout: 180000 }, async () => {
  const source = [
    "# Chapter One",
    "",
    "The keeper had not spoken to anyone.",
    "",
    "- He climbed the ninety-two steps every single morning",
  ].join("\n");

  const player = new FakePlayer();
  const session = new Session({
    fetch: (url, o) => fetch(url, o),
    config: { server: SERVER, password: "", voice: "am_michael", speed: 1, kind: "markdown" },
    player,
    onHighlight: () => {},
    onStatus: () => {},
  });
  await session.start(source, 0);
  await until(() => session.ready >= session.job.total, 120000);

  // Put the cursor on "ninety-two", which sits after a stripped bullet.
  const line = 4;
  const character = source.split("\n")[line].indexOf("ninety-two");
  player.sent.length = 0;
  const jumped = await session.jumpTo(line, character);
  assert.strictEqual(jumped, true, "should jump from a bullet line");

  // It should start at or after that word, not back at the top of the part.
  const load = player.last("load");
  assert.ok(load, "should load a part");
  const entry = session.map.find((m) => m.line === line);
  const part = session.parts[session.index];
  assert.ok(part && part.start <= entry.start, "the part should cover that line");
  session.stop();
});
