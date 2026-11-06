// One reading session: the text, the server job, and where playback is.
//
// This holds no vscode types on purpose, so the whole flow can be tested
// without an editor. The extension supplies the few things it needs:
// somewhere to fetch from, somewhere to show a highlight, and a player.

const { prepare, lineFor, alignWords, locateParts } = require("./text");

/** Which column of the original line a spoken character sits in. */
function column(entry, index) {
  const columns = entry.columns;
  if (!columns || !columns.length) return entry.shift + Math.max(0, index);
  const clamped = Math.max(0, Math.min(index, columns.length - 1));
  return columns[clamped];
}

/** Which spoken character a column of the original line belongs to. */
function spokenIndex(entry, character) {
  const columns = entry.columns;
  if (!columns || !columns.length) return Math.max(0, character - entry.shift);
  for (let i = 0; i < columns.length; i++) {
    if (columns[i] >= character) return i;
  }
  return columns.length - 1;
}

class Session {
  /**
   * @param {object} deps
   * @param {Function} deps.fetch     fetch, or a stand-in
   * @param {object}   deps.config    { server, password, voice, speed, kind }
   * @param {object}   deps.player    { post(message) }
   * @param {Function} deps.onHighlight  called with { line, start, end } or null
   * @param {Function} deps.onStatus     called with a line of text
   */
  constructor(deps) {
    this.fetch = deps.fetch;
    this.config = deps.config;
    this.player = deps.player;
    this.onHighlight = deps.onHighlight;
    this.onStatus = deps.onStatus;

    this.job = null;
    this.speech = "";
    this.map = [];            // spoken offsets back to editor lines
    this.parts = [];          // where each part sits in `speech`
    this.spans = new Map();   // part index -> word spans
    this.ready = 0;
    this.index = 0;
    this.playing = false;
    this.waiting = false;     // playback caught up with the server
    this.stopped = false;
    this.poll = null;
    this.lit = -1;
    this.finished = false;    // played all the way to the end
  }

  headers(extra) {
    const headers = { ...extra };
    if (this.config.password) {
      headers.Authorization = "Basic " + Buffer.from(":" + this.config.password).toString("base64");
    }
    return headers;
  }

  url(path) {
    return this.config.server.replace(/\/+$/, "") + path;
  }

