// Runs the content script in Node against a small fake DOM.
//
// The script expects a browser: a document it can walk, a shadow root for its
// player, an Audio element, and the CSS Custom Highlight API. None of that
// exists here, so it is all stood up in miniature. What matters is that the
// script itself is unmodified, so the decisions being tested are the real
// ones.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** A text node. */
class TextNode {
  constructor(value) { this.nodeValue = value; this.parentElement = null; }
  get textContent() { return this.nodeValue; }
}

/** An element, with only the parts the script actually uses. */
class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.doc = doc;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.classList = {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) { on ? this.add(c) : this.remove(c); },
    };
    this.listeners = {};
    this.parentElement = null;
    this.shadowRoot = null;
    this.dataset = {};
  }

  get id() { return this.attributes.id; }
  set id(v) { this.attributes.id = v; }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k.startsWith("data-")) this.dataset[k.slice(5)] = String(v);
  }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }

  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === "string") { const t = new TextNode(n); t.parentElement = this; this.children.push(t); }
      else { n.parentElement = this; this.children.push(n); }
    }
  }
  appendChild(n) { this.append(n); return n; }
  remove() {
    const p = this.parentElement;
    if (p) p.children = p.children.filter((c) => c !== this);
    this.parentElement = null;
  }

  attachShadow() {
    this.shadowRoot = new Element("shadow-root", this.doc);
    this.shadowRoot.doc = this.doc;
    this.shadowRoot.host = this;
    return this.shadowRoot;
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  dispatchEvent(event) {
    for (const fn of this.listeners[event.type] || []) fn.call(this, event);
    return true;
  }
  click() { this.dispatchEvent({ type: "click", target: this }); }

  /** The player's controls are built by setting innerHTML, so parse it. */
  set innerHTML(html) {
    this.children = [];
    this._html = html;
    const built = parse(html, this.doc);
    for (const c of built.children.slice()) this.append(c);
  }
  get innerHTML() { return this._html || ""; }

  set textContent(v) { this.children = []; this.append(String(v)); }
  get textContent() {
    return this.children.map((c) => (c instanceof TextNode ? c.nodeValue : c.textContent)).join("");
  }
  get innerText() { return this.textContent; }

  /** Walk this element and everything under it. */
  *walk() {
    yield this;
    for (const c of this.children) {
      if (c instanceof Element) yield* c.walk();
    }
  }

  matches(selector) {
    return selector.split(",").some((part) => {
      part = part.trim();
      if (!part) return false;
      if (part.startsWith("#")) return this.attributes.id === part.slice(1);
      if (part.startsWith("[")) {
        const m = part.match(/^\[([^\]=]+)(?:=([^\]]+))?\]$/);
        if (!m) return false;
        const have = this.attributes[m[1]];
        return m[2] === undefined ? have !== undefined : have === m[2];
      }
      return this.tagName === part.toUpperCase();
    });
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const out = [];
    for (const node of this.walk()) {
      if (node !== this && node.matches(selector)) out.push(node);
    }
    return out;
  }
  getElementById(id) {
    for (const node of this.walk()) if (node.attributes.id === id) return node;
    return null;
  }
  cloneNode() {
    const copy = new Element(this.tagName, this.doc);
    copy.attributes = { ...this.attributes };
    for (const c of this.children) {
      if (c instanceof TextNode) copy.append(c.nodeValue);
      else copy.append(c.cloneNode(true));
    }
    return copy;
  }
  /** Is `other` this element or somewhere inside it? */
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
  getBoundingClientRect() { return { top: 10, bottom: 20, left: 0, right: 100 }; }
  scrollIntoView() { this.scrolled = true; }
}

/** Build a document from a tiny subset of HTML. */
function parse(html, doc) {
  const root = new Element("body", doc);
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [, closing, tag, attrs, selfClose, text] = m;
    if (text !== undefined) {
      if (text.trim() || text.includes(" ")) stack[stack.length - 1].append(text);
      continue;
    }
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const el = new Element(tag, doc);
    for (const a of attrs.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
      el.setAttribute(a[1], a[2] ?? "");
    }
    stack[stack.length - 1].append(el);
    if (!selfClose && !["br", "img", "hr", "input", "meta", "link"].includes(tag)) stack.push(el);
  }
  return root;
}

/** A range over the flat text, good enough for what the script does with it. */
class Range {
  constructor(doc) { this.doc = doc; }
  setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
  setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }

  /**
   * The text the range covers.
   *
   * A word can be split across several text nodes, with more nodes between
   * the first and the last, so every node in document order between the two
   * ends counts.
   */
  toString() {
    if (this.startContainer === this.endContainer) {
      return this.startContainer.nodeValue.slice(this.startOffset, this.endOffset);
    }
    const all = [];
    (function collect(el) {
      for (const c of el.children) {
        if (c.nodeValue !== undefined) all.push(c);
        else collect(c);
      }
    })(this.doc.body);

    const from = all.indexOf(this.startContainer);
    const to = all.indexOf(this.endContainer);
    if (from < 0 || to < 0) return "";

    let out = all[from].nodeValue.slice(this.startOffset);
    for (let i = from + 1; i < to; i++) out += all[i].nodeValue;
    out += all[to].nodeValue.slice(0, this.endOffset);
    return out;
  }
  getBoundingClientRect() { return { top: 10, bottom: 20 }; }
}

