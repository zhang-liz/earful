// Comment markers differ by language, and getting one wrong either reads
// punctuation aloud or eats a real word. These check the shapes that actually
// turn up in files people write.

const assert = require("node:assert");
const { test } = require("node:test");
const { prepare } = require("../src/text");

/** What would be spoken, and where each line's words begin in the original. */
function speak(source) {
  const { speech, map } = prepare(source, 0, true);
  return { lines: speech.split("\n\n"), map };
}

test("reads C-family line comments without the slashes", () => {
  const { lines } = speak("// Count the steps.\n/// Doc comment here.");
  assert.deepStrictEqual(lines, ["Count the steps.", "Doc comment here."]);
});

test("reads Python and shell comments without the hashes", () => {
  const { lines } = speak("# Count the steps.\n## Section heading.");
  assert.deepStrictEqual(lines, ["Count the steps.", "Section heading."]);
});

test("reads SQL and Lua comments without the dashes", () => {
  const { lines } = speak("-- Count the steps.");
  assert.deepStrictEqual(lines, ["Count the steps."]);
});

test("reads block comment bodies without the stars", () => {
  const source = ["/**", " * The keeper counts the steps.", " * Every morning.", " */"].join("\n");
  const { lines } = speak(source);
  assert.deepStrictEqual(lines, ["The keeper counts the steps.", "Every morning."]);
});

test("reads HTML comments without the brackets", () => {
  const { lines } = speak("<!-- The keeper counts the steps. -->");
  assert.deepStrictEqual(lines, ["The keeper counts the steps."]);
});

test("does not eat a minus sign that is doing arithmetic", () => {
  const { lines } = speak("total = first - second");
  assert.deepStrictEqual(lines, ["total = first - second"]);
});

test("keeps code that carries real words", () => {
  const { lines } = speak("const keeper = buildLighthouse(steps);");
  assert.deepStrictEqual(lines, ["const keeper = buildLighthouse(steps);"]);
});

test("drops lines that are only brackets or punctuation", () => {
  const source = ["{", "}", "));", "  ;", "()", "..."].join("\n");
  const { lines } = speak(source);
  assert.deepStrictEqual(lines, [""], "nothing should be left to say");
});

test("keeps a line whose only word is inside brackets", () => {
  const { lines } = speak("(keeper)");
  assert.deepStrictEqual(lines, ["(keeper)"]);
});

test("the recorded shift points at the first spoken character", () => {
  const cases = [
    "// Hello there",
    "    // Hello there",
    "\t\t# Hello there",
    " * Hello there",
    "<!-- Hello there -->",
    "        Hello there",
  ];
  for (const line of cases) {
    const { map } = prepare(line, 0, true);
    assert.strictEqual(map.length, 1, `should keep: ${JSON.stringify(line)}`);
    assert.strictEqual(
      line.slice(map[0].shift, map[0].shift + 5),
      "Hello",
      `shift wrong for ${JSON.stringify(line)}`
    );
  }
});

test("a line that is only a comment marker is dropped, not spoken", () => {
  const { lines } = speak("//\n#\n--");
  assert.deepStrictEqual(lines, [""], "empty comments say nothing");
});

test("does not strip anything when reading prose", () => {
  const source = "-- this is a dash, not SQL --\n# and this is a heading";
  const { speech } = prepare(source, 0, false);
  assert.strictEqual(speech, "-- this is a dash, not SQL --\n\n# and this is a heading");
});

test("prose keeps its own shift for indented lines", () => {
  const { map } = prepare("    Indented prose line.", 0, false);
  assert.strictEqual(map[0].shift, 4);
});

test("a file of only code punctuation yields nothing to read", () => {
  const source = ["function f() {", "  return {", "  };", "}"].join("\n");
  const { speech } = prepare(source, 0, true);
  // The two lines carrying words survive; the pure-bracket lines do not.
  assert.ok(!speech.includes("};"), "closing lines should be gone");
  assert.ok(speech.includes("function f"), "the signature should stay");
});

test("blank input is handled rather than crashing", () => {
  const { speech, map } = prepare("", 0, true);
  assert.strictEqual(speech, "");
  assert.deepStrictEqual(map, []);
});

test("windows line endings do not leave stray characters", () => {
  const { speech } = prepare("First line.\r\nSecond line.", 0, false);
  assert.ok(!speech.includes("\r"), "carriage returns should not be spoken");
});
