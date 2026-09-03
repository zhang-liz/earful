// Awkward files and awkward moments.
//
// The existing tests read tidy prose and tidy code. These are the shapes that
// turn up in real files and the things people do while it is reading.

const assert = require("node:assert");
const { test } = require("node:test");
const { prepare, alignWords, locateParts, lineFor } = require("../src/text");
const { Session } = require("../src/session");

const SERVER = process.env.TTS_SERVER || "http://127.0.0.1:8888";

class FakePlayer {
  constructor() { this.sent = []; }
  post(m) { this.sent.push(m); }
  last(t) { for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].type === t) return this.sent[i]; return null; }
}

function build(config = {}) {
  const player = new FakePlayer();
  const spots = [];
  const statuses = [];
  const session = new Session({
    fetch: (u, o) => fetch(u, o),
    config: { server: SERVER, password: "", voice: "am_michael", speed: 1, kind: "plain", ...config },
    player,
    onHighlight: (s) => spots.push(s),
    onStatus: (t) => statuses.push(t),
  });
  return { session, player, spots, statuses };
}

async function until(check, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
}

test("a file of only blank lines has nothing to read", () => {
  const { speech, map } = prepare("\n\n   \n\t\n", 0, "plain");
  assert.strictEqual(speech, "");
  assert.deepStrictEqual(map, []);
});

test("a single line with no newline at the end is read", () => {
  const { speech, map } = prepare("Just one line.", 0, "plain");
  assert.strictEqual(speech, "Just one line.");
  assert.strictEqual(map.length, 1);
});

test("a very long line is kept whole", () => {
  const long = "word ".repeat(500).trim();
  const { speech, map } = prepare(long, 0, "plain");
  assert.strictEqual(speech, long);
  assert.strictEqual(map[0].shift, 0);
});

test("tabs are handled like any other indentation", () => {
  const { map } = prepare("\t\tIndented with tabs.", 0, "plain");
  assert.strictEqual(map[0].shift, 2, "the words start after the two tabs");
});

test("text with no letters at all is refused rather than sent", () => {
  const { speech } = prepare("!!! ??? ... ;;;", 0, "code");
  assert.strictEqual(speech, "", "punctuation alone is not worth reading");
});

test("accented and non-English words survive", () => {
  const { speech } = prepare("Café naïve résumé.", 0, "plain");
  assert.strictEqual(speech, "Café naïve résumé.");
});

test("alignWords is not confused by an empty part", () => {
  assert.deepStrictEqual(alignWords(0, "", [{ t: "hello", s: 0, e: 1 }]), []);
});

test("alignWords is not confused by no words at all", () => {
  assert.deepStrictEqual(alignWords(0, "some text", []), []);
});

test("locateParts copes with an empty page", () => {
  const found = locateParts("", ["anything"]);
  assert.deepStrictEqual(found, [null]);
});

test("lineFor past the end returns the last line, not nothing", () => {
  const { map } = prepare("One.\n\nTwo.", 0, "plain");
  const entry = lineFor(map, 99999);
  assert.ok(entry, "should give the closest line rather than nothing");
});

test("a jump to a negative line is refused", async () => {
  const { session } = build();
  session.job = { id: "x", total: 1 };
  session.map = [{ line: 0, start: 0, end: 5, shift: 0, columns: [0, 1, 2, 3, 4] }];
  assert.strictEqual(await session.jumpTo(-1, 0), false);
});

test("stopping twice does not throw", () => {
  const { session } = build();
  session.stop();
  session.stop();
});

test("a progress report arriving after stop is ignored", () => {
  const { session } = build();
  session.job = { id: "x", total: 2 };
  session.stop();
  session.progress({ done: 2, total: 2, state: "ready", error: "" });
  assert.strictEqual(session.job, null, "nothing should have been revived");
});

test("time reports before anything is loaded do nothing", () => {
  const { session, spots } = build();
  session.time(1.5);
  assert.strictEqual(spots.length, 0);
});

test("a part with no words at all is skipped without a crash", () => {
  const { session, spots } = build();
  session.job = { id: "x", total: 1 };
  session.spans.set(0, []);
  session.index = 0;
  session.time(1);
  assert.strictEqual(spots.length, 0);
});

test("the same speed set twice does not confuse the player", () => {
  const { session, player } = build();
  session.job = { id: "x", total: 1 };
  session.rate(1.5);
  session.rate(1.5);
  assert.strictEqual(session.config.speed, 1.5);
  assert.strictEqual(player.last("rate").rate, 1.5);
});

test("a server that answers with nonsense is reported, not crashed on", async () => {
  const { session, statuses } = build({
    server: "http://127.0.0.1:8888",
  });
  session.fetch = async () => ({ ok: true, json: async () => { throw new Error("not json"); } });
  let threw = null;
  try { await session.start("Hello there friend.", 0); } catch (e) { threw = e; }
  assert.strictEqual(threw, null, "a bad reply should not throw out of start");
});

test("a job with no parts does not leave it stuck", async () => {
  const { session } = build();
  session.fetch = async (url) => {
    if (url.endsWith("/speak")) return { ok: true, json: async () => ({ id: "x", total: 0, texts: [] }) };
    return { ok: true, json: async () => ({ done: 0, total: 0, state: "ready", error: "" }) };
  };
  await session.start("Hello there friend.", 0);
  session.progress({ done: 0, total: 0, state: "ready", error: "" });
  session.stop();
});

test("reading a real file twice in a row gives the same parts",
  { timeout: 180000 }, async () => {
  const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird one here.";
  const a = build();
  await a.session.start(text, 0);
  await until(() => a.session.ready >= a.session.job.total, 120000);
  const first = a.session.job.texts;
  a.session.stop();

  const b = build();
  await b.session.start(text, 0);
  await until(() => b.session.ready >= b.session.job.total, 120000);
  assert.deepStrictEqual(b.session.job.texts, first, "the same text should split the same way");
  b.session.stop();
});