/**
 * Load the content script with a fake browser around it.
 *
 * @param {string} html     the page body
 * @param {object} options  { fetch, blocked }
 */
function load(html, options = {}) {
  const doc = {};
  const body = parse(html, doc);
  const head = new Element("head", doc);

  const state = {
    highlights: new Map(),
    frames: [],
    audio: null,
    posted: [],
    selection: null,
  };

  doc.body = body;
  doc.head = head;
  doc.documentElement = body;
  doc.createElement = (tag) => new Element(tag, doc);
  doc.createRange = () => new Range(doc);
  doc.getElementById = (id) => body.getElementById(id);
  doc.querySelector = (s) => body.querySelector(s);
  doc.querySelectorAll = (s) => body.querySelectorAll(s);
  doc.addEventListener = () => {};
  doc.getSelection = () => state.selection;
  doc.visibilityState = "visible";

  // NodeFilter and the tree walker the script uses to index page text.
  const NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  doc.createTreeWalker = (root, _what, filter) => {
    const nodes = [];
    (function collect(el) {
      for (const c of el.children) {
        if (c instanceof TextNode) {
          if (filter.acceptNode(c) === NodeFilter.FILTER_ACCEPT) nodes.push(c);
        } else collect(c);
      }
    })(root);
    let i = -1;
    return { nextNode: () => (++i < nodes.length ? nodes[i] : null) };
  };

  /** The Audio element, with playback the test drives. */
  class FakeAudio extends Element {
    constructor() {
      super("audio", doc);
      this.time = 0;
      this._paused = true;
      this.playbackRate = 1;
      this.silent = !!options.blocked;
      this.loads = 0;
      state.audio = this;
    }
    get readyState() { return this.getAttribute("src") ? 4 : 0; }
    get duration() { return 10; }
    get paused() { return this._paused; }
    get ended() { return false; }
    get currentTime() { return this.time; }
    set currentTime(v) { this.time = v; }
    get src() { return this.getAttribute("src"); }
    set src(v) { this.setAttribute("src", v); this.loads++; this.time = 0; }
    load() { this.loads++; this.time = 0; this.dispatchEvent({ type: "loadedmetadata" }); }
    play() {
      // A blocked browser resolves and stays silent.
      if (this.silent) return Promise.resolve();
      this._paused = false;
      queueMicrotask(() => this.dispatchEvent({ type: "playing" }));
      return Promise.resolve();
    }
    pause() { this._paused = true; }
    /** Move playback on, running the highlight loop as a browser would. */
    advance(to) {
      this.time = to;
      const frames = state.frames.splice(0);
      for (const fn of frames) fn(to * 1000);
    }
  }

  const context = {
    document: doc,
    getSelection: () => state.selection,
    window: null,
    NodeFilter,
    Audio: FakeAudio,
    CSS: { highlights: state.highlights },
    Highlight: class { constructor(range) { this.range = range; this.size = 1; this[Symbol.iterator] = function* () { yield range; }; } },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    requestAnimationFrame: (fn) => { state.frames.push(fn); return state.frames.length; },
    cancelAnimationFrame: (id) => { state.frames = []; },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    fetch: options.fetch || (() => Promise.reject(new Error("no server"))),
    // The script prefers EventSource when no password is set. Deliver the
    // progress the test's server would report, so playback actually starts.
    EventSource: class {
      constructor(url) {
        state.eventSource = this;
        this.url = url;
        // The real stream keeps reporting until the job is done, so this
        // does too. Tests that let the server finish partway through rely
        // on the later reports arriving.
        let left = 60;                 // never poll forever in a test
        const tick = async () => {
          if (this.closed || !this.onmessage || left-- <= 0) return;
          try {
            const reply = await context.fetch(url.replace("/progress/", "/progress-once/"));
            const body = await reply.json();
            this.onmessage({ data: JSON.stringify(body) });
            if (!this.closed && body.state === "running") {
              this.timer = setTimeout(tick, 30);
              if (this.timer.unref) this.timer.unref();
            }
          } catch { if (this.onerror) this.onerror(); }
        };
        const first = setTimeout(tick, 5);
        if (first.unref) first.unref();
      }
      close() { this.closed = true; clearTimeout(this.timer); }
    },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    console,
    chrome: {
      runtime: { onMessage: { addListener(fn) { state.onMessage = fn; } } },
      storage: { sync: { get: async () => ({}), set: async () => {} } },
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);

  const code = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInContext(code, context);

  return { context, state, doc, body,
    /** Send the script a message, as the background worker would. */
    send(message) {
      return new Promise((resolve) => state.onMessage(message, null, resolve));
    },
    /** A control in the player, by its id or its speed. */
    button(name) {
      const host = doc.getElementById("read-it-to-me-root");
      if (!host) return null;
      const all = host.shadowRoot.querySelectorAll("button");
      return all.find((b) => b.getAttribute("id") === name)
        || all.find((b) => b.getAttribute("data-speed") === String(name))
        || null;
    },
    status() {
      const host = doc.getElementById("read-it-to-me-root");
      return host ? host.shadowRoot.getElementById("status").textContent : null;
    },
    highlighted() {
      const h = state.highlights.get("read-it-to-me");
      if (!h) return null;
      for (const r of h) return r.toString();
      return null;
    },
  };
}

module.exports = { load, Element, TextNode };
