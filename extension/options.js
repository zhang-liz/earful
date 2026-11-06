// Settings: the server, the password and the voice. Opened from the gear on
// the player, or Options on the toolbar icon's right-click menu.

const DEFAULTS = { server: "http://127.0.0.1:8888", password: "", voice: "af_heart", speed: 1 };
const $ = (id) => document.getElementById(id);

async function load() {
  const saved = { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
  $("server").value = saved.server;
  $("password").value = saved.password;
  await loadVoices(saved);
  return saved;
}

async function loadVoices(saved) {
  const note = $("note");
  const headers = saved.password ? { Authorization: "Basic " + btoa(":" + saved.password) } : {};
  try {
    const response = await fetch(saved.server + "/voices", { headers });
    if (!response.ok) {
      note.textContent = response.status === 401
        ? "Wrong password."
        : `Server said ${response.status}.`;
      note.className = "note bad";
      return;
    }
    const data = await response.json();
    $("voice").textContent = "";
    for (const voice of data.voices) {
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.label;
      $("voice").append(option);
    }
    $("voice").value = saved.voice || data.default;
    note.textContent = `Connected. ${data.voices.length} voices.`;
    note.className = "note ok";
  } catch {
    note.textContent = "Cannot reach the server. Is ./run.sh running?";
    note.className = "note bad";
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
    const note = $("note");
    note.textContent = "Chrome needs permission to reach that address.";
    note.className = "note bad";
    return;
  }
  await chrome.storage.sync.set({
    server,
    password: $("password").value,
    voice: $("voice").value || DEFAULTS.voice,
  });
  await loadVoices(await chrome.storage.sync.get(Object.keys(DEFAULTS)));
}

$("save").addEventListener("click", save);
$("voice").addEventListener("change", save);

load();
