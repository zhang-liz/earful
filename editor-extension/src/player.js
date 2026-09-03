// The audio lives in a webview, because that is the only place inside the
// editor with a real <audio> element. An <audio> element is what makes live
// speed change and word-accurate position possible; a command line player
// gives neither.
//
// The webview is a thin speaker. It owns no logic: it plays what it is told
// and reports where it is. All decisions stay in the extension.

const vscode = require("vscode");

const VIEW_TYPE = "readItToMe.player";

/** The page inside the webview. Kept small on purpose. */
function html(csp) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  /* Every colour falls back, so the controls stay visible even if a theme
     does not define one of these variables. */
  body {
    margin: 0;
    padding: 10px 12px;
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e);
  }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  button {
    font: inherit;
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
    border: none;
    padding: 4px 10px;
    border-radius: 2px;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  button.on { outline: 2px solid var(--vscode-focusBorder, #007fd4); }
  #status { opacity: 0.8; margin-left: 4px; }
</style>
</head>
<body>
  <div class="row">
    <button id="toggle">Pause</button>
    <button id="prev">Back</button>
    <button id="next">Forward</button>
    <button class="rate" data-rate="1">1x</button>
    <button class="rate" data-rate="1.5">1.5x</button>
    <button class="rate" data-rate="2">2x</button>
    <span id="status"></span>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const player = new Audio();
  player.preservesPitch = true;
  let timer = null;
  let needsClick = false;   // the editor refused to make sound without a click
  let heard = false;        // sound has actually been produced
  let attempt = 0;          // which request to play we are waiting on
  let paused_on_purpose = false;

  function send(type, body) { vscode.postMessage({ type, ...body }); }

  // Report position often enough that the highlight looks live.
  function watch() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (!player.paused) send("time", { time: player.currentTime });
    }, 50);
  }

  // Asking to play can fail in two ways: the promise rejects, or it resolves
  // and the sound never actually starts (a hidden or unfocused panel). Both
  // must be reported, so the extension never claims to be reading in silence.
  async function start() {
    paused_on_purpose = false;
    try {
      await player.play();
    } catch (error) {
      send("blocked", {});
      return;
    }
    watch();
    // A browser that blocks sound resolves the request and then does nothing,
    // so check a moment later whether anything actually happened. Pausing on
    // purpose within that moment is not a failure, and neither is playback
    // that has already started, so both are let through.
    heard = false;
    const was = player.currentTime;
    const asked = ++attempt;
    setTimeout(() => {
      if (asked !== attempt) return;          // superseded by a later start
      if (heard) return;                      // sound arrived
      if (player.paused && paused_on_purpose) return;
      if (player.currentTime !== was) return;
      send("blocked", {});
    }, 700);
  }

  player.addEventListener("ended", () => send("ended", {}));
  player.addEventListener("error", () =>
    send("failed", { detail: player.error ? player.error.code : "unknown" }));
  player.addEventListener("playing", () => {
    // Real sound is coming out now, so the prompt has served its purpose.
    heard = true;
    needsClick = false;
    document.getElementById("toggle").classList.remove("on");
  });
  player.addEventListener("play", () => send("playing", { playing: true }));
  player.addEventListener("pause", () => send("playing", { playing: false }));

  document.getElementById("toggle").addEventListener("click", () => send("toggle", {}));
  document.getElementById("prev").addEventListener("click", () => send("prev", {}));
  document.getElementById("next").addEventListener("click", () => send("next", {}));
  for (const button of document.querySelectorAll(".rate")) {
    button.addEventListener("click", () => send("rate", { rate: Number(button.dataset.rate) }));
  }

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (message.type === "load") {
      // Reloading the same address needs an explicit load(); setting src to
      // the value it already holds does nothing.
      if (player.getAttribute("src") === message.url) player.load();
      else player.src = message.url;
      player.playbackRate = message.rate;
      if (message.at) {
        player.addEventListener("loadedmetadata",
          () => { player.currentTime = message.at; }, { once: true });
      }
      start();
    } else if (message.type === "play") {
      start();
    } else if (message.type === "pause") {
      paused_on_purpose = true;
      player.pause();
    } else if (message.type === "rate") {
      player.playbackRate = message.rate;
    } else if (message.type === "seek") {
      player.currentTime = message.time;
    } else if (message.type === "needsClick") {
      // Sticky: progress updates keep arriving while nothing is playing, and
      // they must not paper over the one thing the user has to do.
      needsClick = true;
      const toggle = document.getElementById("toggle");
      toggle.textContent = "Play";
      toggle.classList.add("on");
      document.getElementById("status").textContent =
        "Click Play to start \u2014 the editor blocks sound until you do.";
    } else if (message.type === "status") {
      if (needsClick) return;               // still waiting for that click
      document.getElementById("status").textContent = message.text;
      document.getElementById("toggle").textContent = message.playing ? "Pause" : "Play";
      for (const button of document.querySelectorAll(".rate")) {
        button.classList.toggle("on", Number(button.dataset.rate) === message.rate);
      }
    } else if (message.type === "stop") {
      player.pause();
      player.removeAttribute("src");
      player.load();
      if (timer) { clearInterval(timer); timer = null; }
    }
  });

  send("ready", {});
