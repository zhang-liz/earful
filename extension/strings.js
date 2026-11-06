// The words the extension shows, in the reader's language.
//
// Every word lives in _locales/<folder>/messages.json, one table per language,
// which Chrome also uses for the manifest. Chrome on its own would follow only
// the browser's language, so the table is loaded here instead: that way the
// reader can switch language in the settings without changing the browser.
//
// Loaded by the background worker (importScripts) and the settings page.

/* exported EarfulStrings */
const EarfulStrings = (() => {
  // Our language id -> Chrome's folder name for it.
  const FOLDERS = { en: "en", zh: "zh_CN" };
  const tables = new Map();

  /** The language to show: the saved choice, or else the browser's. */
  function pick(saved, browser) {
    if (FOLDERS[saved]) return saved;
    return /^zh\b/i.test(String(browser || "")) ? "zh" : "en";
  }

  /** The word table for a language, as { key: text }. Cached. */
  async function table(language) {
    const folder = FOLDERS[language] || FOLDERS.en;
    if (!tables.has(folder)) {
      tables.set(folder, (async () => {
        const response = await fetch(chrome.runtime.getURL(`_locales/${folder}/messages.json`));
        const messages = await response.json();
        return Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, value.message]));
      })().catch((error) => { tables.delete(folder); throw error; }));
    }
    return tables.get(folder);
  }

  /** One text, with {name} filled in from vars. A missing key shows itself. */
  function fill(words, key, vars = {}) {
    const text = (words && words[key]) ?? key;
    return text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));
  }

  return { FOLDERS, pick, table, fill };
})();
