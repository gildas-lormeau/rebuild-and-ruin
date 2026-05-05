/**
 * Game Init — match-lifecycle setup.
 *
 * Two exported entry points run once per match:
 *   - `createGameFromSeed`  builds the map (or reuses one), picks zones,
 *                           and creates the initial GameState.
 *   - `applyGameConfig`     stamps per-match config (max rounds, timers,
 *                           game mode) onto the freshly created state.
 *
 * Both are called from `runtime-bootstrap.ts` during game boot. The
 * private `createGameState` factory is the single source of truth for
 * GameState's initial field values.
 *
 * Per-round and per-phase setup lives in `phase-entry.ts` and
 * `phase-setup.ts`.
 */

import { EMPTY_FEATURES } from "../shared/core/feature-defs.ts";
import {
  BUILD_TIMER,
  CANNON_MAX_HP,
  CANNON_PLACE_TIMER,
  FIRST_ROUND_CANNONS,
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
  STARTING_LIVES,
} from "../shared/core/game-constants.ts";
import { createGameEventBus } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { GameMap } from "../shared/core/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import {
  emptyFreshInterior,
  type Player,
} from "../shared/core/player-types.ts";
import { type GameState, setGameMode } from "../shared/core/types.ts";
import { Rng } from "../shared/platform/rng.ts";
import { generateMap, topZonesBySize } from "./map-generation.ts";

/** Create a game from a seed: generate map, pick zones, create state.
 *  Pass an existing map to reuse it (avoids regeneration + keeps terrain cache warm). */
export function createGameFromSeed(
  seed: number,
  maxPlayers: number,
  existingMap?: GameMap,
): { map: GameMap; state: GameState; zones: number[]; playerCount: number } {
  const map = existingMap ?? generateMap(seed);
  const zones = topZonesBySize(map, maxPlayers).map(({ zone }) => zone);
  const playerCount = Math.min(zones.length, maxPlayers);
  const state = createGameState(map, playerCount, seed);
  state.playerZones = zones.slice();
  return { map, state, zones, playerCount };
}

/** Apply per-match game configuration to a freshly created GameState.
 *  Called by bootstrapGame after createGameFromSeed. Keeps all game-config
 *  mutation inside the game domain. */
export function applyGameConfig(
  state: GameState,
  config: {
    maxRounds: number;
    cannonMaxHp: number;
    buildTimer: number;
    cannonPlaceTimer: number;
    firstRoundCannons: number;
    gameMode: GameMode;
  },
): void {
  state.maxRounds = config.maxRounds > 0 ? config.maxRounds : Infinity;
  state.cannonMaxHp = config.cannonMaxHp;
  state.buildTimer = config.buildTimer;
  state.cannonPlaceTimer = config.cannonPlaceTimer;
  state.firstRoundCannons = config.firstRoundCannons;
  setGameMode(
    state,
    config.gameMode === GAME_MODE_MODERN ? GAME_MODE_MODERN : GAME_MODE_CLASSIC,
  );
}

function createGameState(
  map: GameMap,
  playerCount: number,
  seed?: number,
): GameState {
  const players: Player[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      id: i as ValidPlayerSlot,
      homeTower: null,
      castle: null,
      ownedTowers: [],
      walls: new Set(),
      interior: emptyFreshInterior(),
      cannons: [],
      lives: STARTING_LIVES,
      eliminated: false,
      score: 0,
      defaultFacing: 0,
      castleWallTiles: new Set(),
      upgrades: new Map(),
      damagedWalls: new Set(),
      freshCastle: false,
      bag: undefined,
      currentPiece: undefined,
    });
  }

  return {
    rng: new Rng(seed),
    map,
    bus: createGameEventBus(),
    phase: Phase.CASTLE_SELECT,
    round: 1,
    maxRounds: Infinity,
    cannonMaxHp: CANNON_MAX_HP,
    buildTimer: BUILD_TIMER,
    cannonPlaceTimer: CANNON_PLACE_TIMER,
    firstRoundCannons: FIRST_ROUND_CANNONS,
    players,
    timer: 0,
    cannonballs: [],
    shotsFired: 0,
    grunts: [],
    towerAlive: map.towers.map(() => true),
    towerPendingRevive: new Set(),
    burningPits: [],
    capturedCannons: [],
    bonusSquares: [],
    battleCountdown: 0,
    reselectedPlayers: new Set(),
    playerZones: [],
    cannonLimits: [],
    cannonPlaceDone: new Set(),
    salvageSlots: [],
    gameMode: GAME_MODE_CLASSIC,
    activeFeatures: EMPTY_FEATURES,
    modern: null,
    simTick: 0,
    pendingCannonFires: new Set(),
    pendingCannonSlotCost: players.map(() => 0),
    pendingCannonPlaceDone: new Set(),
  };
}
