/**
 * Local play entry point.
 *
 * All game logic lives in runtime-composition.ts (shared with online-client.ts).
 * This file only provides the local-specific config: no networking, canvas
 * lobby with direct slot joining, and the loadAtlas entry point.
 */

import {
  GAME_CONTAINER_ACTIVE,
  GAME_EXIT_EVENT,
} from "./online/online-router.ts";
import { loadAtlas } from "./render/render-sprites.ts";
import {
  createBrowserRuntimeBindings,
  createGameRuntime,
  createLocalNetworkApi,
} from "./runtime/runtime-composition.ts";
import { resetFrameTiming, setMode } from "./runtime/runtime-state.ts";
import { LOBBY_TIMER } from "./shared/core/game-constants.ts";
import { IS_DEV } from "./shared/platform/platform.ts";
import { MAX_PLAYERS } from "./shared/ui/player-config.ts";
import { Mode } from "./shared/ui/ui-mode.ts";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const { renderer, timing, keyboardEventSource } =
  createBrowserRuntimeBindings(canvas);
const atlasReady = loadAtlas().catch((e) => {
  console.warn("[local] sprite atlas failed to load:", e);
});
const runtime = createGameRuntime({
  renderer,
  timing,
  keyboardEventSource,
  network: createLocalNetworkApi(),
  log: IS_DEV ? (msg: string) => console.log(`[local] ${msg}`) : () => {},
  logThrottled: IS_DEV
    ? (() => {
        const timestamps = new Map<string, number>();
        return (key: string, msg: string) => {
          const now = performance.now();
          if (now - (timestamps.get(key) ?? 0) < 1000) return;
          timestamps.set(key, now);
          console.log(`[local] ${msg}`);
        };
      })()
    : () => {},
  // Local lobby timer: accumulator counting UP, remaining = max - accum.
  // Online lobby timer (online-runtime-game.ts) uses wall-clock subtraction instead,
  // because the server provides an absolute countdown and elapsed offset.
  getLobbyRemaining: () =>
    Math.max(0, LOBBY_TIMER - (runtime.runtimeState.lobby.timerAccum ?? 0)),
  getUrlRoundsOverride: () => {
    const param = new URL(location.href).searchParams.get("rounds");
    return param ? Number(param) : 0;
  },
  getUrlModeOverride: () =>
    new URL(location.href).searchParams.get("mode") ?? "",
  showLobby,
  onLobbySlotJoined: (pid) => {
    runtime.runtimeState.lobby.joined[pid] = true;
    runtime.lobby.renderLobby();
  },
  onCloseOptions: () => {
    runtime.runtimeState.lobby.timerAccum = 0; // reset countdown after settings
  },
  onTickLobbyExpired: async () => {
    await runtime.lifecycle.startGame();
    setMode(runtime.runtimeState, Mode.SELECTION);
  },
});

/** Enter the local lobby. Waits for sprite atlas on first call. */
export function enterLocalLobby(): void {
  renderer.container.classList.add(GAME_CONTAINER_ACTIVE);
  // Fire-and-forget: music is optional and should never block the lobby
  // render. If assets aren't loaded or the synth fails, we play silently.
  void runtime.music.startTitle();
  void atlasReady.then(() => showLobby());
}

/** Pre-warm both audio sub-systems (music WASM + SFX AudioContext). Must be
 *  called from a user-gesture handler — the home-page "Play" button — otherwise
 *  browsers refuse to resume the AudioContext. No-op if the player hasn't
 *  dropped their Rampart files into IndexedDB yet. */
export function activateMusic(): Promise<void> {
  return Promise.all([runtime.music.activate(), runtime.sfx.activate()]).then(
    () => {},
  );
}

document.addEventListener(GAME_EXIT_EVENT, () => {
  setMode(runtime.runtimeState, Mode.STOPPED);
});

function showLobby(): void {
  const lobby = runtime.runtimeState.lobby;
  lobby.joined = new Array(MAX_PLAYERS).fill(false);
  lobby.active = true;
  lobby.timerAccum = 0;
  lobby.map = null; // force fresh seed + map preview
  runtime.runtimeState.quit.pending = false;
  runtime.runtimeState.optionsUI.returnMode = null;
  runtime.lobby.renderLobby();
  setMode(runtime.runtimeState, Mode.LOBBY);
  resetFrameTiming(runtime.runtimeState, timing.now());
  timing.requestFrame(runtime.mainLoop);
  // Title music: harmless redundant call on first entry (startTitle is
  // idempotent — it's also kicked off earlier in enterLocalLobby before
  // the atlas is ready). Load-bearing for post-game returns — the
  // previous game stopped the title on `castlePlaced`, and nothing
  // else restarts it when the player hits "Menu" on the game-over
  // screen or the all-AI demo timer auto-returns.
  void runtime.music.startTitle();
}
