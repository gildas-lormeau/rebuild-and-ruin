/**
 * Game Engine — state machine and state factory.
 *
 * Phases (in order):
 *   1. CASTLE_SELECT  — each player picks a home castle (tower)
 *   2. WALL_BUILD     — first round: auto-build walls; later: repair with pieces (25s timer)
 *   3. CANNON_PLACE   — place cannons inside walled territory
 *   4. BATTLE         — fire cannons at enemies (10s timer)
 *   → back to WALL_BUILD (repair phase)
 *
 * A player loses if they fail to surround at least one castle during WALL_BUILD.
 *
 * Phase transition recipes live in phase-setup.ts.
 */

import type { BalloonFlight } from "../shared/battle-types.ts";
import { snapshotAllWalls } from "../shared/board-occupancy.ts";
import { EMPTY_FEATURES } from "../shared/feature-defs.ts";
import {
  BUILD_TIMER,
  CANNON_MAX_HP,
  CANNON_PLACE_TIMER,
  FIRST_ROUND_CANNONS,
  GAME_MODE_CLASSIC,
  GAME_MODE_MODERN,
  type GameMode,
  type ModifierDiff,
  STARTING_LIVES,
} from "../shared/game-constants.ts";
import { createGameEventBus } from "../shared/game-event-bus.ts";
import { Phase } from "../shared/game-phase.ts";
import type { GameMap, Tower } from "../shared/geometry-types.ts";
import type { EntityOverlay } from "../shared/overlay-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { emptyFreshInterior, type Player } from "../shared/player-types.ts";
import { Rng } from "../shared/rng.ts";
import { type GameState, setGameMode } from "../shared/types.ts";
import { isGlobalUpgradeActive, UID } from "../shared/upgrade-defs.ts";
import { assertNever } from "../shared/utils.ts";
import { resolveBalloons, snapshotTerritory } from "./battle-system.ts";
import { generateMap, topZonesBySize } from "./map-generation.ts";
import { snapshotEntities } from "./phase-banner.ts";
import {
  enterBattleFromCannon,
  enterBuildFromBattle,
  enterBuildFromReselect,
  enterBuildFromSelect,
  finalizeCastleConstruction,
  setPhase,
} from "./phase-setup.ts";

/** Result of `enterBattlePhase` — everything the caller needs to wire up
 *  banners, balloon animation, visual snapshots, and online broadcast.
 *  The engine has already mutated state to BATTLE phase by the time this
 *  is returned; the struct is the read-only view of what happened. */
interface BattlePhaseEntry {
  /** Modifier rolled for this battle, or null if classic mode / no roll. */
  modifierDiff: ModifierDiff | null;
  /** Balloons launched this battle (empty if no balloon cannons). */
  flights: BalloonFlight[];
  /** Per-player territory snapshot (interior + walls), post-modifier. */
  territory: Set<number>[];
  /** Per-player wall snapshot, post-modifier. */
  walls: Set<number>[];
}

/** Check if any player has the Ceasefire upgrade active. */
export function isCeasefireActive(state: GameState): boolean {
  return isGlobalUpgradeActive(state.players, UID.CEASEFIRE);
}

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

export function enterCastleReselectPhase(state: GameState): void {
  setPhase(state, Phase.CASTLE_RESELECT);
  state.timer = 0;
}

/** Set a player's home tower and initialize their owned towers list. */
export function selectPlayerTower(player: Player, tower: Tower): void {
  player.homeTower = tower;
  player.ownedTowers = [tower];
}

/** Mark a player as having reselected a castle this round. */
export function markPlayerReselected(
  state: GameState,
  playerId: ValidPlayerSlot,
): void {
  state.reselectedPlayers.add(playerId);
}

export function nextPhase(state: GameState): void {
  const { phase } = state;
  switch (phase) {
    case Phase.CASTLE_SELECT:
      enterBuildFromSelect(state);
      break;
    case Phase.CASTLE_RESELECT:
      enterBuildFromReselect(state);
      break;
    case Phase.WALL_BUILD:
      enterCannonPlacePhase(state);
      break;
    case Phase.CANNON_PLACE:
      enterBattleFromCannon(state);
      break;
    case Phase.BATTLE:
      enterBuildFromBattle(state);
      break;
    default:
      assertNever(phase);
  }
}

/** Enter the battle phase from CANNON_PLACE. Performs all engine work in
 *  the load-bearing order (modifier roll → balloon resolution → snapshots)
 *  and returns the data the caller needs to react.
 *
 *  Replaces the runtime's manual sequence of `enterBattleFromCannon` +
 *  `resolveBalloons` + `snapshotTerritory` + `snapshotAllWalls`. The engine
 *  owns the order; the runtime is just a consumer. */
export function enterBattlePhase(state: GameState): BattlePhaseEntry {
  const modifierDiff = enterBattleFromCannon(state);
  const flights = resolveBalloons(state);
  const territory = snapshotTerritory(state.players);
  const walls = snapshotAllWalls(state);
  return { modifierDiff, flights, territory, walls };
}

/** INVARIANT: Snapshot entities THEN finalize castle construction and enter
 *  cannon phase. Snapshot must capture state BEFORE finalize mutates it
 *  (finalize recomputes territory, sweeps walls, modifies players).
 *  Combined here so callers cannot accidentally reverse the steps. */
export function snapshotAndFinalizeForCannonPhase(
  state: GameState,
): EntityOverlay {
  const entities = snapshotEntities(state);
  finalizeAndEnterCannonPhase(state);
  return entities;
}

/** Finalize castle construction and enter cannon placement phase.
 *  Always called together — bundled to prevent partial transitions.
 *  Used after castle selection + build completes (both initial and reselection),
 *  and during host promotion to skip the castle build animation. */
export function finalizeAndEnterCannonPhase(state: GameState): void {
  finalizeCastleConstruction(state);
  enterCannonPlacePhase(state);
}

/** Transition game state to CANNON_PLACE. This only sets the phase flag and timer.
 *  For the canonical `enter / prepare / start` contract that governs every
 *  phase transition, see the phase-setup.ts module header. */
export function enterCannonPlacePhase(state: GameState): void {
  setPhase(state, Phase.CANNON_PLACE);
  state.timer = 0;
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
    salvageSlots: [],
    gameMode: GAME_MODE_CLASSIC,
    activeFeatures: EMPTY_FEATURES,
    modern: null,
  };
}
