/**
 * Local play entry point.
 *
 * All game logic lives in runtime-composition.ts (shared with online-client.ts).
 * This file only provides the local-specific config: no networking, canvas
 * lobby with direct slot joining.
 */

import {
  GAME_CONTAINER_ACTIVE,
  GAME_EXIT_EVENT,
} from "./online/online-router.ts";
import {
  createBrowserRuntimeBindings,
  createGameRuntime,
  createLocalNetworkApi,
  noopNetworkSend,
} from "./runtime/runtime-composition.ts";
import { resetFrameTiming, setMode } from "./runtime/runtime-state.ts";
import { LOBBY_TIMER } from "./shared/core/game-constants.ts";
import { IS_DEV } from "./shared/platform/platform.ts";
import { Mode } from "./shared/ui/ui-mode.ts";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const worldCanvas = document.getElementById(
  "world-canvas",
) as HTMLCanvasElement;
const { renderer, timing, keyboardEventSource } = createBrowserRuntimeBindings(
  canvas,
  worldCanvas,
);
const runtime = createGameRuntime({
  renderer,
  timing,
  keyboardEventSource,
  // Pure-local play has no peers to notify — pass the explicit named
  // no-op so the absence of a real sender is intentional and visible.
  network: createLocalNetworkApi({ send: noopNetworkSend }),
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
  onLobbySlotJoined: (pid) => runtime.lobby.markJoined(pid),
  onCloseOptions: () => {
    runtime.runtimeState.lobby.timerAccum = 0; // reset countdown after settings
  },
  onTickLobbyExpired: async () => {
    await runtime.lifecycle.startGame();
    setMode(runtime.runtimeState, Mode.SELECTION);
  },
});

/** Enter the local lobby. */
export function enterLocalLobby(): void {
  renderer.container.classList.add(GAME_CONTAINER_ACTIVE);
  // Fire-and-forget: music is optional and should never block the lobby
  // render. If assets aren't loaded or the synth fails, we play silently.
  void runtime.music.startTitle();
  showLobby();
}

/** Pre-warm both audio sub-systems (music WASM + SFX AudioContext). Must be
 *  called from a user-gesture handler — the home-page "Play" button — otherwise
 *  browsers refuse to resume the AudioContext. No-op if the player hasn't
 *  dropped their Rampart files into IndexedDB yet. */
export async function activateMusic(): Promise<void> {
  await Promise.all([runtime.music.activate(), runtime.sfx.activate()]);
}

// Back-button / hash navigation away from /play: stop the active bg
// track + any in-flight SFX, set mode to STOPPED. Shared with the
// online entry — see runtime.shutdown in runtime-composition.ts.
document.addEventListener(GAME_EXIT_EVENT, runtime.shutdown);

function showLobby(): void {
  runtime.lobby.show();
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
