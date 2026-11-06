// Reads selected text (or the whole article) aloud, showing a floating player
// and lighting each word in the page itself as it is spoken.

(() => {
  if (window.__readItToMe) return;      // injected twice; keep the first
  window.__readItToMe = true;

  const HOST_ID = "read-it-to-me-root";

  let config = { server: "http://127.0.0.1:8888", password: "", voice: "af_heart", speed: 1 };
  let job = null;          // { id, total, texts }
  let ready = 0;           // parts the server has finished
  let index = 0;           // part being played
  let playing = false;
  let poller = null;       // asks the server how far along it is
  let waiting = false;     // playback caught up with rendering
  let started = false;
  let needsClick = false;   // the browser will not make sound until a click
  let raf = null;
  let litRange = null;     // the highlight currently drawn in the page
  const timings = new Map();
  // Where each part's text sits in the page, so words can be lit in place.
  let sourceRanges = [];
  let readingSelection = "";   // the selected text being read, if it was one

  // Played in the extension's hidden page (remote-audio.js): most pages do
  // not let their own audio load from this machine's server.
  const player = new (globalThis.EarfulAudio || Audio)();
  player.preservesPitch = true;
  player.mozPreservesPitch = true;
  player.webkitPreservesPitch = true;

  /* ---------------- server ---------------- */

  /** Call the server through the background worker. Answers like fetch does. */
  async function api(path, options = {}) {
    const answer = await chrome.runtime.sendMessage({ type: "api", path, options });
    if (!answer || answer.failed) throw new Error(answer?.failed || "No answer.");
    return {
      ok: answer.ok,
      status: answer.status,
      statusText: answer.statusText,
      json: async () => {
        if (answer.body === null) throw new Error("Not JSON.");
        return answer.body;
      },
    };
  }

  /* ---------------- the floating player ---------------- */

  let ui = null;

  function buildUI() {
    if (ui) return ui;
    const host = document.createElement("div");
    host.id = HOST_ID;
    // A shadow root so the page's own CSS cannot reach in and break this.
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .bar {
          position: fixed; z-index: 2147483647;
          left: 50%; bottom: 24px; transform: translateX(-50%);
          display: flex; align-items: center; gap: 10px;
          padding: 10px 12px;
          background: #221f30; color: #ece5d8;
          border: 3px solid #0b0a11; box-shadow: 4px 4px 0 #0b0a11;
          font: 10px/1.6 "Press Start 2P", ui-monospace, Menlo, monospace;
          max-width: min(92vw, 620px);
        }
        button {
          font: inherit; font-size: 10px; color: #ece5d8;
          background: #2c283d; border: 2px solid #0b0a11;
          box-shadow: 2px 2px 0 #0b0a11; padding: 8px 10px; cursor: pointer;
        }
        button:hover { background: #453f5c; }
        button:active { transform: translate(2px, 2px); box-shadow: none; }
        button.on { background: #f2b33d; color: #0b0a11; }
        .play { min-width: 42px; }
        .status { color: #a09c94; white-space: nowrap; overflow: hidden;
                  text-overflow: ellipsis; flex: 1; min-width: 90px; }
        .close { margin-left: 2px; }
        .speeds { display: flex; gap: 5px; align-items: center; }
        .rate { min-width: 52px; }
        .grip { cursor: grab; color: #6f6880; padding: 0 2px; user-select: none; touch-action: none; }
        /* Small: just play, the status and the way back to full size. */
        .bar.mini { gap: 6px; padding: 6px 8px; }
        .bar.mini .full { display: none; }
        .bar.mini .status { min-width: 0; max-width: 140px; }
      </style>
      <div class="bar" id="bar" role="region" aria-label="Earful">
        <span class="grip" id="grip" title="Drag to move">&#8942;&#8942;</span>
        <button class="play" id="play" title="Play or pause (Alt+R)">&#9654;</button>
        <button class="full" id="prev" title="Previous part (Alt+,)">&#9198;</button>
        <button class="full" id="next" title="Next part (Alt+.)">&#9197;</button>
        <span class="speeds full">
          <button id="slower" title="Slower">&minus;</button>
          <button class="rate" id="rate" title="Back to 1x">1x</button>
          <button id="faster" title="Faster">+</button>
        </span>
        <span class="status" id="status" title="Click any sentence on the page to read from there">Getting ready...</span>
        <button class="full" id="settings" title="Voice and settings">&#9881;</button>
        <button id="size" title="Make smaller">&#9662;</button>
        <button class="close" id="close" title="Stop and close">&#10005;</button>
      </div>`;
    (document.body || document.documentElement).append(host);

    const $ = (id) => root.getElementById(id);
    ui = {
      root,
      play: $("play"),
      status: $("status"),
      rate: $("rate"),
      setStatus(text) { $("status").textContent = text; },
      setPlaying(on) { $("play").innerHTML = on ? "&#10074;&#10074;" : "&#9654;"; },
    };

    $("play").addEventListener("click", toggle);
    $("prev").addEventListener("click", () => jumpTo(index - 1));
    $("next").addEventListener("click", () => jumpTo(index + 1));
    $("close").addEventListener("click", stop);
    $("settings").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "open-settings" }).catch(() => {});
    });
    $("slower").addEventListener("click", () => stepSpeed(-1));
    $("faster").addEventListener("click", () => stepSpeed(1));
    $("rate").addEventListener("click", () => setSpeed(1));
    const bar = $("bar");
    $("size").addEventListener("click", () => setMini(!bar.classList.contains("mini")));
    makeDraggable(bar, $("grip"));
    setSpeed(config.speed);
    chrome.storage.sync.get(["mini"]).then((saved) => setMini(Boolean(saved?.mini)), () => {});
    return ui;
  }

  // The speeds the - and + buttons step through.
  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  function stepSpeed(direction) {
    const now = SPEEDS.findIndex((rate) => rate >= config.speed - 0.001);
    const from = now < 0 ? SPEEDS.length - 1 : now;
    setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, from + direction))]);
  }

  function setSpeed(rate) {
    config.speed = rate;
    player.playbackRate = rate;
    chrome.storage.sync.set({ speed: rate });
    if (ui) ui.rate.textContent = `${rate}x`;
  }

  /** Shrink the player to play and status, or back. Remembered for next time. */
  function setMini(on) {
    if (!ui) return;
    const bar = ui.root.getElementById("bar");
    if (!bar) return;
    bar.classList.toggle("mini", on);
    const size = ui.root.getElementById("size");
    size.innerHTML = on ? "&#9652;" : "&#9662;";
    size.title = on ? "Make bigger" : "Make smaller";
    chrome.storage.sync.set({ mini: on });
  }

  /** Let the player be moved out of the way of what is being read. */
  function makeDraggable(bar, grip) {
    grip.addEventListener("pointerdown", (event) => {
      const box = bar.getBoundingClientRect?.();
      if (!box) return;
      const dx = event.clientX - box.left;
      const dy = event.clientY - box.top;
      grip.setPointerCapture?.(event.pointerId);
      const move = (e) => {
        const left = Math.max(0, Math.min(innerWidth - box.width, e.clientX - dx));
        const top = Math.max(0, Math.min(innerHeight - box.height, e.clientY - dy));
        Object.assign(bar.style, { left: `${left}px`, top: `${top}px`, bottom: "auto", transform: "none" });
      };
      const done = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", done);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", done);
      event.preventDefault();
    });
  }

  function setStatus() {
    if (!ui || !job) return;
    if (needsClick) { ui.setStatus("Click here to start"); return; }
    ui.setStatus(
      waiting ? "Buffering..."
        : playing ? `Part ${index + 1} / ${job.total}`
        : index >= job.total ? "Finished"
        : started ? "Paused"
        : `Getting ready... ${ready}/${job.total}`
    );
  }

  /* ---------------- highlighting inside the page ---------------- */

  // Parts of a page that are furniture rather than reading: menus, sidebars,
  // and the player's own controls.
  const SKIP_INSIDE = `#${HOST_ID}, nav, footer, aside, [role=navigation], [aria-hidden=true]`;

  // Code is punctuation when read aloud. "{\"a\":1}" becomes a minute of
  // brace, quote, colon, so it is left out.
  const CODE = "pre, code, kbd, samp, var";

  // Walk the visible text of an element into one flat string, remembering
  // which text node each character came from so a range can be rebuilt.
  function indexText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`#${HOST_ID}, script, style, noscript`)) {
          return NodeFilter.FILTER_REJECT;
        }
        // Code is not spoken, so it must not be indexed either. If the two
        // disagree the highlight drifts further out of step with every word.
        if (parent.closest(CODE)) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let text = "";
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: text.length });
      text += node.nodeValue;
    }
    return { text, nodes };
  }

  let pageIndex = null;   // { text, nodes } for the page being read

  function rangeFor(from, to) {
    if (!pageIndex) return null;
    const find = (offset) => {
      let low = 0, high = pageIndex.nodes.length - 1, hit = null;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const entry = pageIndex.nodes[mid];
        if (entry.start <= offset) { hit = entry; low = mid + 1; } else { high = mid - 1; }
      }
      if (!hit) return null;
      return { node: hit.node, offset: Math.min(offset - hit.start, hit.node.nodeValue.length) };
    };
    const a = find(from), b = find(to);
    if (!a || !b) return null;
    const range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch { return null; }
    return range;
  }

  function clearHighlight() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    if (litRange) {
      // CSS Custom Highlight API leaves the page's own DOM untouched.
      CSS.highlights?.delete("read-it-to-me");
      litRange = null;
    }
  }

  function lightRange(range) {
    if (!range || !CSS.highlights) return;
    litRange = range;
    const word = new Highlight(range);
    word.priority = 1;               // over the part's own, fainter highlight
    CSS.highlights.set("read-it-to-me", word);
  }

  /** A faint mark over the whole part being read, so the eye can follow. */
  function lightPart(i) {
    if (!CSS.highlights) return;
    const source = sourceRanges[i];
    const range = source && rangeFor(source.start, source.end);
    if (range) CSS.highlights.set("read-it-to-me-part", new Highlight(range));
    else CSS.highlights.delete("read-it-to-me-part");
  }

  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9']/g, "");

  // Kokoro emits a token per word and per punctuation mark; the page has its
  // own spacing. Match them by letters only, walking both in order.
  function alignToPage(partStart, partText, words) {
    const spans = [];
    let cursor = 0;
    let w = 0;
    while (w < words.length) {
      const target = clean(words[w].t);
      if (!target) { w++; continue; }
      // Find this word in the part's text, from where we left off.
      let found = -1;
      for (let i = cursor; i <= partText.length - 1; i++) {
        if (clean(partText[i]) !== target[0]) continue;
        let built = "";
        let j = i;
        while (j < partText.length && built.length < target.length) {
          built += clean(partText[j]);
          j++;
        }
        if (built === target) { found = i; cursor = j; break; }
      }
      spans.push(found >= 0
        ? { start: partStart + found, end: partStart + cursor, s: words[w].s, e: words[w].e }
        : null);
      w++;
    }
    return spans.filter(Boolean);
  }

  async function loadTimings(i) {
    if (timings.has(i)) return timings.get(i);
    const response = await api(`/words/${job.id}/${i}`);
    if (!response.ok) return null;
    const data = await response.json();
    timings.set(i, data.words);
    return data.words;
  }

  async function followWords(i) {
    clearHighlight();
    const words = await loadTimings(i);
    const source = sourceRanges[i];
    if (!words || !source || index !== i) return;

    const spans = alignToPage(source.start, source.text, words);
    if (!spans.length) return;

    let lit = -1;
    const tick = () => {
      if (!playing || index !== i) { raf = null; return; }
      const now = player.currentTime;
      let found = -1;
      for (let s = 0; s < spans.length; s++) {
        if (now >= spans[s].s && now < spans[s].e) { found = s; break; }
      }
      if (found !== lit) {
        lit = found;
        if (found >= 0) {
          const range = rangeFor(spans[found].start, spans[found].end);
          lightRange(range);
          // Keep the spoken word on screen, without yanking the page about.
          if (range) {
            const box = range.getBoundingClientRect();
            if (box.top < 60 || box.bottom > innerHeight - 120) {
              range.startContainer.parentElement?.scrollIntoView({
                block: "center", behavior: "smooth",
              });
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  /* ---------------- playback ---------------- */

  function playChunk(i, at = 0) {
    if (!job) return;
    if (i < 0) i = 0;
    if (i >= job.total) {
      // Past the last part. Stop for real, so the element does not sit there
      // reporting that it is still playing.
      player.pause();
      clearHighlight();
      playing = false;
      index = job.total;
      ui?.setPlaying(false);
      setStatus();
      return;
    }
    if (i >= ready) {
      // Silence the part being left. Played on, it would end and move past
      // the part being waited for.
      player.pause();
      clearHighlight();
      waiting = true;
      index = i;
      setStatus();
      return;
    }

    waiting = false;
    index = i;
    lightPart(i);
    const src = `${config.server}/chunk/${job.id}/${i}.wav`;
    if (player.getAttribute("src") === src) player.load(); else player.src = src;
    player.playbackRate = config.speed;
    if (at > 0) {
      player.addEventListener("loadedmetadata", () => { player.currentTime = at; }, { once: true });
    }
    start();
    followWords(i);
    setStatus();
  }

  /**
   * Ask the audio to play, and notice when it does not.
   *
   * Chrome refuses to make sound until the page has been clicked. Sometimes
   * it says so by rejecting, and sometimes it resolves and stays silent, so
   * both have to be caught or the player sits there looking as if it works.
   */
  function start() {
    const attempt = player.play();
    if (!attempt || !attempt.then) { blocked(); return; }

    attempt.then(() => {
      const was = player.currentTime;
      setTimeout(() => {
        // Paused on purpose meanwhile: that is not the browser refusing.
        if (!playing) return;
        if (player.paused || player.currentTime === was) blocked();
      }, 600);
    }).catch((error) => {
      if (error.name !== "AbortError") blocked();   // a newer skip cancels a play
    });
  }

  /** Nothing is coming out. Say what to do about it. */
  function blocked() {
    playing = false;
    needsClick = true;
    ui?.setPlaying(false);
    ui?.setStatus("Click here to start");
  }

  function jumpTo(i) {
    if (!job) return;
    i = Math.max(0, Math.min(i, job.total - 1));
    started = true;
    playing = true;
    ui?.setPlaying(true);
    // A part the server has not finished is not a dead end: playChunk holds
    // there and starts it as soon as it arrives. Refusing here made the
    // skip buttons look broken while the rest was still being written.
    playChunk(i);
  }

  // Real sound is coming out, so the prompt has done its job. The highlight
  // loop stops whenever playing goes false, so it has to be started again
  // rather than only having the flag put back.
  // Another tab started reading, which stops this one. Say paused, so play
  // here takes the sound back, rather than claiming to still be reading.
  player.addEventListener("taken", () => {
    playing = false;
    waiting = false;
    needsClick = false;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    clearHighlight();
    ui?.setPlaying(false);
    setStatus();
  });

  player.addEventListener("playing", () => {
    needsClick = false;
    if (playing && raf) return;      // already running, nothing to restart
    playing = true;
    ui?.setPlaying(true);
    followWords(index);
    setStatus();
  });

  /**
   * Tell the server where this reading has got to, so a phone can take over.
   *
   * About once a second, and never allowed to interrupt: handing over is a
   * convenience, so a server that refuses it changes nothing here.
   */
  let handedOff = 0;
  player.addEventListener("timeupdate", () => {
    if (!job || !playing) return;
    const stamp = Date.now();
    if (stamp - handedOff < 1000) return;
    handedOff = stamp;

    api("/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job: job.id,
        index,
        at: player.currentTime,
        title: document.title || location.hostname,
      }),
    }).catch(() => { /* handing over is optional */ });
  });

  player.addEventListener("ended", () => {
    clearHighlight();
    if (playing && !waiting) playChunk(index + 1);
  });

  function toggle() {
    if (!job) return;
    // Before the first part has played, a press means "not yet": hold the
    // start, and the next press begins.
    if (!started && !playing) {
      started = true;
      ui?.setPlaying(false);
      setStatus();
      return;
    }
    if (playing) {
      player.pause();
      playing = false;
      waiting = false;       // or the part starts by itself when it arrives
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      ui?.setPlaying(false);
      setStatus();
      return;
    }
    playing = true;
    ui?.setPlaying(true);
    // The audio may still hold an earlier part, if pause came during a wait.
    const current = player.getAttribute("src") === `${config.server}/chunk/${job.id}/${index}.wav`;
    const loaded = current && player.readyState > 0 && !player.ended && player.currentTime > 0;
    if (started && loaded) {
      start();
      followWords(index);
      setStatus();
    } else {
      started = true;
      if (index >= job.total) index = 0;   // finished: start again from the top
      playChunk(index);
    }
  }

  function stop() {
    player.pause();
    stopListening();
    clearHighlight();
    job = null; ready = 0; index = 0; playing = false; started = false; waiting = false;
    timings.clear();
    sourceRanges = [];
    readingSelection = "";
    CSS.highlights?.delete("read-it-to-me-part");
    pageIndex = null;
    document.getElementById(HOST_ID)?.remove();
    ui = null;
  }

  /* ---------------- click a word to read from there ---------------- */

  /** Where in the page text a point on screen falls, or -1. */
  function offsetAt(x, y) {
    if (!pageIndex) return -1;
    let node = null, within = 0;
    const spot = document.caretPositionFromPoint?.(x, y);
    if (spot) { node = spot.offsetNode; within = spot.offset; }
    else {
      const range = document.caretRangeFromPoint?.(x, y);
      if (range) { node = range.startContainer; within = range.startOffset; }
    }
    if (!node || node.nodeType !== 3) return -1;   // not in text
    const entry = pageIndex.nodes.find((e) => e.node === node);
    return entry ? entry.start + within : -1;
  }

  /** Carry on reading from a point in the page text. False if it is not read. */
  async function readFrom(offset) {
    const i = sourceRanges.findIndex((r) => r && offset >= r.start && offset <= r.end);
    if (i < 0) return false;
    let at = 0;
    const words = await loadTimings(i);
    if (words) {
      for (const span of alignToPage(sourceRanges[i].start, sourceRanges[i].text, words)) {
        if (span.start <= offset) at = span.s; else break;
      }
    }
    started = true;
    playing = true;
    needsClick = false;
    ui?.setPlaying(true);
    playChunk(i, at);
    return true;
  }

  // While a reading is open, a click on a word carries on from there, as on
  // the Earful page and in NaturalReader. Links, buttons, fields and a click
  // that finishes selecting text keep their usual meaning.
  document.addEventListener("click", (event) => {
    if (!job || event.button !== 0 || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (!target?.closest || target.closest(
      `#${HOST_ID}, a, button, input, textarea, select, label, summary, video, audio, ` +
      "[contenteditable], [role=button], [role=link], [role=tab], [role=menuitem]")) return;
    if (String(window.getSelection?.() || "").trim()) return;
    const offset = offsetAt(event.clientX, event.clientY);
    if (offset >= 0) readFrom(offset);
  });

  /* ---------------- starting a read ---------------- */

  // Where does each part sit in the page text? Parts come back normalized, so
  // match them by letters only rather than exact characters.
  function locateParts(texts, searchFrom = 0) {
    const flat = pageIndex.text;
    const flatClean = [];
    const map = [];
    for (let i = 0; i < flat.length; i++) {
      const c = clean(flat[i]);
      if (c) { flatClean.push(c); map.push(i); }
    }
    const haystack = flatClean.join("");
    let cursor = 0;
    // Start looking from where the selection began, so a repeated phrase
    // lights up in the right place.
    if (searchFrom > 0) {
      cursor = map.findIndex((position) => position >= searchFrom);
      if (cursor < 0) cursor = 0;
    }
    return texts.map((part) => {
      const needle = clean(part);
      if (!needle) return null;
      const at = haystack.indexOf(needle, cursor);
      if (at < 0) return null;
      cursor = at + needle.length;
      return { start: map[at], end: map[Math.min(at + needle.length, map.length - 1)], text: part };
    });
  }

  function listen() {
    stopListening();
    const ask = async () => {
      if (!job) { stopListening(); return; }
      try {
        const response = await api(`/progress-once/${job.id}`);
        if (!response.ok) { stopListening(); return; }
        const update = await response.json();
        onProgress(update);
        if (update.state !== "running") stopListening();
      } catch {
        // The server went away. Say so once and stop asking, rather than
        // knocking on a closed door every second for the rest of the day.
        stopListening();
        ui?.setStatus(`Lost the server at ${config.server}.`);
      }
    };
    poller = setInterval(ask, 500);
    ask();
  }

  function stopListening() {
    if (poller) { clearInterval(poller); poller = null; }
  }

  function onProgress(update) {
    ready = update.done;
    if (ready > 0 && !started) {
      started = true;
      playing = true;
      ui?.setPlaying(true);
      // playChunk already asks it to play, and does so through start(),
      // which notices a browser that resolves the request but stays silent.
      // Calling play() again here bypassed that check.
      playChunk(0);
    } else if (waiting && ready > index) {
      playChunk(index);
    }
    if (update.state === "ready") stopListening();
    if (update.state === "error") {
      stopListening();
      ui?.setStatus(update.error || "Something went wrong.");
    }
    setStatus();
  }

  async function read(text, searchFrom = 0) {
    if (!text.trim()) return;
    stop();
    buildUI();
    ui.setStatus("Getting ready...");
    pageIndex = indexText(document.body);

    let response;
    try {
      response = await api("/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: config.voice }),
      });
    } catch (error) {
      ui.setStatus(`Cannot reach ${config.server}. Is the app running?`);
      return;
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => ({ detail: response.statusText }));
      ui.setStatus(detail.detail || "The server refused that.");
      return;
    }

    job = await response.json();
    sourceRanges = locateParts(job.texts, searchFrom);
    listen();
    setStatus();
  }

  /* ---------------- what to read ---------------- */

  function selectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;
    const text = selection.toString();
    if (!text.trim()) return null;
    // Where in the flat page text the selection starts, for locateParts.
    const probe = indexText(document.body);
    const at = probe.text.indexOf(text.slice(0, 60));
    return { text, from: at >= 0 ? at : 0 };
  }

  // The page's main text, preferring the article container when there is one.
  /** Text worth reading, with code and repeated blocks left out. */
  function pageText() {
    const candidate =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector("[role=main]") ||
      document.body;

    const blocks = candidate.querySelectorAll(
      "p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, dd, dt"
    );
    const parts = [];
    const taken = [];
    for (const node of blocks) {
      if (node.closest(SKIP_INSIDE)) continue;
      if (node.closest(CODE)) continue;
      // A <li> holding a <p> matches twice; keep the outer one only, or the
      // sentence is read out and highlighted a second time.
      if (taken.some((chosen) => chosen.contains(node))) continue;

      const text = readable(node);
      if (text.length > 1) { parts.push(text); taken.push(node); }
    }
    return parts.join("\n\n") || readable(candidate) ||
      // An empty <main>, with the text elsewhere on the page.
      (candidate === document.body ? "" : readable(document.body));
  }

  /**
   * What this frame could read, for the background worker to choose a frame.
   *
   * The script runs in every frame of a page, and some pages keep all their
   * text in one: a Claude artifact does. A frame too small to see is not
   * where anyone is reading, whatever it holds.
   */
  function measure() {
    const selected = String(window.getSelection() || "").trim();
    return {
      page: pageText().length,
      // Text already being read does not count: clicking the icon again
      // with it still selected means pause, not start over.
      selection: selected && selected !== readingSelection ? selected.length : 0,
      reading: Boolean(job),
      seen: innerWidth >= 200 && innerHeight >= 150,
    };
  }

  /** One block's text, with any code inside it dropped. */
  function readable(node) {
    if (!node.querySelector(CODE)) return node.innerText.trim();
    // Work on a copy so the page itself is never touched.
    const copy = node.cloneNode(true);
    for (const code of copy.querySelectorAll(CODE)) code.remove();
    return copy.innerText.trim().replace(/\s{2,}/g, " ");
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "ping") { respond({ ok: true }); return false; }
    if (message.type === "measure") {
      chrome.runtime.sendMessage({ type: "measured", nonce: message.nonce, result: measure() })
        .catch(() => { /* the worker restarted; it asks again next time */ });
      respond({ ok: true });
      return false;
    }
    if (message.settings) config = { ...config, ...message.settings };

    if (message.type === "read") {
      const info = selectionInfo();
      read(message.text || info?.text || "", info?.from || 0);
      readingSelection = String(window.getSelection() || "").trim();
    } else if (message.type === "read-selection") {
      const info = selectionInfo();
      if (info) { read(info.text, info.from); readingSelection = info.text.trim(); }
      else { buildUI(); ui.setStatus("Select some text first."); }
    } else if (message.type === "read-page") {
      const text = pageText();
      if (text) read(text, 0);
      else { buildUI(); ui.setStatus("Found nothing to read on this page."); }
    } else if (message.type === "toggle") {
      toggle();
    } else if (message.type === "next" || message.type === "prev") {
      if (job) jumpTo(index + (message.type === "next" ? 1 : -1));
    } else if (message.type === "stop") {
      stop();
    }
    respond({ ok: true });
    return false;
  });
})();
