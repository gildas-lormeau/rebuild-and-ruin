/**
 * Local play entry point.
 *
 * All game logic lives in game-runtime.ts (shared with online-client.ts).
 * This file only provides the local-specific config: no networking, canvas
 * lobby with direct slot joining, and the loadAtlas entry point.
 */

import { createGameRuntime } from "./game-runtime.ts";
import { GAME_CONTAINER_ACTIVE, Mode } from "./game-ui-types.ts";
import { MAX_PLAYERS } from "./player-config.ts";
import { loadAtlas } from "./sprites.ts";
import { LOBBY_TIMER } from "./types.ts";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const emptySet = new Set<number>();
const runtime = createGameRuntime({
  canvas,
  send: () => {},
  getIsHost: () => true,
  getMyPlayerId: () => -1,
  getRemoteHumanSlots: () => emptySet,
  // @ts-ignore — import.meta.env is Vite-specific
  log: import.meta.env?.DEV ? (msg: string) => console.log(`[local] ${msg}`) : () => {},
  // @ts-ignore
  logThrottled: import.meta.env?.DEV ? (() => { const ts = new Map<string, number>(); return (key: string, msg: string) => { const now = performance.now(); if (now - (ts.get(key) ?? 0) < 1000) return; ts.set(key, now); console.log(`[local] ${msg}`); }; })() : () => {},
  getLobbyRemaining: () => Math.max(0, LOBBY_TIMER - (runtime.rs.lobby.timerAccum ?? 0)),
  showLobby,
  onLobbySlotJoined: (pid) => {
    runtime.rs.lobby.joined[pid] = true;
    runtime.renderLobby();
  },
  onCloseOptions: () => {
    runtime.rs.lobby.timerAccum = 0; // reset countdown after settings
  },
  onTickLobbyExpired: () => {
    runtime.startGame();
    runtime.rs.mode = Mode.SELECTION;
  },
});

canvas.parentElement!.classList.add(GAME_CONTAINER_ACTIVE);

runtime.registerInputHandlers();

loadAtlas().then(
  () => showLobby(),
  () => showLobby(),
);

function showLobby(): void {
  const lobby = runtime.rs.lobby;
  lobby.joined = new Array(MAX_PLAYERS).fill(false);
  lobby.active = true;
  lobby.timerAccum = 0;
  runtime.rs.quitPending = false;
  runtime.rs.optionsReturnMode = null;
  runtime.renderLobby();
  runtime.rs.mode = Mode.LOBBY;
  runtime.rs.lastTime = performance.now();
  requestAnimationFrame(runtime.mainLoop);
}
