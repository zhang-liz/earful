// Every word on screen comes from app/strings/<language>.json. These tests
// keep the languages in step with each other, with the pages, and with the
// server's error codes, and check that a Chinese screen shows no English.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { open } = require("./harness");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const en = JSON.parse(read("strings/en.json"));
const zh = JSON.parse(read("strings/zh.json"));
const pages = ["index.html", "continue.html"].map(read).join("\n");
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

test("both languages have the same words, with the same blanks to fill", () => {
  assert.deepStrictEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.ok(en[key].trim() && zh[key].trim(), `${key} is empty`);
    assert.strictEqual(placeholders(zh[key]), placeholders(en[key]), `${key} has other blanks`);
  }
});

test("every word a page asks for exists, and every word is asked for", () => {
  const used = new Set([
    ...[...pages.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1]),
    ...[...pages.matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]),
    ...[...pages.matchAll(/refusal\([^,]+, "([^"]+)"\)/g)].map((m) => m[1]),
  ]);
  for (const key of used) assert.ok(key in en, `${key} is used but not in strings/en.json`);
  // Error words are picked by the code the server sends.
  const unused = Object.keys(en).filter((key) => !used.has(key) && !key.startsWith("error."));
  assert.deepStrictEqual(unused, [], "words no page uses");
});

test("every error the server can send has words in both languages", () => {
  const server = fs.readFileSync(path.join(root, "..", "app", "server.py"), "utf8");
  const codes = new Set([...server.matchAll(/Refusal\(\s*\d+,\s*"(\w+)"/g)].map((m) => m[1]));
  assert.ok(codes.size >= 5, "found the server's codes");
  for (const code of codes) assert.ok(`error.${code}` in en, `error.${code} is missing`);
});

test("no English is written straight onto the screen", () => {
  for (const file of ["index.html", "continue.html"]) {
    const script = read(file).split("<script>").slice(1).join("\n");
    // Text in quotes, not inside ${...}, set on screen or passed to a message.
    const literal = script.match(/(?:(?:textContent|innerText)\s*=\s*|\b(?:say|fail|problem|keepVoice)\()(["`])(?:(?!\$\{)[^"`])*?[A-Za-z]{2,}/);
    assert.strictEqual(literal && literal[0], null, `${file}: use t() instead`);
  }
});

test("both pages use the same code to show their words", () => {
  const block = (file) => {
    const found = read(file).match(/\/\/ <i18n>[\s\S]*?\/\/ <\/i18n>/);
    assert.ok(found, `${file} should hold the words code between its markers`);
    return found[0];
  };
  assert.strictEqual(block("continue.html"), block("index.html"), "change the <i18n> block in both pages");
});

/** The voices a server that reads Chinese lists. */
const VOICES = {
  default: "af_heart",
  languages: [{ id: "en", name: "English", default: "af_heart" }, { id: "zh", name: "中文", default: "zf_044" }],
  voices: [
    { id: "af_heart", label: "Heart — US female", labels: { en: "Heart — US female", zh: "Heart — 美式女声" }, language: "en", accent: "US" },
    { id: "zf_044", label: "Mandarin female", labels: { en: "Mandarin female", zh: "普通话女声" }, language: "zh" },
    { id: "zm_064", label: "Mandarin male", labels: { en: "Mandarin male", zh: "普通话男声" }, language: "zh" },
  ],
};

/** Words in Latin letters a Chinese screen still shows, other than names. */
function english(window) {
  // The switch to English says so in English, so a lost reader can find it.
  const allowed = /^(EARFUL|Earful|CMD|ENTER|ESC|Wi|Fi|HEART|Heart|English|Language)$/;
  const found = [];
  const walker = window.document.createTreeWalker(window.document.body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement.tagName;
    if (parent === "SCRIPT" || parent === "STYLE" || parent === "TEXTAREA") continue;
    found.push(...(node.data.match(/[A-Za-z]{2,}/g) || []));
  }
  for (const el of window.document.querySelectorAll("[title], [placeholder], [aria-label]")) {
    for (const attr of ["title", "placeholder", "aria-label"]) {
      found.push(...((el.getAttribute(attr) || "").match(/[A-Za-z]{2,}/g) || []));
    }
  }
  found.push(...(window.document.title.match(/[A-Za-z]{2,}/g) || []));
  return found.filter((word) => !allowed.test(word));
}

test("a Chinese screen shows no English, before and during a reading", async () => {
  const page = await open({ saved: { "earful.language": "zh" }, answers: { "/voices": VOICES } });
  assert.strictEqual(page.window.document.documentElement.lang, "zh-CN");
  assert.deepStrictEqual(english(page.window), []);
  await page.read("今天天气很好。\n\n我们去公园。");
  await page.rendered(1, 2);
  assert.match(page.status(), /段|准备/);
  assert.deepStrictEqual(english(page.window), []);
  await page.close();
});

test("the phone page in Chinese shows no English", async () => {
  const page = await open({ page: "continue.html", saved: { "earful.language": "zh" },
    url: "http://127.0.0.1:8888/continue" });
  assert.deepStrictEqual(english(page.window), []);
  await page.close();
});

test("the screen follows a Chinese browser, and the switch changes it and is kept", async () => {
  const page = await open({ answers: { "/voices": VOICES }, language: "zh-CN" });
  assert.strictEqual(page.$("go").textContent, "▶ 读给我听");
  page.$("language").click();
  assert.strictEqual(page.$("go").textContent, "▶ READ IT TO ME");
  assert.strictEqual(page.window.localStorage.getItem("earful.language"), "en");
  assert.strictEqual(page.$("language").textContent, "中文", "the switch names the other language");
  await page.close();
});

test("a server that reads Chinese gets a voice for each language", async () => {
  const page = await open({ answers: { "/voices": VOICES } });
  assert.ok(!page.$("voiceZhRow").classList.contains("hidden"));
  page.$("voiceZh").value = "zm_064";
  page.$("readLang").value = "zh";
  await page.read("今天天气很好。");
  const speak = page.state.requests.find((r) => r.url === "/speak");
  const body = JSON.parse(speak.init.body);
  assert.strictEqual(JSON.stringify(body.voices), JSON.stringify({ en: "af_heart", zh: "zm_064" }));
  assert.strictEqual(body.language, "zh");
  await page.close();
});

test("an older server keeps the one voice list and request", async () => {
  const page = await open();
  assert.ok(page.$("voiceZhRow").classList.contains("hidden"));
  await page.read("Hello there.");
  const body = JSON.parse(page.state.requests.find((r) => r.url === "/speak").init.body);
  assert.strictEqual(body.voices, undefined);
  assert.strictEqual(body.voice, "af_heart");
  await page.close();
});

test("a refusal from the server is shown in Chinese", async () => {
  const page = await open({
    saved: { "earful.language": "zh" },
    fetch: async (url) => ({
      ok: url !== "/speak", status: url === "/speak" ? 400 : 200,
      json: async () => (url === "/speak" ? { detail: "No readable text.", code: "no_text" }
        : url === "/voices" ? VOICES : {}),
    }),
  });
  await page.read("。。。");
  assert.strictEqual(page.$("error").textContent, "这段文字里没有可以朗读的内容。");
  await page.close();
});
