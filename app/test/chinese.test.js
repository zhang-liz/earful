// Chinese in the reader: one span per Chinese word, and spoken words timed
// onto spans that do not always split the same way.

const assert = require("node:assert");
const { test } = require("node:test");
const { open } = require("./harness");

const words = (list) => list.map((t, i) => ({ t, s: i, e: i + 0.9 }));

test("a Chinese paragraph becomes one span per word", async () => {
  const page = await open();
  const { document } = page.window;
  const part = document.createElement("div");
  page.window.fillWords(part, "今天上午，北京市政府召开新闻发布会。iPhone 很好");
  const spans = [...part.querySelectorAll(".w")].map((s) => s.textContent);
  assert.ok(spans.length >= 8, `split into words: ${spans.join("|")}`);
  assert.ok(spans.includes("iPhone"));
  assert.strictEqual(part.textContent, "今天上午，北京市政府召开新闻发布会。iPhone 很好", "nothing lost");
  await page.close();
});

test("spoken Chinese words are timed onto the spans, whatever their split", async () => {
  const page = await open();
  const part = page.window.document.createElement("div");
  page.window.fillWords(part, "今天上午，北京市政府召开新闻发布会。");
  const spans = [...part.querySelectorAll(".w")];
  const map = page.window.alignWords(spans,
    words(["今天上午", "，", "北京市政府", "召开", "新闻", "发布会", "。"]));
  const timeOf = (text) => {
    const i = spans.findIndex((s) => s.textContent === text);
    assert.ok(i >= 0, `a span for ${text}: ${spans.map((s) => s.textContent).join("|")}`);
    return map[i];
  };
  assert.strictEqual(timeOf("召开").start, 3);
  assert.strictEqual(timeOf("发布").start, 5);
  assert.strictEqual(timeOf("会").start, 5, "one spoken word over two spans lights both");
  for (let i = 0; i < spans.length; i++) {
    if (/[一-鿿]/.test(spans[i].textContent)) assert.ok(map[i], `${spans[i].textContent} has a time`);
  }
  await page.close();
});

test("a number read out in words does not throw the later words off", async () => {
  const page = await open();
  const part = page.window.document.createElement("div");
  page.window.fillWords(part, "2026年11月6日，股价上涨了50%。");
  const spans = [...part.querySelectorAll(".w")];
  const map = page.window.alignWords(spans,
    words(["二零二", "六年", "十一月", "六日", "，", "股价", "上涨", "了", "百分之五十", "。"]));
  const i = spans.findIndex((s) => s.textContent === "上涨");
  assert.strictEqual(map[i].start, 6);
  await page.close();
});

test("English is still timed word for word", async () => {
  const page = await open();
  const part = page.window.document.createElement("div");
  page.window.fillWords(part, "He hadn't climbed the ninety-two steps.");
  const spans = [...part.querySelectorAll(".w")];
  const map = page.window.alignWords(spans,
    words(["He", "hadn't", "climbed", "the", "ninety", "-", "two", "steps", "."]));
  assert.strictEqual(JSON.stringify(map.map((m) => m && m.start)), "[0,1,2,3,4,7]");
  await page.close();
});
