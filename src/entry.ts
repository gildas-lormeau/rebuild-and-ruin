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
// --- Music asset loading (home page) ---
const MUSIC_URL_STORAGE_KEY = "castles99_music_url";
const musicSourceUrlInput = document.getElementById(
  "music-source-url",
) as HTMLInputElement;
const musicLoadButton = document.getElementById(
  "btn-music-load",
) as HTMLButtonElement;
const musicPickButton = document.getElementById(
  "btn-music-pick",
) as HTMLButtonElement;
const musicFilePicker = document.getElementById(
  "music-file-picker",
) as HTMLInputElement;
const musicStatus = document.getElementById(
  "music-status",
) as HTMLOutputElement;

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
  navigateTo(ROUTE_PLAY);
});

document.getElementById("btn-online")!.addEventListener(CLICK_EVENT, () => {
  navigateTo(ROUTE_ONLINE);
});

// Persist server host
serverHostInput.addEventListener("change", () => {
  const val = serverHostInput.value.trim();
  if (val) localStorage.setItem(SERVER_STORAGE_KEY, val);
  else localStorage.removeItem(SERVER_STORAGE_KEY);
});

void import("./runtime/music-assets.ts").then(
  ({ DEFAULT_ARCHIVE_URL, listStoredAssets }) => {
    musicSourceUrlInput.value =
      localStorage.getItem(MUSIC_URL_STORAGE_KEY) || DEFAULT_ARCHIVE_URL;
    void listStoredAssets().then((status) => {
      const missing = status.filter((entry) => !entry.present).length;
      musicStatus.textContent =
        missing === 0
          ? `Music files loaded (${status.length} files in browser storage).`
          : `Music not loaded — ${missing} of ${status.length} files missing.`;
    });
  },
);

musicSourceUrlInput.addEventListener("change", () => {
  const val = musicSourceUrlInput.value.trim();
  if (val) localStorage.setItem(MUSIC_URL_STORAGE_KEY, val);
  else localStorage.removeItem(MUSIC_URL_STORAGE_KEY);
});

musicLoadButton.addEventListener(CLICK_EVENT, () => {
  void handleMusicLoadFromUrl();
});

musicPickButton.addEventListener(CLICK_EVENT, () => musicFilePicker.click());

musicFilePicker.addEventListener("change", () => {
  void handleMusicLoadFromFiles();
});

async function handleMusicLoadFromUrl(): Promise<void> {
  const url = musicSourceUrlInput.value.trim();
  if (!url) {
    musicStatus.textContent = "Please enter a URL.";
    return;
  }
  musicStatus.textContent = `Fetching ${url} …`;
  musicLoadButton.disabled = true;
  try {
    const { fetchAndStoreFromArchive } = await import(
      "./runtime/music-assets.ts"
    );
    const result = await fetchAndStoreFromArchive(url);
    reportMusicResult(result);
  } catch (error) {
    musicStatus.textContent = `Load failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    musicLoadButton.disabled = false;
  }
}

async function handleMusicLoadFromFiles(): Promise<void> {
  const files = musicFilePicker.files;
  if (!files?.length) return;
  musicStatus.textContent = `Saving ${files.length} file(s) …`;
  try {
    const { storeAssets } = await import("./runtime/music-assets.ts");
    const result = await storeAssets(Array.from(files));
    reportMusicResult(result);
  } catch (error) {
    musicStatus.textContent = `Save failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    musicFilePicker.value = "";
  }
}

function reportMusicResult(result: {
  accepted: readonly string[];
  rejected: readonly { name: string; reason: string }[];
  missing: readonly string[];
}): void {
  const parts: string[] = [];
  if (result.accepted.length) {
    parts.push(`Saved ${result.accepted.length} file(s).`);
  }
  if (result.missing.length) {
    parts.push(`Still missing: ${result.missing.join(", ")}.`);
  }
  if (result.rejected.length) {
    parts.push(
      `Rejected: ${result.rejected.map((entry) => `${entry.name} (${entry.reason})`).join("; ")}.`,
    );
  }
  if (!result.missing.length && !result.rejected.length) {
    parts.push("Music is ready — click Local Play to hear it.");
  }
  musicStatus.textContent = parts.join(" ");
}

// Fullscreen on Create/Join confirm (needs user gesture — click for mobile compat)
document
  .getElementById("btn-create-confirm")!
  .addEventListener(CLICK_EVENT, tryFullscreen);

document
  .getElementById("btn-join-confirm")!
  .addEventListener(CLICK_EVENT, tryFullscreen);

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
