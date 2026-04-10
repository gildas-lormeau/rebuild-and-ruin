/**
 * Local play entry point.
 *
 * All game logic lives in runtime.ts (shared with online-client.ts).
 * This file only provides the local-specific config: no networking, canvas
 * lobby with direct slot joining, and the loadAtlas entry point.
 */

import { aiPickUpgrade } from "./ai/ai-upgrade-pick.ts";
import { createCanvasRenderer } from "./render/render-canvas.ts";
import { loadAtlas } from "./render/render-sprites.ts";
import { createGameRuntime } from "./runtime/runtime.ts";
import { createBrowserTimingApi } from "./runtime/runtime-browser-timing.ts";
import { resetFrameTiming, setMode } from "./runtime/runtime-state.ts";
import { LOBBY_TIMER } from "./shared/game-constants.ts";
import { MAX_PLAYERS } from "./shared/player-config.ts";
import { SPECTATOR_SLOT } from "./shared/player-slot.ts";
import { GAME_CONTAINER_ACTIVE, GAME_EXIT_EVENT } from "./shared/router.ts";
import { Mode } from "./shared/ui-mode.ts";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = createCanvasRenderer(canvas);
const emptySet = new Set<number>();
/** Production timing bindings — entry-point layer is the only place where
 *  browser globals are touched directly. Sub-systems receive these via
 *  `RuntimeConfig.timing` rather than reaching for `performance.now()`,
 *  `globalThis.setTimeout`, or `requestAnimationFrame` themselves. */
const timing = createBrowserTimingApi();
const runtime = createGameRuntime({
  renderer,
  timing,
  keyboardEventSource: document,
  send: () => {},
  aiPick: aiPickUpgrade,
  getIsHost: () => true,
  getMyPlayerId: () => SPECTATOR_SLOT,
  getRemotePlayerSlots: () => emptySet,
  // @ts-ignore — import.meta.env is Vite-specific
  log: import.meta.env?.DEV
    ? (msg: string) => console.log(`[local] ${msg}`)
    : () => {},
  // @ts-ignore — import.meta.env is Vite-specific
  logThrottled: import.meta.env?.DEV
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
const atlasReady = loadAtlas().catch((e) => {
  console.warn("[local] sprite atlas failed to load:", e);
});

/** Enter the local lobby. Waits for sprite atlas on first call. */
export function enterLocalLobby(): void {
  renderer.container.classList.add(GAME_CONTAINER_ACTIVE);
  void atlasReady.then(() => showLobby());
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
}