  /** Start reading. `firstLine` is the editor line the text starts on. */
  async start(text, firstLine) {
    // `kind` says how to clean the text. Older callers passed `stripCode`,
    // which meant "this is source code".
    const kind = this.config.kind
      || (this.config.stripCode === false ? "plain" : "code");
    const { speech, map } = prepare(text, firstLine, kind);
    if (!speech.trim()) {
      this.onStatus("Nothing to read there.");
      return false;
    }
    this.speech = speech;
    this.map = map;

    this.onStatus("Getting ready...");
    let response;
    try {
      response = await this.fetch(this.url("/speak"), {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ text: speech, voice: this.config.voice }),
      });
    } catch (error) {
      this.onStatus(`Cannot reach ${this.config.server}. Is the app running?`);
      return false;
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      this.onStatus((detail && detail.detail) || `The server said ${response.status}.`);
      return false;
    }

    // A reply that is not the JSON we expect must be reported, not thrown:
    // the caller relies on false to tidy up and say something.
    try {
      this.job = await response.json();
    } catch {
      this.onStatus("The server sent something unexpected.");
      return false;
    }
    if (!this.job || !this.job.id || !this.job.total) {
      this.onStatus("The server had nothing to read.");
      this.job = null;
      return false;
    }

    this.parts = locateParts(this.speech, this.job.texts || []);
    this.watch();
    return true;
  }

  /** Ask the server how far along it is, until it finishes. */
  watch() {
    if (this.poll) clearInterval(this.poll);
    this.poll = setInterval(async () => {
      if (!this.job || this.stopped) return this.unwatch();
      let update;
      try {
        const response = await this.fetch(this.url(`/progress-once/${this.job.id}`),
          { headers: this.headers() });
        if (!response.ok) return this.unwatch();
        update = await response.json();
      } catch {
        return this.unwatch();
      }
      this.progress(update);
    }, 700);
  }

  unwatch() {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
  }

  progress(update) {
    if (update.error) {
      this.onStatus(update.error);
      this.unwatch();
      return;
    }
    this.ready = update.done;
    if (update.state !== "running") this.unwatch();

    // Start as soon as the first part exists, rather than waiting for all.
    if (!this.playing && !this.stopped && this.index === 0 && this.ready > 0 && !this.startedOnce) {
      this.startedOnce = true;
      this.playPart(0);
    } else if (this.waiting && this.ready > this.index) {
      this.waiting = false;
      this.playPart(this.index);
    }
    this.status();
  }

  status() {
    const total = this.job ? this.job.total : 0;
    let text;
    if (this.waiting) text = `Still writing part ${this.index + 1}...`;
    else if (this.ready < total) text = `Part ${this.index + 1} / ${total} (${this.ready} ready)`;
    else text = `Part ${this.index + 1} / ${total}`;
    this.onStatus(text);
    this.player.post({
      type: "status", text, playing: this.playing, rate: this.config.speed,
    });
  }

  /** Play one part, optionally from a time inside it. */
  playPart(index, at = 0) {
    if (!this.job) return;
    const wanted = Math.max(0, Math.min(index, this.job.total - 1));
    if (wanted >= this.ready) {
      // Not written yet. Hold, and the next progress tick will start it.
      // Silence the part being left: played on, it would end and move past
      // the part being waited for.
      this.player.post({ type: "pause" });
      this.onHighlight(null);
      this.index = wanted;
      this.waiting = true;
      this.status();
      return;
    }
    this.index = wanted;
    this.loaded = wanted;      // the part the player holds
    this.waiting = false;
    this.finished = false;
    this.lit = -1;
    this.player.post({
      type: "load",
      url: this.url(`/chunk/${this.job.id}/${wanted}.wav`),
      rate: this.config.speed,
      at,
    });
    this.loadWords(wanted);
    this.status();
  }

  /** Fetch the word timings for a part, once. */
  async loadWords(index) {
    if (this.spans.has(index)) return;
    const part = this.parts[index];
    if (!part) return;                      // could not be placed in the text
    try {
      const response = await this.fetch(this.url(`/words/${this.job.id}/${index}`),
        { headers: this.headers() });
      if (!response.ok) return;
      const data = await response.json();
      const words = data.words || data;
      this.spans.set(index, alignWords(part.start, part.text, words));
    } catch {
      // No timings means no highlight. The audio still plays.
    }
  }

  /**
   * Tell the server where this reading has got to, so a phone can take over.
   *
   * Sent about once a second: often enough that picking up on another device
   * lands in the right sentence, rare enough not to flood the server. Failure
   * is ignored on purpose, because handing over is a convenience and must
   * never interrupt the reading that is actually happening.
   */
  handOff(now) {
    if (!this.job) return;
    const stamp = Date.now();
    if (this.handedOff && stamp - this.handedOff < 1000) return;
    this.handedOff = stamp;

    this.fetch(this.url("/handoff"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        job: this.job.id,
        index: this.index,
        at: now,
        title: this.config.title || "",
      }),
    }).catch(() => { /* handing over is optional */ });
  }

  /** Called as playback moves. Points the highlight at the spoken word. */
  time(now) {
    // Publish before the highlight work, which gives up early on any part
    // whose word timings have not arrived. Handing over does not need them.
    this.handOff(now);

    const spans = this.spans.get(this.index);
    if (!spans || !spans.length) return;
    let found = -1;
    for (let i = 0; i < spans.length; i++) {
      if (now >= spans[i].s && now < spans[i].e) { found = i; break; }
    }
    if (found === this.lit) return;
    this.lit = found;
    if (found < 0) return;

    const span = spans[found];
    const entry = lineFor(this.map, span.start);
    if (!entry) return;
    // Offsets are into the original line, so the caller does not have to work
    // out what was trimmed or stripped away.
    const from = column(entry, span.start - entry.start);
    const to = column(entry, span.end - entry.start - 1) + 1;
    this.onHighlight({ line: entry.line, start: from, end: Math.max(to, from + 1) });
  }

  /**
   * Jump to a place in the file. Finds the word at that line and character,
   * then plays the part it belongs to from that word's start time.
   *
   * Returns true if somewhere to jump to was found.
   */
  async jumpTo(line, character) {
    if (!this.job) return false;

    // Where that spot sits in the spoken text.
    const entry = this.map.find((m) => m.line === line);
    if (!entry) return false;
    const offset = entry.start + spokenIndex(entry, character);

    // Which part covers it. Parts that could not be placed are skipped.
    let target = -1;
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (!part) continue;
      if (part.start <= offset) target = i;
      else break;
    }
    if (target < 0) return false;

    // The word timings say where in that part to start.
    await this.loadWords(target);
    const spans = this.spans.get(target) || [];
    let at = 0;
    for (const span of spans) {
      if (span.start <= offset) at = span.s;
      else break;
    }

    this.finished = false;
    this.playPart(target, at);
    return true;
  }

  ended() {
    if (!this.job || this.waiting) return;
    if (this.index + 1 < this.job.total) { this.playPart(this.index + 1); return; }
    // The last part finished. The audio element is sitting at its end, so a
    // bare play would only repeat that part; remember to start over instead.
    this.playing = false;
    this.finished = true;
    this.onHighlight(null);
    this.status();
  }

  toggle() {
    if (!this.job) return;
    if (this.playing) { this.player.post({ type: "pause" }); return; }
    if (this.finished) { this.finished = false; this.playPart(0); return; }
    // After a skip ahead to a part not written yet, the player still holds
    // the part before it. Go to the part asked for, not back to that one.
    if (this.loaded !== this.index) { this.playPart(this.index); return; }
    this.player.post({ type: "play" });
  }

  setPlaying(playing) {
    this.playing = playing;
    // The panel draws its own Play/Pause label from this, so it has to hear
    // about starting as well as stopping.
    this.status();
  }

  rate(value) {
    this.config.speed = value;
    this.player.post({ type: "rate", rate: value });
    this.status();
  }

  next() { if (this.job) this.playPart(this.index + 1); }
  prev() { if (this.job) this.playPart(this.index - 1); }

  stop() {
    this.stopped = true;
    this.unwatch();
    this.player.post({ type: "stop" });
    this.onHighlight(null);
    this.job = null;
    this.playing = false;
  }
}

module.exports = { Session };
