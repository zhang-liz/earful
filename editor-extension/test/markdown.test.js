// Markdown is full of marks meant for the eye: hashes, stars, backticks,
// link addresses. Read aloud they are noise, so they are stripped. What must
// not break is the offset back into the original line, which is what the
// highlight uses to find the word.

const assert = require("node:assert");
const { test } = require("node:test");
const { prepare } = require("../src/text");

/** What would be spoken, one entry per kept line. */
function speak(source) {
  return prepare(source, 0, "markdown").speech.split("\n\n");
}

/**
 * Every spoken character must point back at the same character in the file.
 *
 * Marks can be removed from the middle of a line, so this checks each
 * character's recorded column rather than a single offset.
 */
function checkShifts(source) {
  const { speech, map } = prepare(source, 0, "markdown");
  const lines = source.split("\n");
  const parts = speech.split("\n\n");
  map.forEach((entry, i) => {
    const raw = lines[entry.line];
    const spoken = parts[i];
    assert.strictEqual(entry.columns.length, spoken.length,
      `line ${entry.line}: one column per spoken character`);
    for (let c = 0; c < spoken.length; c++) {
      assert.strictEqual(raw[entry.columns[c]], spoken[c],
        `line ${entry.line}: "${spoken[c]}" at column ${entry.columns[c]} ` +
        `is "${raw[entry.columns[c]]}" in "${raw}"`);
    }
  });
}

test("heading hashes are not spoken", () => {
  assert.deepStrictEqual(speak("# The Lighthouse"), ["The Lighthouse"]);
  assert.deepStrictEqual(speak("### A smaller heading"), ["A smaller heading"]);
});

test("a heading closed with hashes loses those too", () => {
  assert.deepStrictEqual(speak("## Middle ##"), ["Middle"]);
});

test("a hash that is not a heading stays", () => {
  assert.deepStrictEqual(speak("Issue #42 was fixed"), ["Issue #42 was fixed"]);
});

test("bullets and numbers are dropped, the words kept", () => {
  const out = speak(["- First point", "* Second point", "+ Third point", "1. Fourth point"].join("\n"));
  assert.deepStrictEqual(out, ["First point", "Second point", "Third point", "Fourth point"]);
});

test("a minus doing arithmetic is not mistaken for a bullet", () => {
  assert.deepStrictEqual(speak("5 - 3 equals two"), ["5 - 3 equals two"]);
});

test("bold and italic marks are removed, the words kept", () => {
  assert.deepStrictEqual(speak("This is **important** and *urgent*"),
    ["This is important and urgent"]);
  assert.deepStrictEqual(speak("Also __bold__ and _italic_ here"),
    ["Also bold and italic here"]);
  assert.deepStrictEqual(speak("And ***both at once***"), ["And both at once"]);
});

test("an underscore inside a word is left alone", () => {
  assert.deepStrictEqual(speak("The value of max_retry_count matters"),
    ["The value of max_retry_count matters"]);
});

test("inline code marks are removed", () => {
  assert.deepStrictEqual(speak("Run `npm install` first"), ["Run npm install first"]);
});

test("struck-through text is still read", () => {
  assert.deepStrictEqual(speak("This was ~~wrong~~ corrected"), ["This was wrong corrected"]);
});

test("a link is read as its words, not its address", () => {
  assert.deepStrictEqual(speak("See [the guide](https://example.com/a/b) for more"),
    ["See the guide for more"]);
});

test("an image is read as its description", () => {
  assert.deepStrictEqual(speak("![a lighthouse at dusk](pic.png)"), ["a lighthouse at dusk"]);
});

test("a reference link is read as its words", () => {
  assert.deepStrictEqual(speak("Read [the notes][1] later"), ["Read the notes later"]);
});

test("block quote markers are dropped", () => {
  assert.deepStrictEqual(speak("> He said it plainly."), ["He said it plainly."]);
  assert.deepStrictEqual(speak(">> Nested quote here."), ["Nested quote here."]);
});

test("horizontal rules say nothing", () => {
  const { speech } = prepare("Above\n\n---\n\n***\n\n___\n\nBelow", 0, "markdown");
  assert.deepStrictEqual(speech.split("\n\n"), ["Above", "Below"]);
});

test("fenced code blocks are skipped entirely", () => {
  const source = [
    "Here is how:",
    "```js",
    "const x = 1;",
    "if (x) { go(); }",
    "```",
    "That is all.",
  ].join("\n");
  assert.deepStrictEqual(speak(source), ["Here is how:", "That is all."]);
});

test("a tilde fence is skipped too", () => {
  const source = ["Before", "~~~", "some code", "~~~", "After"].join("\n");
  assert.deepStrictEqual(speak(source), ["Before", "After"]);
});

test("table rows are read as their cells, the divider skipped", () => {
  const source = [
    "| Name | What it does |",
    "| --- | --- |",
    "| speed | how fast it reads |",
  ].join("\n");
  assert.deepStrictEqual(speak(source),
    ["Name, What it does", "speed, how fast it reads"]);
});

test("the offset still points at the right characters after stripping", () => {
  checkShifts([
    "# The Lighthouse",
    "",
    "The keeper had **not** spoken.",
    "",
    "- He climbed the steps",
    "- He wiped the glass",
    "",
    "> A boat appeared.",
    "",
    "Run `the lamp` at dusk.",
  ].join("\n"));
});

test("the offset is right for a deeply indented bullet", () => {
  checkShifts("      - A point made far in from the margin");
});

test("a markdown file with only marks has nothing to say", () => {
  const { speech } = prepare("# \n\n---\n\n```\ncode\n```", 0, "markdown");
  assert.strictEqual(speech, "");
});

test("plain text is left exactly as written", () => {
  const source = "# not a heading here\n\n- not a bullet either";
  const { speech } = prepare(source, 0, "plain");
  assert.strictEqual(speech, "# not a heading here\n\n- not a bullet either");
});
