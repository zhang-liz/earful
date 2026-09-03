// Tests for the text preparation and word alignment, which is where the
// highlight can silently drift out of step with the audio.

const assert = require("node:assert");
const { test } = require("node:test");
const { prepare, lineFor, alignWords, locateParts, clean } = require("../src/text");

test("prepare keeps prose as-is when not stripping code", () => {
  const { speech, map } = prepare("Hello there.\nSecond line.", 0, false);
  // Lines are separated by a blank line, which is how the server splits parts.
  assert.strictEqual(speech, "Hello there.\n\nSecond line.");
  assert.deepStrictEqual(map.map((m) => m.line), [0, 1]);
});

test("prepare drops lines that are only syntax", () => {
  const source = ["function go() {", "  return 1;", "}", ""].join("\n");
  const { speech } = prepare(source, 0, true);
  assert.ok(!speech.includes("}"), "closing brace line should be dropped");
  assert.ok(speech.includes("function go"), "real code should stay");
});

test("prepare strips comment markers but keeps the words", () => {
  const source = ["// This explains the thing.", "# Python style.", "-- SQL style."].join("\n");
  const { speech } = prepare(source, 0, true);
  assert.strictEqual(speech, "This explains the thing.\n\nPython style.\n\nSQL style.");
});

test("prepare strips block comment openers and closers", () => {
  const { speech } = prepare("/* Opening note */", 0, true);
  assert.strictEqual(speech, "Opening note");
});

test("prepare keeps the real editor line numbers", () => {
  //                       line 5      line 6 (blank)  line 7
  const source = ["First.", "", "Third."].join("\n");
  const { map } = prepare(source, 5, true);
  assert.deepStrictEqual(map.map((m) => m.line), [5, 7]);
});

test("lineFor finds the line an offset belongs to", () => {
  const { speech, map } = prepare("Alpha.\nBeta.", 0, false);
  assert.strictEqual(lineFor(map, 0).line, 0);
  assert.strictEqual(lineFor(map, speech.indexOf("Beta")).line, 1);
});

test("lineFor returns null before the first entry", () => {
  assert.strictEqual(lineFor([], 3), null);
});

test("alignWords maps plain words onto their offsets", () => {
  const text = "The keeper had not spoken.";
  const words = [
    { t: "The", s: 0, e: 0.2 },
    { t: "keeper", s: 0.2, e: 0.5 },
    { t: "had", s: 0.5, e: 0.7 },
    { t: "not", s: 0.7, e: 0.9 },
    { t: "spoken", s: 0.9, e: 1.3 },
  ];
  const spans = alignWords(0, text, words);
  assert.strictEqual(spans.length, 5);
  assert.deepStrictEqual(
    spans.map((s) => text.slice(s.start, s.end)),
    ["The", "keeper", "had", "not", "spoken"]
  );
});

test("alignWords drops punctuation tokens rather than misplacing them", () => {
  const text = "Stop. Go.";
  const words = [
    { t: "Stop", s: 0, e: 0.3 },
    { t: ".", s: 0.3, e: 0.31 },
    { t: "Go", s: 0.4, e: 0.6 },
    { t: ".", s: 0.6, e: 0.61 },
  ];
  const spans = alignWords(0, text, words);
  assert.strictEqual(spans.length, 2, "only the two real words are pointable");
  assert.deepStrictEqual(spans.map((s) => text.slice(s.start, s.end)), ["Stop", "Go"]);
});

test("alignWords keeps hyphenated and apostrophe words whole", () => {
  const text = "He hadn't climbed the ninety-two steps.";
  const words = [
    { t: "He", s: 0, e: 0.1 },
    { t: "hadn't", s: 0.1, e: 0.4 },
    { t: "climbed", s: 0.4, e: 0.7 },
    { t: "the", s: 0.7, e: 0.8 },
    { t: "ninety-two", s: 0.8, e: 1.2 },
    { t: "steps", s: 1.2, e: 1.5 },
  ];
  const spans = alignWords(0, text, words);
  assert.deepStrictEqual(
    spans.map((s) => text.slice(s.start, s.end)),
    ["He", "hadn't", "climbed", "the", "ninety-two", "steps"]
  );
});

test("alignWords never goes backwards on a repeated word", () => {
  const text = "the cat and the dog";
  const words = [
    { t: "the", s: 0, e: 0.1 },
    { t: "cat", s: 0.1, e: 0.3 },
    { t: "and", s: 0.3, e: 0.4 },
    { t: "the", s: 0.4, e: 0.5 },
    { t: "dog", s: 0.5, e: 0.7 },
  ];
  const spans = alignWords(0, text, words);
  assert.deepStrictEqual(
    spans.map((s) => text.slice(s.start, s.end)),
    ["the", "cat", "and", "the", "dog"]
  );
  // The second "the" must be the later one, not the first one again.
  assert.strictEqual(spans[3].start, text.lastIndexOf("the"));
});

test("alignWords applies the part offset", () => {
  const spans = alignWords(100, "Hello world", [
    { t: "Hello", s: 0, e: 0.3 },
    { t: "world", s: 0.3, e: 0.6 },
  ]);
  assert.strictEqual(spans[0].start, 100);
  assert.strictEqual(spans[1].start, 106);
});

test("alignWords accepts the server's start/end field names too", () => {
  const spans = alignWords(0, "Hello", [{ text: "Hello", start: 1, end: 2 }]);
  assert.deepStrictEqual(spans, [{ start: 0, end: 5, s: 1, e: 2 }]);
});

test("alignWords skips a word that is not in the text", () => {
  const spans = alignWords(0, "alpha gamma", [
    { t: "alpha", s: 0, e: 0.2 },
    { t: "beta", s: 0.2, e: 0.4 },
    { t: "gamma", s: 0.4, e: 0.6 },
  ]);
  assert.deepStrictEqual(spans.map((s) => "alpha gamma".slice(s.start, s.end)), ["alpha", "gamma"]);
});

test("locateParts finds each part in order", () => {
  const speech = "First part here.\nSecond part here.\nThird part here.";
  const found = locateParts(speech, ["First part here.", "Second part here.", "Third part here."]);
  assert.strictEqual(found.length, 3);
  assert.strictEqual(found[0].start, 0);
  assert.strictEqual(speech.slice(found[1].start, found[1].start + 6), "Second");
  assert.strictEqual(speech.slice(found[2].start, found[2].start + 5), "Third");
});

test("locateParts tolerates reflowed whitespace", () => {
  const speech = "Hello   there\nfriend.";
  const found = locateParts(speech, ["Hello there friend."]);
  assert.strictEqual(found[0].start, 0);
});

test("locateParts distinguishes repeated identical parts", () => {
  const speech = "Same text.\nSame text.";
  const found = locateParts(speech, ["Same text.", "Same text."]);
  assert.notStrictEqual(found[0].start, found[1].start);
  assert.ok(found[1].start > found[0].start);
});

test("locateParts reports a part it cannot place", () => {
  const found = locateParts("Only this.", ["Only this.", "Not present at all."]);
  assert.ok(found[0]);
  assert.strictEqual(found[1], null);
});

test("clean keeps digits, which appear in real prose", () => {
  assert.strictEqual(clean("Chapter 12!"), "chapter12");
});
