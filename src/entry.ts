/**
 * Application entry point — SPA router, fullscreen, auto-join, service worker.
 *
 * Hash-based routing (`#/`, `#/online`) with native back button support.
 */

import "./style.css";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import { getRoute, initRouter, navigateTo } from "./router.ts";

const AUTO_JOIN_DELAY_MS = 300;
const DEFAULT_SERVER = "rebuild-and-ruin.gildas-lormeau.deno.net";
const SERVER_STORAGE_KEY = "castles99_server";
const ROUTE_ONLINE = "/online";
const ROUTE_PLAY = "/play";
const btnLocal = document.getElementById("btn-local")!;
const btnOnline = document.getElementById("btn-online")!;
const serverHostInput = document.getElementById("server-host") as HTMLInputElement;
const params = new URLSearchParams(location.search);
const autoJoinCode = params.get("join");

// Load the right module whenever the route is active
let lastAppliedRoute = "";

// Lock to landscape on mobile (best-effort, silently ignored if unsupported)
try { (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape").catch(() => {}); } catch { /* unsupported */ }

// --- Router setup ---
initRouter();

onRouteChange();

window.addEventListener("hashchange", onRouteChange);

window.addEventListener("popstate", onRouteChange);

// --- Navigation handlers ---
btnLocal.addEventListener("click", () => {
  tryFullscreen();
  navigateTo("/play");
  onRouteChange();
});

btnOnline.addEventListener("click", () => {
  navigateTo(ROUTE_ONLINE);
  onRouteChange();
});

function onRouteChange(): void {
  const route = getRoute();
  if (route === lastAppliedRoute) return;
  lastAppliedRoute = route;
  if (route === ROUTE_ONLINE) {
    serverHostInput.value = localStorage.getItem(SERVER_STORAGE_KEY) || DEFAULT_SERVER;
    import("./online-client.ts");
  } else if (route === ROUTE_PLAY) {
    import("./main.ts").then(m => m.enterLocalLobby());
  }
}

// Persist server host
serverHostInput.addEventListener("change", () => {
  const val = serverHostInput.value.trim();
  if (val) localStorage.setItem(SERVER_STORAGE_KEY, val);
  else localStorage.removeItem(SERVER_STORAGE_KEY);
});

// Fullscreen on Create/Join confirm (needs user gesture)
document.getElementById("btn-create-confirm")!.addEventListener("click", tryFullscreen);

document.getElementById("btn-join-confirm")!.addEventListener("click", tryFullscreen);

// --- Auto-join via QR code: ?join=XXXX&server=host ---
if (autoJoinCode) {
  (async () => {
    navigateTo(ROUTE_ONLINE, true);
    await import("./online-client.ts");
    const joinCodeInput = document.getElementById("join-code") as HTMLInputElement;
    const btnJoinConfirm = document.getElementById("btn-join-confirm")!;
    joinCodeInput.value = autoJoinCode.toUpperCase();
    setTimeout(() => { tryFullscreen(); btnJoinConfirm.click(); }, AUTO_JOIN_DELAY_MS);
  })();
}

if (params.has("record-inputs")) {
  import("./input-recorder.ts").then(m => m.initRecorder());
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
