/**
 * Application entry point — SPA router, fullscreen, auto-join, service worker.
 *
 * Hash-based routing (`#/`, `#/online`, `#/play`) with native back button support.
 * Route handlers load game modules on demand; game-exit cleanup runs when
 * the router navigates away from an active game.
 */

import "./style.css";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import {
  GAME_CONTAINER_ACTIVE,
  GAME_EXIT_EVENT,
  initRouter,
  navigateTo,
  onRoute,
} from "./router.ts";

const DEFAULT_SERVER = "rebuild-and-ruin.gildas-lormeau.deno.net";
const SERVER_STORAGE_KEY = "castles99_server";
const ROUTE_ONLINE = "/online";
const ROUTE_PLAY = "/play";
const gameContainer = document.getElementById("game-container")!;
const serverHostInput = document.getElementById(
  "server-host",
) as HTMLInputElement;
const params = new URLSearchParams(location.search);
const autoJoinCode = params.get("join");

// Lock to landscape on mobile (best-effort, silently ignored if unsupported)
try {
  (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })
    ?.lock?.("landscape")
    .catch(() => {});
} catch {
  /* unsupported */
}

// --- Route handlers ---
onRoute(ROUTE_ONLINE, () => {
  exitGameIfActive();
  serverHostInput.value =
    localStorage.getItem(SERVER_STORAGE_KEY) || DEFAULT_SERVER;
  void import("./online-client.ts");
});

onRoute(ROUTE_PLAY, () => {
  // Fullscreen requires a user gesture — defer to first tap if navigated via bookmark.
  // Use touchstart (click doesn't fire on canvas on mobile) with capture to
  // intercept before child stopPropagation.
  gameContainer.addEventListener("touchstart", () => tryFullscreen(), {
    once: true,
    capture: true,
  });
  void import("./main.ts").then((m) => m.enterLocalLobby());
});

onRoute("/", () => {
  exitGameIfActive();
});

initRouter();

// --- Navigation handlers ---
document.getElementById("btn-local")!.addEventListener("click", () => {
  tryFullscreen();
  navigateTo(ROUTE_PLAY);
});

document.getElementById("btn-online")!.addEventListener("click", () => {
  navigateTo(ROUTE_ONLINE);
});

// Persist server host
serverHostInput.addEventListener("change", () => {
  const val = serverHostInput.value.trim();
  if (val) localStorage.setItem(SERVER_STORAGE_KEY, val);
  else localStorage.removeItem(SERVER_STORAGE_KEY);
});

// Fullscreen on Create/Join submit (needs user gesture)
document
  .getElementById("form-create")!
  .addEventListener("submit", tryFullscreen);

document.getElementById("form-join")!.addEventListener("submit", tryFullscreen);

// --- Auto-join via QR code: ?join=XXXX&server=host ---
if (autoJoinCode) {
  tryFullscreen(); // call synchronously — QR tap navigation preserves user activation
  void (async () => {
    navigateTo(ROUTE_ONLINE, true);
    const { lobbyReady } = await import("./online-client.ts");
    const { joinRoom } = await lobbyReady;
    joinRoom(autoJoinCode.toUpperCase());
  })();
}

if (params.has("record-inputs")) {
  void import("./input-recorder.ts").then((m) => m.initRecorder());
}

/** Hide the game container and notify game modules to clean up. */
function exitGameIfActive(): void {
  if (gameContainer.classList.contains(GAME_CONTAINER_ACTIVE)) {
    gameContainer.classList.remove(GAME_CONTAINER_ACTIVE);
    document.dispatchEvent(new Event(GAME_EXIT_EVENT));
  }
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
