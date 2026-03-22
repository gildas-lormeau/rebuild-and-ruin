/**
 * Local play entry point.
 *
 * All game logic lives in game-runtime.ts (shared with online-client.ts).
 * This file only provides the local-specific config: no networking, canvas
 * lobby with direct slot joining, and the loadAtlas entry point.
 */

import { LOBBY_TIMER } from "./types.ts";
import { loadAtlas } from "./sprites.ts";
import { Mode } from "./game-ui-types.ts";
import { MAX_PLAYERS } from "./player-config.ts";
import { createGameRuntime } from "./game-runtime.ts";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
canvas.style.display = "block";

// ---------------------------------------------------------------------------
// Runtime — local play config (no networking)
// ---------------------------------------------------------------------------

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
  getLobbyRemaining: () => Math.max(0, LOBBY_TIMER - (runtime.getLobby().timerAccum ?? 0)),
  showLobby,
  onLobbySlotJoined: (pid) => {
    runtime.getLobby().joined[pid] = true;
    runtime.renderLobby();
  },
  onCloseOptions: () => {
    runtime.getLobby().timerAccum = 0; // reset countdown after settings
  },
  onTickLobbyExpired: () => {
    runtime.startGame();
    runtime.setMode(Mode.SELECTION);
  },
});

// ---------------------------------------------------------------------------
// Local lobby — canvas-based, no room creation step
// ---------------------------------------------------------------------------

function showLobby(): void {
  const lobby = runtime.getLobby();
  lobby.joined = new Array(MAX_PLAYERS).fill(false);
  lobby.active = true;
  lobby.timerAccum = 0;
  runtime.setQuitPending(false);
  runtime.setOptionsReturnMode(null);
  runtime.renderLobby();
  runtime.setMode(Mode.LOBBY);
  runtime.setLastTime(performance.now());
  requestAnimationFrame(runtime.mainLoop);
}

// ---------------------------------------------------------------------------
// Wire up input handlers and start
// ---------------------------------------------------------------------------

runtime.registerInputHandlers();

loadAtlas().then(
  () => showLobby(),
  () => showLobby(),
);
