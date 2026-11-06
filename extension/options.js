// Settings: the language, the voices, the server and the password. Opened
// from the gear on the player, or Options on the toolbar icon's right-click
// menu.

/* global EarfulStrings */

const DEFAULTS = {
  server: "http://127.0.0.1:8888", password: "", voice: "af_heart", voiceZh: "",
  readLanguage: "", language: "", speed: 1,
};
const $ = (id) => document.getElementById(id);

let lang = "en";
let words = {};
let voices = null;   // the server's last answer to /voices, to relabel on a switch

const t = (key, vars) => EarfulStrings.fill(words, key, vars);

function setNote(key, vars, kind) {
  const note = $("note");
  note.dataset.i18n = key;
  note.dataset.vars = JSON.stringify(vars || {});
  note.textContent = t(key, vars);
  note.className = kind ? `note ${kind}` : "note";
}

/** Put every word on the page in the reader's language. */
async function showLanguage(saved) {
  lang = EarfulStrings.pick(saved.language, chrome.i18n?.getUILanguage?.());
  try { words = await EarfulStrings.table(lang); } catch { words = {}; }
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n, el.dataset.vars ? JSON.parse(el.dataset.vars) : undefined);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  if (voices) fillVoices(saved);
}

const saved = async () => ({ ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) });

async function load() {
  const settings = await saved();
  await showLanguage(settings);
  $("server").value = settings.server;
  $("password").value = settings.password;
  $("readLanguage").value = settings.readLanguage;
  await loadVoices(settings);
}

function option(voice) {
  const element = document.createElement("option");
  element.value = voice.id;
  element.textContent = voice.labels?.[lang] || voice.label;
  return element;
}

/**
 * One picker per language on a newer server. An older one knows no
 * languages, so it keeps the single picker with every voice.
 */
function fillVoices(settings) {
  const languages = Array.isArray(voices.languages);
  const of = (id) => voices.voices.filter((voice) => !languages || voice.language === id);
  $("voice").replaceChildren(...of("en").map(option));
  $("voice").value = settings.voice || voices.default;
  if (!$("voice").value) $("voice").value = voices.default;
  $("voiceLabel").dataset.i18n = languages ? "optionsVoiceEn" : "optionsVoice";
  $("voiceLabel").textContent = t($("voiceLabel").dataset.i18n);

  $("zhRow").hidden = !languages || !of("zh").length;
  if ($("zhRow").hidden) return;
  $("voiceZh").replaceChildren(...of("zh").map(option));
  const usual = voices.languages.find((language) => language.id === "zh")?.default;
  $("voiceZh").value = settings.voiceZh || usual;
}

async function loadVoices(settings) {
  const headers = settings.password ? { Authorization: "Basic " + btoa(":" + settings.password) } : {};
  try {
    const response = await fetch(settings.server + "/voices", { headers });
    if (!response.ok) {
      if (response.status === 401) setNote("optionsWrongPassword", null, "bad");
      else setNote("optionsServerSaid", { status: response.status }, "bad");
      return;
    }
    voices = await response.json();
    fillVoices(settings);
    setNote("optionsConnected", { count: voices.voices.length }, "ok");
  } catch {
    setNote("optionsCannotReach", null, "bad");
  }
}

// 127.0.0.1 and localhost are granted in the manifest. Any other address is
// optional, so ask for it once here rather than failing silently later.
async function allow(server) {
  let origin;
  try { origin = new URL(server).origin + "/*"; } catch { return true; }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(server)) return true;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  try { return await chrome.permissions.request({ origins: [origin] }); }
  catch { return false; }
}

async function save() {
  const server = $("server").value.trim().replace(/\/+$/, "") || DEFAULTS.server;
  if (!(await allow(server))) {
    setNote("optionsNeedPermission", null, "bad");
    return;
  }
  const choices = {
    server,
    password: $("password").value,
    voice: $("voice").value || DEFAULTS.voice,
    readLanguage: $("readLanguage").value,
  };
  // Only a server with Mandarin voices shows the picker; otherwise keep
  // whatever was chosen before rather than wiping it.
  if (!$("zhRow").hidden) choices.voiceZh = $("voiceZh").value;
  await chrome.storage.sync.set(choices);
  await loadVoices(await saved());
}

/** The button names the other language; one click shows everything in it. */
async function switchLanguage() {
  await chrome.storage.sync.set({ language: lang === "zh" ? "en" : "zh" });
  await showLanguage(await saved());
}

$("save").addEventListener("click", save);
$("voice").addEventListener("change", save);
$("voiceZh").addEventListener("change", save);
$("readLanguage").addEventListener("change", save);
$("language").addEventListener("click", switchLanguage);

load();
