/**
 * Local play entry point.
 *
 * All game logic lives in runtime.ts (shared with online-client.ts).
 * This file only provides the local-specific config: no networking, canvas
 * lobby with direct slot joining, and the loadAtlas entry point.
 */

import { LOBBY_TIMER, SPECTATOR_SLOT } from "./game-constants.ts";
import { MAX_PLAYERS } from "./player-config.ts";
import { GAME_CONTAINER_ACTIVE, GAME_EXIT_EVENT } from "./router.ts";
import { createGameRuntime } from "./runtime.ts";
import { createCanvasRenderer, loadAtlas } from "./runtime-bootstrap.ts";
import { Mode } from "./types.ts";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = createCanvasRenderer(canvas);
const emptySet = new Set<number>();
const runtime = createGameRuntime({
  renderer,
  send: () => {},
  getIsHost: () => true,
  getMyPlayerId: () => SPECTATOR_SLOT,
  getRemoteHumanSlots: () => emptySet,
  // @ts-ignore — import.meta.env is Vite-specific
  log: import.meta.env?.DEV
    ? (msg: string) => console.log(`[local] ${msg}`)
    : () => {},
  // @ts-ignore — import.meta.env is Vite-specific
  logThrottled: import.meta.env?.DEV
    ? (() => {
        const ts = new Map<string, number>();
        return (key: string, msg: string) => {
          const now = performance.now();
          if (now - (ts.get(key) ?? 0) < 1000) return;
          ts.set(key, now);
          console.log(`[local] ${msg}`);
        };
      })()
    : () => {},
  getLobbyRemaining: () =>
    Math.max(0, LOBBY_TIMER - (runtime.runtimeState.lobby.timerAccum ?? 0)),
  showLobby,
  onLobbySlotJoined: (pid) => {
    runtime.runtimeState.lobby.joined[pid] = true;
    runtime.lobby.renderLobby();
  },
  onCloseOptions: () => {
    runtime.runtimeState.lobby.timerAccum = 0; // reset countdown after settings
  },
  onTickLobbyExpired: () => {
    runtime.lifecycle.startGame();
    runtime.runtimeState.mode = Mode.SELECTION;
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

runtime.registerInputHandlers();

document.addEventListener(GAME_EXIT_EVENT, () => {
  runtime.runtimeState.mode = Mode.STOPPED;
});

function showLobby(): void {
  const lobby = runtime.runtimeState.lobby;
  lobby.joined = new Array(MAX_PLAYERS).fill(false);
  lobby.active = true;
  lobby.timerAccum = 0;
  lobby.map = null; // force fresh seed + map preview
  runtime.runtimeState.quitPending = false;
  runtime.runtimeState.optionsReturnMode = null;
  runtime.lobby.renderLobby();
  runtime.runtimeState.mode = Mode.LOBBY;
  runtime.runtimeState.lastTime = performance.now();
  requestAnimationFrame(runtime.mainLoop);
}
