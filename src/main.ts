/**
 * Local play entry point.
 *
 * All game logic lives in runtime.ts (shared with online-client.ts).
 * This file only provides the local-specific config: no networking, canvas
 * lobby with direct slot joining, and the loadAtlas entry point.
 */

import { LOBBY_TIMER } from "./game-constants.ts";
import { MAX_PLAYERS } from "./player-config.ts";
import { createCanvasRenderer } from "./render-canvas.ts";
import { loadAtlas } from "./render-sprites.ts";
import { GAME_CONTAINER_ACTIVE, GAME_EXIT_EVENT } from "./router.ts";
import { createGameRuntime } from "./runtime.ts";
import { Mode } from "./types.ts";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = createCanvasRenderer(canvas);
const emptySet = new Set<number>();
const runtime = createGameRuntime({
  renderer,
  send: () => {},
  getIsHost: () => true,
  getMyPlayerId: () => -1,
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
    Math.max(0, LOBBY_TIMER - (runtime.rs.lobby.timerAccum ?? 0)),
  showLobby,
  onLobbySlotJoined: (pid) => {
    runtime.rs.lobby.joined[pid] = true;
    runtime.lobby.renderLobby();
  },
  onCloseOptions: () => {
    runtime.rs.lobby.timerAccum = 0; // reset countdown after settings
  },
  onTickLobbyExpired: () => {
    runtime.lifecycle.startGame();
    runtime.rs.mode = Mode.SELECTION;
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
  runtime.rs.mode = Mode.STOPPED;
});

function showLobby(): void {
  const lobby = runtime.rs.lobby;
  lobby.joined = new Array(MAX_PLAYERS).fill(false);
  lobby.active = true;
  lobby.timerAccum = 0;
  lobby.map = null; // force fresh seed + map preview
  runtime.rs.quitPending = false;
  runtime.rs.optionsReturnMode = null;
  runtime.lobby.renderLobby();
  runtime.rs.mode = Mode.LOBBY;
  runtime.rs.lastTime = performance.now();
  requestAnimationFrame(runtime.mainLoop);
}
