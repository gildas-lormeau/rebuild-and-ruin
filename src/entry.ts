/**
 * Application entry point — SPA router, fullscreen, auto-join, service worker.
 *
 * Hash-based routing (`#/`, `#/online`, `#/play`) with native back button support.
 * Route handlers load game modules on demand; game-exit cleanup runs when
 * the router navigates away from an active game.
 */

import "./style.css";
import {
  GAME_CONTAINER_ACTIVE,
  GAME_EXIT_EVENT,
  initRouter,
  navigateTo,
  onRoute,
} from "./online/online-router.ts";
import { ROUTE_HOME, ROUTE_ONLINE, ROUTE_PLAY } from "./protocol/routes.ts";
import { IS_TOUCH_DEVICE } from "./shared/platform/platform.ts";

const DEFAULT_SERVER = "rebuild-and-ruin.gildas-lormeau.deno.net";
const SERVER_STORAGE_KEY = "castles99_server";
const CLICK_EVENT = "click";
const gameContainer = document.getElementById("game-container")!;
const serverHostInput = document.getElementById(
  "server-host",
) as HTMLInputElement;
const params = new URLSearchParams(location.search);
const autoJoinCode = params.get("join");

// Flips to true when the user clicks "Local Play" — the click both activates
// the AudioContext (needs a user gesture) and enters #/play. A direct hit on
// `/#play` (bookmark, reload, shared link) would bypass that gesture, so we
// redirect those visits to the home page.
let userInitiatedPlay = false;

// Lock to landscape on mobile (best-effort, silently ignored if unsupported)
try {
  (
    screen.orientation as unknown as {
      lock?: (orientation: string) => Promise<void>;
    }
  )
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
  if (!userInitiatedPlay) {
    // Direct entry (bookmark, reload, shared link) — bounce back home so the
    // visitor has to click "Local Play", which is the only place we get a user
    // gesture to unlock the AudioContext before music boot.
    navigateTo(ROUTE_HOME, true);
    return;
  }
  userInitiatedPlay = false; // consume; require a fresh gesture on the next entry
  tryFullscreen(); // works when navigated via user gesture; silently fails on bookmark
  // Fallback: first tap on any game UI button triggers fullscreen
  gameContainer.addEventListener(CLICK_EVENT, () => tryFullscreen(), {
    once: true,
    capture: true,
  });
  void import("./main.ts").then((module) => module.enterLocalLobby());
});

onRoute(ROUTE_HOME, () => {
  exitGameIfActive();
});

initRouter();

// --- Navigation handlers ---
document.getElementById("btn-local")!.addEventListener(CLICK_EVENT, () => {
  tryFullscreen();
  // Kick off the music sub-system's audio/WASM boot inside this user-gesture
  // window — once the dynamic import resolves the gesture is stale for
  // AudioContext.resume(). Safe to call even if no Rampart files are in IDB
  // (subsystem no-ops). Fire-and-forget: audio is optional, never block nav.
  void import("./main.ts").then((module) => module.activateMusic());
  userInitiatedPlay = true;
  navigateTo(ROUTE_PLAY);
});

document.getElementById("btn-online")!.addEventListener(CLICK_EVENT, () => {
  activateOnlineAudio();
  navigateTo(ROUTE_ONLINE);
});

// Persist server host
serverHostInput.addEventListener("change", () => {
  const val = serverHostInput.value.trim();
  if (val) localStorage.setItem(SERVER_STORAGE_KEY, val);
  else localStorage.removeItem(SERVER_STORAGE_KEY);
});

// Fullscreen + audio boot on Create/Join confirm (needs user gesture — click for mobile compat)
document
  .getElementById("btn-create-confirm")!
  .addEventListener(CLICK_EVENT, () => {
    tryFullscreen();
    activateOnlineAudio();
  });

document
  .getElementById("btn-join-confirm")!
  .addEventListener(CLICK_EVENT, () => {
    tryFullscreen();
    activateOnlineAudio();
  });

// --- Auto-join via QR code: ?join=XXXX&server=host ---
if (autoJoinCode) {
  tryFullscreen(); // call synchronously — QR tap navigation preserves user activation
  activateOnlineAudio();
  void (async () => {
    navigateTo(ROUTE_ONLINE, true);
    const { lobbyReady } = await import("./online-client.ts");
    const { joinRoom } = await lobbyReady;
    joinRoom(autoJoinCode.toUpperCase());
  })();
}

// Kick off audio boot inside the click's user-gesture window — same rationale
// as btn-local's activateMusic call. online-client.ts lazy-loads the online
// runtime; once resolved, activateAudio warms the music synth + SFX context.
// Wired to every online entry point (create, join, QR auto-join) as a
// belt-and-suspenders: any of them is a fresh gesture the browser accepts
// for AudioContext.resume().
function activateOnlineAudio(): void {
  void import("./online-client.ts").then((module) => module.activateAudio());
}

if (params.has("record-inputs")) {
  void import("./input/input-recorder.ts").then((module) =>
    module.initRecorder(),
  );
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
