/**
 * Shared headless simulation helpers used by headless-test and headless-build.
 */

import {
  createGameState,
  enterCastleReselectPhase,
  markPlayerReselected,
  nextPhase,
} from "../src/game/game-engine.ts";
import { generateMap } from "../src/game/map-generation.ts";
import { rebuildHomeCastle } from "../src/game/phase-setup.ts";
import { createController } from "../src/player/controller-factory.ts";
import { PLAYER_KEY_BINDINGS } from "../src/shared/player-config.ts";
import type { ValidPlayerSlot } from "../src/shared/player-slot.ts";
import { MAX_UINT32 } from "../src/shared/rng.ts";
import type { PlayerController } from "../src/shared/system-interfaces.ts";
import type { GameState } from "../src/shared/types.ts";

export interface HeadlessRuntime {
  state: GameState;
  controllers: PlayerController[];
  zones: number[];
  playerCount: number;
}

/** Build a full headless runtime from a seed and advance to CANNON_PLACE. */
export async function createHeadlessRuntime(
  seed: number,
): Promise<HeadlessRuntime> {
  const map = generateMap(seed);
  const zones = [...new Set(map.towers.map((tower) => tower.zone))].slice(0, 3);
  const playerCount = zones.length;

  const state = createGameState(map, playerCount, seed);
  state.playerZones = zones;
  const controllers = await Promise.all(
    Array.from({ length: playerCount }, (_, i) =>
      createController(
        i as ValidPlayerSlot,
        true,
        undefined,
        state.rng.int(0, MAX_UINT32),
      ),
    ),
  );

  // Auto-select towers for all players.
  for (let i = 0; i < playerCount; i++) {
    controllers[i]!.selectInitialTower(state, zones[i]!);
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
export async function createMixedRuntime(
  seed: number,
  humanSlots: readonly number[],
): Promise<HeadlessRuntime> {
  const map = generateMap(seed);
  const zones = [...new Set(map.towers.map((tower) => tower.zone))].slice(0, 3);
  const playerCount = zones.length;

  const state = createGameState(map, playerCount, seed);
  state.playerZones = zones;

  const humanSet = new Set(humanSlots);
  const controllers = await Promise.all(
    Array.from({ length: playerCount }, (_, i) => {
      const pid = i as ValidPlayerSlot;
      if (humanSet.has(i)) {
        return createController(pid, false, PLAYER_KEY_BINDINGS[0]);
      }
      return createController(
        pid,
        true,
        undefined,
        state.rng.int(0, MAX_UINT32),
      );
    }),
  );

  return { state, controllers, zones, playerCount };
}

/**
 * Process life-loss reselection for headless controllers and advance back to CANNON_PLACE.
 * Call this only after finalizeBuildPhase.
 */
export function processHeadlessReselection(
  runtime: HeadlessRuntime,
  needsReselect: readonly ValidPlayerSlot[],
): void {
  const { state, controllers, zones } = runtime;

  for (const pid of needsReselect) {
    controllers[pid]!.onLifeLost();
    const zone = zones[pid];
    if (zone === undefined) continue;
    const player = state.players[pid]!;
    controllers[pid]!.selectReplacementTower(state, zone);
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
