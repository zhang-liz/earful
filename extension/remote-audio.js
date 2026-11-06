// Plays a reading's audio in the extension's own hidden page, not in the web
// page being read.
//
// A web page's Content-Security-Policy decides where its <audio> may load
// from, and most pages do not list this machine's server, so audio played from
// the page itself is refused. The hidden page belongs to the extension, so a
// website's rules do not reach it.
//
// EarfulAudio stands in for an Audio element. The content script uses it just
// as it would one, and each call travels to the hidden page (offscreen.js).
// What the real element reports comes back as events, with its state, so the
// properties here read like the real ones.

(() => {
  if (globalThis.EarfulAudio) return;     // injected twice; keep the first

  /** An error with a name, as a media element rejects play() with. */
  function named(name) {
    const error = new Error(name);
    error.name = name;
    return error;
  }

  class EarfulAudio {
    constructor() {
      this.listeners = {};
      this.port = null;
      this.calls = new Map();   // play() calls waiting for an answer, by id
      this.nextCall = 1;
      // Bumped whenever the audio is replaced, so news about the old audio,
      // such as an "ended" still on its way, is not taken for the new.
      this.gen = 0;
      this.source = null;
      this.rate = 1;
      this.time = 0;            // currentTime when last heard
      this.heardAt = 0;         // performance.now() at that moment
      this.running = false;     // the real element was last heard playing
      this.duration = NaN;
      this.paused = true;
      this.ended = false;
      this.readyState = 0;
      this.preservesPitch = true;   // the real element always keeps pitch
    }

    connect() {
      if (this.port) return this.port;
      const port = chrome.runtime.connect({ name: "earful-audio" });
      port.onMessage.addListener((message) => this.heard(message));
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.port = null;
        this.running = false;
        // Not an AbortError: the reader ignores those, and would wait forever.
        this.settleCalls(named("EarfulDisconnected"));
      });
      this.port = port;
      return port;
    }

    send(op, extra = {}) {
      try {
        this.connect().postMessage({ op, gen: this.gen, ...extra });
      } catch {
        // The extension was reloaded under this page. Nothing can play now.
        this.port = null;
        this.settleCalls(named("EarfulDisconnected"));
      }
    }

    settleCalls(error) {
      for (const { reject } of this.calls.values()) reject(error);
      this.calls.clear();
    }

    /** New audio: forget everything heard about the old. */
    reset() {
      this.gen++;
      this.time = 0;
      this.heardAt = 0;
      this.running = false;
      this.paused = true;
      this.ended = false;
      this.readyState = 0;
      this.duration = NaN;
      // As a real element does when its source changes.
      this.settleCalls(named("AbortError"));
    }

    get src() { return this.source || ""; }
    set src(value) {
      this.source = String(value);
      this.reset();
      this.send("src", { src: this.source });
    }
    getAttribute(name) { return name === "src" ? this.source : null; }
    removeAttribute(name) {
      if (name !== "src") return;
      this.source = null;
      this.reset();
      this.send("src", { src: null });
    }

    load() {
      this.reset();
      this.send("load");
    }

    play() {
      this.paused = false;
      this.ended = false;
      const call = this.nextCall++;
      return new Promise((resolve, reject) => {
        this.calls.set(call, { resolve, reject });
        // The source and spot go along too: Chrome closes the hidden page
        // after a while with nothing playing, and it has to start over.
        this.send("play", { call, src: this.source, at: this.currentTime, rate: this.rate });
      });
    }

    pause() {
      this.time = this.currentTime;
      this.heardAt = performance.now();
      this.running = false;
      this.paused = true;
      this.send("pause");
    }

    /** Where the audio is now: the last report, moved on by the time since. */
    get currentTime() {
      if (!this.running || this.paused || !this.heardAt) return this.time;
      const moved = ((performance.now() - this.heardAt) / 1000) * this.rate;
      const now = this.time + moved;
      return Number.isFinite(this.duration) ? Math.min(now, this.duration) : now;
    }
    set currentTime(value) {
      this.time = Number(value) || 0;
      this.heardAt = performance.now();
      this.send("seek", { at: this.time });
    }

    get playbackRate() { return this.rate; }
    set playbackRate(value) {
      this.time = this.currentTime;
      this.heardAt = performance.now();
      this.rate = Number(value) || 1;
      this.send("rate", { rate: this.rate });
    }

    /** A message from the hidden page: an answer to play(), or an event. */
    heard(message) {
      if (message.reply) {
        const call = this.calls.get(message.reply);
        if (!call) return;
        this.calls.delete(message.reply);
        if (message.error) call.reject(named(message.error));
        else call.resolve();
        return;
      }
      if (message.gen !== this.gen) return;   // about audio since replaced
      this.time = message.currentTime || 0;
      this.heardAt = performance.now();
      this.duration = message.duration ?? NaN;
      this.paused = message.paused;
      this.ended = message.ended;
      this.readyState = message.readyState;
      this.running = !message.paused && !message.ended;
      this.dispatch(message.event);
    }

    addEventListener(type, fn, options = {}) {
      (this.listeners[type] ||= []).push({ fn, once: Boolean(options.once) });
    }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((l) => l.fn !== fn);
    }
    dispatch(type) {
      for (const listener of [...(this.listeners[type] || [])]) {
        if (listener.once) this.removeEventListener(type, listener.fn);
        listener.fn.call(this, { type, target: this });
      }
    }
  }

  globalThis.EarfulAudio = EarfulAudio;
})();
