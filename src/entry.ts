/**
 * Application entry point — mode selection, fullscreen, auto-join, service worker.
 *
 * Extracted from the inline <script> in index.html so it benefits from
 * TypeScript checking and the lint pipeline.
 */

import "./style.css";
import { IS_TOUCH_DEVICE } from "./platform.ts";

const AUTO_JOIN_DELAY_MS = 300;
const DEFAULT_SERVER = "rebuild-and-ruin.gildas-lormeau.deno.net";
const SERVER_STORAGE_KEY = "castles99_server";
const modeSelect = document.getElementById("mode-select")!;
const btnLocal = document.getElementById("btn-local")!;
const btnOnline = document.getElementById("btn-online")!;
const btnOnlineBack = document.getElementById("btn-online-back")!;
const lobby = document.getElementById("lobby")!;
const serverHostInput = document.getElementById("server-host") as HTMLInputElement;
const params = new URLSearchParams(location.search);
// Auto-join via QR code: ?join=XXXX&server=host
const autoJoinCode = params.get("join");

// Lock to landscape on mobile (best-effort, silently ignored if unsupported)
try { (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape").catch(() => {}); } catch { /* unsupported */ }

btnLocal.addEventListener("click", async () => {
  tryFullscreen();
  modeSelect.style.display = "none";
  await import("./main.ts");
});

// Persist server host
serverHostInput.addEventListener("change", () => {
  const val = serverHostInput.value.trim();
  if (val) localStorage.setItem(SERVER_STORAGE_KEY, val);
  else localStorage.removeItem(SERVER_STORAGE_KEY);
});

btnOnline.addEventListener("click", async () => {
  serverHostInput.value = localStorage.getItem(SERVER_STORAGE_KEY) || DEFAULT_SERVER;
  modeSelect.style.display = "none";
  lobby.style.display = "block";
  await import("./online-client.ts");
});

// Fullscreen on Create/Join confirm (needs user gesture)
document.getElementById("btn-create-confirm")!.addEventListener("click", tryFullscreen);

document.getElementById("btn-join-confirm")!.addEventListener("click", tryFullscreen);

btnOnlineBack.addEventListener("click", () => {
  lobby.style.display = "none";
  modeSelect.style.display = "block";
});

if (params.has("record-inputs")) {
  import("./input-recorder.ts").then(m => m.initRecorder());
}

if (autoJoinCode) {
  (async () => {
    modeSelect.style.display = "none";
    lobby.style.display = "block";
    await import("./online-client.ts");
    const joinCodeInput = document.getElementById("join-code") as HTMLInputElement;
    const btnJoinShow = document.getElementById("btn-join-show")!;
    const btnJoinConfirm = document.getElementById("btn-join-confirm")!;
    btnJoinShow.click();
    joinCodeInput.value = autoJoinCode.toUpperCase();
    setTimeout(() => { tryFullscreen(); btnJoinConfirm.click(); }, AUTO_JOIN_DELAY_MS);
  })();
}

/** Request fullscreen + wake lock on mobile (must be called from a user gesture handler). */
function tryFullscreen(): void {
  if (!IS_TOUCH_DEVICE) return;
  if (location.port) return; // skip in dev mode
  document.documentElement.requestFullscreen?.().catch(() => {});
  navigator.wakeLock?.request?.("screen").catch(() => {});
}

if ("serviceWorker" in navigator && !location.port) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
