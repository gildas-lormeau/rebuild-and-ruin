/**
 * Shared headless simulation helpers used by headless-test and headless-build.
 */

import { generateMap } from "./map-generation.ts";
import {
  createGameState,
  nextPhase,
  rebuildHomeCastle,
  markPlayerReselected,
  enterCastleReselectPhase,
} from "./game-engine.ts";
import { createController } from "./player-controller.ts";
import type { PlayerController } from "./player-controller.ts";
import { PLAYER_KEY_BINDINGS } from "./player-config.ts";
import type { GameState } from "./types.ts";

export interface HeadlessRuntime {
  state: GameState;
  controllers: PlayerController[];
  zones: number[];
  playerCount: number;
}

/** Build a full headless runtime from a seed and advance to CANNON_PLACE. */
export function createHeadlessRuntime(seed: number): HeadlessRuntime {
  const map = generateMap(seed);
  const zones = [...new Set(map.towers.map((t) => t.zone))].slice(0, 3);
  const playerCount = zones.length;

  const state = createGameState(map, playerCount, seed);
  state.playerZones = zones;
  const controllers = Array.from({ length: playerCount }, (_, i) =>
    createController(i, true, undefined, state.rng.int(0, 0xffffffff)),
  );

  // Auto-select towers for all players.
  for (let i = 0; i < playerCount; i++) {
    controllers[i]!.selectTower(state, zones[i]!);
  }

  // CASTLE_SELECT -> WALL_BUILD (auto-builds castles) -> CANNON_PLACE
  nextPhase(state);
  nextPhase(state);

  return { state, controllers, zones, playerCount };
}

/**
 * Build a mixed runtime where some slots are HumanController and the rest are AI.
 * Does NOT advance phases — stays at CASTLE_SELECT so the server can manage flow.
 * Auto-selects towers for AI players only (humans need server-driven selection or
 * can be auto-selected by the server for V2 simplicity).
 */
export function createMixedRuntime(
  seed: number,
  humanSlots: number[],
): HeadlessRuntime {
  const map = generateMap(seed);
  const zones = [...new Set(map.towers.map((t) => t.zone))].slice(0, 3);
  const playerCount = zones.length;

  const state = createGameState(map, playerCount, seed);
  state.playerZones = zones;

  const humanSet = new Set(humanSlots);
  const controllers = Array.from({ length: playerCount }, (_, i) => {
    if (humanSet.has(i)) {
      return createController(i, false, PLAYER_KEY_BINDINGS[0]);
    }
    return createController(i, true, undefined, state.rng.int(0, 0xffffffff));
  });

  return { state, controllers, zones, playerCount };
}

/**
 * Process life-loss reselection for headless controllers and advance back to CANNON_PLACE.
 * Call this only after finalizeBuildPhase.
 */
export function processHeadlessReselection(
  runtime: HeadlessRuntime,
  needsReselect: number[],
): void {
  const { state, controllers, zones } = runtime;

  for (const pid of needsReselect) {
    controllers[pid]!.onLifeLost();
    const zone = zones[pid];
    if (zone === undefined) continue;
    const player = state.players[pid]!;
    controllers[pid]!.reselect(state, zone);
    if (player.homeTower) {
      rebuildHomeCastle(state, player);
      markPlayerReselected(state, pid);
    }
  }

  if (needsReselect.length > 0) {
    enterCastleReselectPhase(state);
    nextPhase(state);
  }

  // WALL_BUILD/CASTLE_RESELECT -> CANNON_PLACE
  nextPhase(state);
}
