// Chinese pages: no spaces between words, and spoken words that do not always
// match the page's words one to one.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { load } = require("./harness");

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** A server that speaks the given words, one every half second. */
function server(texts, spoken) {
  return async (url) => {
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/speak")) return reply({ id: "j", total: texts.length, texts });
    if (url.includes("/progress")) {
      return reply({ id: "j", state: "ready", done: texts.length, total: texts.length, error: "" });
    }
    if (url.includes("/words/")) {
      const part = Number(url.split("/").pop());
      return reply({ words: spoken[part].map((t, i) => ({ t, s: i * 0.5, e: i * 0.5 + 0.45 })) });
    }
    return reply({});
  };
}

const NEWS = "今天上午，北京市政府召开新闻发布会。";
const NEWS_WORDS = ["今天上午", "，", "北京市政府", "召开", "新闻", "发布会", "。"];

test("the spoken Chinese word is lit in the page", async () => {
  const h = load(`<article><p>${NEWS}</p></article>`, { fetch: server([NEWS], [NEWS_WORDS]) });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  h.state.audio.advance(1.1);              // the third word
  await settle(5);
  assert.strictEqual(h.highlighted(), "北京市政府");
  h.state.audio.advance(2.6);
  await settle(5);
  assert.strictEqual(h.highlighted(), "发布会");
});

test("a number read out in words does not throw the later words off", async () => {
  const text = "2026年11月6日，股价上涨了50%。";
  const spoken = ["二零二", "六年", "十一月", "六日", "，", "股价", "上涨", "了", "百分之五十", "。"];
  const h = load(`<article><p>${text}</p></article>`, { fetch: server([text], [spoken]) });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  h.state.audio.advance(2.6);              // "股价"
  await settle(5);
  assert.strictEqual(h.highlighted(), "股价");
  h.state.audio.advance(3.1);
  await settle(5);
  assert.strictEqual(h.highlighted(), "上涨");
});

test("clicking a Chinese word reads from that word", async () => {
  const texts = ["第一段。", NEWS];
  const h = load(`<article><p>第一段。</p><p>${NEWS}</p></article>`,
    { fetch: server(texts, [["第一段", "。"], NEWS_WORDS]) });
  await h.send({ type: "read-page", settings: {} });
  await settle();
  h.clickPage("p", 1, NEWS.indexOf("召开") + 1);
  await settle();
  assert.match(h.state.audio.src, /\/1\.wav$/);
  h.state.audio.dispatchEvent({ type: "loadedmetadata" });   // as a browser does once loaded
  assert.strictEqual(h.state.audio.currentTime, 1.5, "starts at 召开");
});

test("the web page and the extension place spoken words with the same code", () => {
  const between = (file) => {
    const text = fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8");
    const found = text.match(/\/\/ <placeWords>[\s\S]*?\/\/ <\/placeWords>/);
    assert.ok(found, `${file} should hold placeWords between its markers`);
    return found[0].split("\n").map((line) => line.trim()).join("\n");
  };
  assert.strictEqual(between("extension/content.js"), between("app/index.html"),
    "change placeWords in both files");
});
