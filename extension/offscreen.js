// The extension's hidden page that makes the sound.
//
// Web pages may forbid audio from this machine's server, so the reading is
// played here instead, where their rules do not reach. The page being read
// drives it through remote-audio.js; the background worker carries the
// messages both ways, because this page can only talk to the worker.

const audio = new Audio();
audio.preservesPitch = true;      // speed up without chipmunk voice

let owner = null;     // which reader the audio belongs to
let gen = 0;          // that reader's count of audio replaced, for its events

function report(event, to = owner, about = gen) {
  if (to === null) return;
  chrome.runtime.sendMessage({
    type: "audio-event",
    owner: to,
    gen: about,
    event,
    currentTime: audio.currentTime,
    duration: Number.isFinite(audio.duration) ? audio.duration : null,
    paused: audio.paused,
    ended: audio.ended,
    readyState: audio.readyState,
  }).catch(() => { /* the worker is restarting; the next event gets through */ });
}

for (const type of ["loadedmetadata", "playing", "pause", "timeupdate", "ended"]) {
  audio.addEventListener(type, () => report(type));
}

function clear() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.to !== "offscreen") return false;

  // The page that owned the audio was closed or left.
  if (message.op === "gone") {
    if (message.owner === owner) { clear(); owner = null; }
    return false;
  }

  // Another page starts reading: the first stops, and is told so. Even when
  // it was paused or waiting for a part, or it would take the audio back.
  if (message.owner !== owner) {
    audio.pause();
    report("taken", owner, gen);
    clear();
    owner = message.owner;
  }
  gen = message.gen;

  switch (message.op) {
    case "src":
      if (message.src) audio.src = message.src;
      else clear();
      break;
    case "load":
      audio.load();
      break;
    case "pause":
      audio.pause();
      break;
    case "seek":
      audio.currentTime = message.at;
      break;
    case "rate":
      audio.playbackRate = message.rate;
      break;
    case "play":
      // This page may be new, if Chrome closed the last one while paused.
      if (message.src && audio.getAttribute("src") !== message.src) {
        audio.src = message.src;
        if (message.at > 0) {
          audio.addEventListener("loadedmetadata", () => { audio.currentTime = message.at; }, { once: true });
        }
      }
      audio.playbackRate = message.rate || 1;
      audio.play().then(
        () => respond({}),
        (error) => respond({ error: error.name || "Error" }),
      );
      return true;   // answers once playing has started, or failed
  }
  return false;
});