</script>
</body>
</html>`;
}

/**
 * A webview that plays audio and reports its position.
 *
 * `onMessage` receives every message the page sends. `onDispose` fires when
 * the user closes the panel.
 */
class Player {
  /**
   * @param {boolean} visible  whether to show the panel at all. It is only a
   *   speaker; every control lives on the file's own title bar. It still has
   *   to exist, because a webview is the one place in the editor that can
   *   play sound, but it does not have to be looked at.
   */
  constructor(visible, onMessage, onDispose) {
    // Hidden, the panel opens as a background tab in the same column as the
    // file, so it takes up no room at all. Shown, it sits beside the file.
    // Either way it is only a speaker: the controls are on the file's own
    // title bar.
    const where = visible
      ? { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
      : { viewColumn: vscode.ViewColumn.Active, preserveFocus: true };

    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Read It To Me",
      where,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.visible = visible;
    if (!visible) this.hide();

    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      // The audio comes from the user's own server, which may be on the LAN.
      "media-src http: https:",
      "connect-src http: https:",
    ].join("; ");

    this.panel.webview.html = html(csp);
    this.panel.webview.onDidReceiveMessage(onMessage);
    this.panel.onDidDispose(onDispose);
  }

  post(message) {
    // Posting to a disposed panel throws; the caller should not have to care.
    try { this.panel.webview.postMessage(message); } catch { /* gone */ }
  }

  reveal() {
    this.visible = true;
    try { this.panel.reveal(vscode.ViewColumn.Beside, true); } catch { /* gone */ }
  }

  /**
   * Put the panel behind the file rather than beside it.
   *
   * Closing the tab would dispose the webview and stop the audio with it, so
   * instead focus is handed straight back to the file. The panel keeps
   * playing in the background; `retainContextWhenHidden` is what allows that.
   */
  hide() {
    // Closing the tab would dispose the webview and stop the audio with it,
    // so the file is simply brought back to the front. The panel keeps
    // playing behind it; `retainContextWhenHidden` is what allows that.
    try {
      const editor = vscode.window.activeTextEditor || vscode.window.visibleTextEditors[0];
      if (editor) {
        vscode.window.showTextDocument(editor.document, {
          viewColumn: editor.viewColumn,
          preserveFocus: false,
          preview: false,
        });
        return;
      }
      // Reading from a Markdown preview there is no editor to go back to, and
      // leaving it there would put the player in front of the very thing being
      // read. Focus is handed to the previous tab instead.
      vscode.commands.executeCommand("workbench.action.previousEditor");
    } catch { /* nothing to go back to */ }
  }

  dispose() {
    try { this.panel.dispose(); } catch { /* already gone */ }
  }
}

module.exports = { Player, VIEW_TYPE };
