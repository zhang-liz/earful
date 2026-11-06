// Wires the right-click menu, the toolbar button and the keyboard shortcut
// to the content script that does the reading.

const DEFAULTS = { server: "http://127.0.0.1:8888", password: "", voice: "af_heart", speed: 1 };

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "read-selection",
    title: "Read this aloud",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "read-page",
    title: "Read the whole page",
    contexts: ["page"],
  });
});

// The content script runs in every frame, because some pages keep their text
// in one: a Claude artifact keeps all of it in a frame from another site. Each
// command goes to the frame it is about.

async function inject(tabId) {
  const files = { js: ["remote-audio.js", "content.js"], css: ["content.css"] };
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: files.js });
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: files.css });
  } catch {
    // Frames from other sites may be off limits; the page itself is enough.
    await chrome.scripting.executeScript({ target: { tabId }, files: files.js });
    await chrome.scripting.insertCSS({ target: { tabId }, files: files.css });
  }
}

// The content script is declared for every page, but a tab open from before
// the extension loaded has no copy of it yet. Inject on demand.
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return true;
  } catch {
    try {
      await inject(tabId);
      return true;
    } catch (error) {
      console.warn("Earful: cannot run on this page.", error);
      return false;
    }
  }
}

// Frames answering a "measure", by the request they answer.
const measuring = new Map();

/**
 * What each frame in the tab could read: [{ frameId, page, selection, seen }].
 *
 * Every frame hears the question and answers separately, with its frame id.
 * Asking by message needs no permission for the sites the frames come from.
 */
async function measureFrames(tabId) {
  if (!(await ensureContentScript(tabId))) return [];
  const nonce = crypto.randomUUID();
  const found = [];
  measuring.set(nonce, found);
  try {
    await chrome.tabs.sendMessage(tabId, { type: "measure", nonce });
    await new Promise((resolve) => setTimeout(resolve, 200));   // the others
  } catch (error) {
    console.warn("Earful:", error);
  } finally {
    measuring.delete(nonce);
  }
  return found;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== "measured") return false;
  measuring.get(message.nonce)?.push({ frameId: sender.frameId, ...message.result });
  return false;
});

/** The frame to send a command to: where the selection is, or the most text. */
function pick(found, want) {
  const top = found.find((frame) => frame.frameId === 0) || found[0];
  if (want === "selection") return found.find((frame) => frame.selection > 0) || top;
  return found
    .filter((frame) => frame.seen || frame === top)
    .reduce((best, frame) => (frame.page > best.page ? frame : best), top);
}

async function deliver(tabId, message, frameId) {
  try {
    const options = frameId === undefined ? {} : { frameId };
    await chrome.tabs.sendMessage(tabId, { ...message, settings: await settings() }, options);
  } catch (error) {
    console.warn("Earful:", error);
  }
}

/**
 * Send a command to the right frame of a tab.
 *
 * `frameId` is the frame a right-click came from, when there was one.
 */
async function send(tabId, message, frameId) {
  // Pause and stop are for whichever frame is reading; every frame hears them.
  if (message.type === "toggle" || message.type === "stop") {
    await deliver(tabId, message);
    return;
  }
  const found = await measureFrames(tabId);
  if (!found.length) return;
  const clicked = found.find((frame) => frame.frameId === frameId);
  const want = message.type === "read-page" ? "page" : "selection";
  const target = (message.type === "read" && clicked) || pick(found, want);
  await deliver(tabId, message, target.frameId);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "read-selection") {
    send(tab.id, { type: "read", text: info.selectionText || "" }, info.frameId);
  } else if (info.menuItemId === "read-page") {
    send(tab.id, { type: "read-page" }, info.frameId);
  }
});

/**
 * The one-click action, from the toolbar icon or Alt+R.
 *
 * New selected text is read. Otherwise a reading under way pauses or plays,
 * and with none, the whole page is read.
 */
async function readOrPause(tabId) {
  const found = await measureFrames(tabId);
  if (!found.length) return;
  const selected = found.find((frame) => frame.selection > 0);
  if (selected) {
    await deliver(tabId, { type: "read-selection" }, selected.frameId);
  } else if (found.some((frame) => frame.reading)) {
    await deliver(tabId, { type: "toggle" });
  } else {
    await deliver(tabId, { type: "read-page" }, pick(found, "page").frameId);
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id) readOrPause(tab.id);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "read-or-pause" && tab?.id) readOrPause(tab.id);
});

/**
 * Make a call to the server for the content script.
 *
 * A content script's own fetch is held to the rules of the page it sits in, and
 * the server refuses other sites on purpose. This worker has its own permission
 * to reach the server. The address and password come from the saved settings,
 * never from the message.
 */
async function callServer({ path, options = {} }) {
  const { server, password } = await settings();
  const headers = { ...options.headers };
  if (password) headers.Authorization = "Basic " + btoa(":" + password);
  try {
    const response = await fetch(server + path, { ...options, headers });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, statusText: response.statusText, body };
  } catch (error) {
    return { failed: String(error) };
  }
}

// Messages from the content script: calls to the server, and the player's
// gear button.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "api") {
    callServer(message).then(respond);
    return true;   // respond asynchronously
  }
  if (message.type === "open-settings") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  return false;
});

/* ---------------- the hidden page that makes the sound ---------------- */

// See remote-audio.js for why the audio does not play in the page itself.

let creating = null;

/** Open the hidden sound page, unless it is open already. */
function ensureOffscreen() {
  creating ||= (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Plays the page being read aloud.",
    });
  })().finally(() => { creating = null; });
  return creating;
}

const readers = new Map();   // owner id -> the port to that page's player

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "earful-audio") return;
  // Random, so ids from before a worker restart never point at a new page.
  const owner = crypto.randomUUID();
  readers.set(owner, port);

  // One at a time and in order: "play" must not overtake the "src" before it.
  let queue = Promise.resolve();
  port.onMessage.addListener((message) => {
    queue = queue.then(ensureOffscreen).then(() => {
      const answer = chrome.runtime.sendMessage({ ...message, to: "offscreen", owner });
      if (!message.call) return answer.catch(() => {});
      // Not awaited: a play answers only once sound starts, and a pause sent
      // meanwhile must not wait behind it.
      answer
        .then((reply) => reply || {}, () => ({ error: "EarfulOffscreen" }))
        .then((reply) => {
          try { port.postMessage({ reply: message.call, error: reply.error }); } catch { /* page gone */ }
        });
    }).catch((error) => {
      console.warn("Earful: cannot play.", error);
      if (message.call) {
        try { port.postMessage({ reply: message.call, error: "EarfulOffscreen" }); } catch { /* page gone */ }
      }
    });
  });

  // The page was closed or left: stop its reading rather than talk to no one.
  port.onDisconnect.addListener(() => {
    readers.delete(owner);
    chrome.runtime.sendMessage({ to: "offscreen", op: "gone", owner }).catch(() => {});
  });
});

// The hidden page's events, passed on to the page that owns the audio.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "audio-event") return false;
  try { readers.get(message.owner)?.postMessage(message); } catch { /* page gone */ }
  return false;
});
