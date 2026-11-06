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

// The content script is declared for every page, but a tab open from before
// the extension loaded has no copy of it yet. Inject on demand.
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["remote-audio.js", "content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      return true;
    } catch (error) {
      console.warn("Earful: cannot run on this page.", error);
      return false;
    }
  }
}

async function send(tabId, message) {
  if (!(await ensureContentScript(tabId))) return;
  try {
    await chrome.tabs.sendMessage(tabId, { ...message, settings: await settings() });
  } catch (error) {
    console.warn("Earful:", error);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "read-selection") {
    send(tab.id, { type: "read", text: info.selectionText || "" });
  } else if (info.menuItemId === "read-page") {
    send(tab.id, { type: "read-page" });
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "read-selection" && tab?.id) {
    send(tab.id, { type: "read-selection" });
  }
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

// Messages from the popup, which has no access to the page itself, and from
// the content script, which needs the server.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "api") {
    callServer(message).then(respond);
    return true;   // respond asynchronously
  }
  if (message.type === "popup-command") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) send(tab.id, message.command);
      respond({ ok: true });
    });
    return true;   // respond asynchronously
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
