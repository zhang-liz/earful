// Wires the right-click menu, the toolbar button and the keyboard shortcut
// to the content script that does the reading.

const DEFAULTS = { server: "http://127.0.0.1:8888", password: "", voice: "am_michael", speed: 1 };

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
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      return true;
    } catch (error) {
      console.warn("Read It To Me: cannot run on this page.", error);
      return false;
    }
  }
}

async function send(tabId, message) {
  if (!(await ensureContentScript(tabId))) return;
  try {
    await chrome.tabs.sendMessage(tabId, { ...message, settings: await settings() });
  } catch (error) {
    console.warn("Read It To Me:", error);
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

// Messages from the popup, which has no access to the page itself.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "popup-command") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) send(tab.id, message.command);
      respond({ ok: true });
    });
    return true;   // respond asynchronously
  }
  return false;
});
