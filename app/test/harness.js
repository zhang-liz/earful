// Runs the real page in jsdom, with the browser's audio and the server faked.
//
// The script inside index.html is unmodified, so the decisions being tested
// are the real ones. The test drives time: it says when a part has been
// rendered and when audio has finished.

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const page = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open the page.
 *
 * @param {object} options
 * @param {string}   [options.page]   which page, if not index.html
 * @param {Function} [options.fetch]  replaces the fake server's answers
 * @param {object}   [options.saved]  localStorage to start with
 * @param {object}   [options.answers]  what a GET of a url answers, by url
 * @param {object}   [options.progress]  what /progress-once answers
 */
async function open(options = {}) {
  const state = {
    audio: null,
    stream: null,
    requests: [],
    plays: [],
    voiceAnswer: { changed: true, voice: "af_bella", total: 1 },
    voiceStatus: 200,
    progress: null,
    answers: options.answers || {},   // url -> what a GET of it answers
  };

  const reply = (body, status = 200) => ({
    ok: status < 400,
    status,
    statusText: String(status),
    json: async () => body,
  });

  const server = async (url, init = {}) => {
    state.requests.push({ url, init });
    const body = init.body ? JSON.parse(init.body) : null;
    if (url in state.answers && (init.method || "GET") === "GET") return reply(state.answers[url]);
    if (url === "/voices") {
      return reply({
        default: "af_heart",
        voices: [
          { id: "af_heart", label: "Heart", accent: "US" },
          { id: "af_bella", label: "Bella", accent: "US" },
          { id: "bm_george", label: "George", accent: "UK" },
        ],
      });
    }
    if (url === "/phone") return reply({ url: "", reachable: false });
    if (url === "/speak") {
      const texts = body.text.split(/\n\s*\n/);
      return reply({ id: "job1", state: "running", done: 0, total: texts.length, texts,
        voice: body.voice });
    }
    if (url.startsWith("/progress-once/")) {
      return reply(state.progress || { state: "ready", done: 1, total: 1, texts: ["Saved."] });
    }
    if (url.startsWith("/voice/")) return reply(state.voiceAnswer, state.voiceStatus);
    if (url.startsWith("/words/")) return reply({ words: [] });
    if (url === "/handoff") return reply({});
    return reply({ detail: "not found" }, 404);
  };

  if (options.progress) state.progress = options.progress;

  const dom = new JSDOM(page(options.page || "index.html"), {
    url: "http://127.0.0.1:8888/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      class FakeAudio extends window.EventTarget {
        constructor() {
          super();
          this.attrs = {};
          this.paused = true;
          this.ended = false;
          this.currentTime = 0;
          this.readyState = 0;
          this.playbackRate = 1;
          state.audio = this;
        }
        get src() { return this.attrs.src || ""; }
        set src(value) {
          this.interrupt();
          this.attrs.src = value;
          this.currentTime = 0;
          this.ended = false;
        }
        getAttribute(name) { return this.attrs[name] ?? null; }
        removeAttribute(name) { delete this.attrs[name]; }
        load() { this.interrupt(); this.currentTime = 0; this.ended = false; }
        play() {
          state.plays.push(this.attrs.src);
          this.paused = false;
          this.readyState = 4;
          // As in a browser, the promise settles once the audio has started,
          // and a new load or a pause before then rejects it.
          return new Promise((resolve, reject) => {
            const starting = { reject };
            this.starting = starting;
            realTimeout(() => {
              if (this.starting === starting) { this.starting = null; resolve(); }
            }, 1);
          });
        }
        pause() { this.interrupt(); this.paused = true; }
        interrupt() {
          if (!this.starting) return;
          this.starting.reject(new window.DOMException("Interrupted.", "AbortError"));
          this.starting = null;
        }
        /** The part has played to its end. */
        finish() {
          this.ended = true;
          this.paused = true;
          this.dispatchEvent(new window.Event("ended"));
        }
      }
      class FakeEventSource {
        constructor(url) { this.url = url; state.stream = this; }
        close() { this.closed = true; }
        /** The connection dropped. */
        fail() { this.onerror(); }
        /** The server reports progress. */
        send(update) { this.onmessage({ data: JSON.stringify(update) }); }
      }
      // Waits are cut short, so a test is not left sitting through a retry.
      const realTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...rest) => realTimeout(fn, Math.min(ms, 5), ...rest);
      window.Audio = FakeAudio;
      window.EventSource = FakeEventSource;
      window.fetch = options.fetch || server;
      window.requestAnimationFrame = () => 1;
      window.cancelAnimationFrame = () => {};
      window.Element.prototype.scrollIntoView = () => {};
      for (const [key, value] of Object.entries(options.saved || {})) {
        window.localStorage.setItem(key, value);
      }
    },
  });
  await tick(20);

  const { window } = dom;
  const $ = (id) => window.document.getElementById(id);
  return {
    window,
    state,
    $,
    /** Read a variable from the page's script. */
    get: (name) => window.eval(name),
    status: () => $("statusLine").textContent,
    /** Start a reading of `text`, as a person pressing the button would. */
    async read(text) {
      $("text").value = text;
      $("go").click();
      await tick(20);
    },
    /** The server has finished `done` parts out of `total`. */
    async rendered(done, total, stateName = "running") {
      state.stream.send({ state: stateName, done, total, error: "" });
      await tick();
    },
    key(target, init) {
      const event = new window.KeyboardEvent("keydown",
        { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    },
    tick,
    /** Let anything still in flight finish, then shut the page. */
    async close() { await tick(20); window.close(); },
  };
}

module.exports = { open, tick };
