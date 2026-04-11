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
import type { CastleData, EntityOverlay } from "../shared/overlay-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { emptyFreshInterior, type Player } from "../shared/player-types.ts";
import { Rng } from "../shared/rng.ts";
import { type GameState, setGameMode } from "../shared/types.ts";
import { isGlobalUpgradeActive, UID } from "../shared/upgrade-defs.ts";
import { resolveBalloons, snapshotTerritory } from "./battle-system.ts";
import {
  prepareCannonPhase,
  prepareControllerCannonPhase,
} from "./cannon-system.ts";
import { generateMap, topZonesBySize } from "./map-generation.ts";
import { snapshotCastles, snapshotEntities } from "./phase-banner.ts";
import {
  enterBattleFromCannon,
  enterBuildFromBattle,
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

/** Per-player init data for the cannon placement phase.
 *  Null for eliminated players (no cannons to place). */
interface PlayerCannonInit {
  maxSlots: number;
  cursorPos: { row: number; col: number };
}

/** Result of `enterCannonPhase` — per-player init data the caller uses to
 *  initialize local controllers in the initControllers step.
 *  Index = playerId; null entries are eliminated players or empty slots. */
export interface CannonPhaseEntry {
  playerInit: readonly (PlayerCannonInit | null)[];
}

/** Result of `enterBuildPhase` — pre-transition snapshots the caller wires
 *  into the banner overlay so the build-banner reveal can show the
 *  before/after comparison. The engine has already mutated state to
 *  WALL_BUILD by the time this is returned. */
interface BuildPhaseEntry {
  /** Castle data captured BEFORE battle artifacts were cleaned up. */
  prevCastles: CastleData[];
  /** Per-player territory at battle end (cloned from runtime battleAnim). */
  prevTerritory: Set<number>[] | undefined;
  /** Per-player walls at battle end (cloned from runtime battleAnim). */
  prevWalls: Set<number>[] | undefined;
  /** Map entities (houses, grunts, towers, pits, bonus squares) captured
   *  while phase was still BATTLE. */
  prevEntities: EntityOverlay;
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

/** Enter the cannon placement phase. Sets the phase flag, computes cannon
 *  limits and default facings, resets the timer, and returns per-player
 *  init data (max slots + starting cursor position) for every active slot.
 *
 *  Replaces the runtime's manual sequence of `enterCannonPlacePhase` +
 *  `prepareCannonPhase` + per-player `prepareControllerCannonPhase`. The
 *  engine owns the order; the runtime consumes the returned struct to
 *  initialize its local controllers. */
export function enterCannonPhase(state: GameState): CannonPhaseEntry {
  enterCannonPlacePhase(state);
  prepareCannonPhase(state);
  const playerInit = state.players.map((_, idx) =>
    prepareControllerCannonPhase(idx as ValidPlayerSlot, state),
  );
  return { playerInit };
}

/** Enter the build phase from BATTLE. Captures pre-transition snapshots
 *  (castles, entities, territory, walls) BEFORE mutating state, then runs
 *  enterBuildFromBattle which performs the round-end housekeeping
 *  (combo bonuses, battle cleanup, grunt spawn, upgrade offer generation,
 *  modifier rotation, round increment, phase flip).
 *
 *  Replaces the runtime's manual sequence of `capturePrevBattleScene` +
 *  `nextPhase`. Snapshot order is load-bearing — capturing must happen
 *  while state.phase is still BATTLE so snapshotCastles/snapshotEntities
 *  see the unflipped state.
 *
 *  battleTerritory/battleWalls live in runtime battleAnim state (not the
 *  game state) so they're passed in as parameters. The engine clones them
 *  defensively so the runtime can mutate its own copies later. */
export function enterBuildPhase(
  state: GameState,
  battleTerritory: readonly Set<number>[] | undefined,
  battleWalls: readonly Set<number>[] | undefined,
): BuildPhaseEntry {
  const prevCastles = snapshotCastles(state);
  const prevTerritory = battleTerritory?.map((territory) => new Set(territory));
  const prevWalls = battleWalls?.map((wall) => new Set(wall));
  const prevEntities = snapshotEntities(state);
  enterBuildFromBattle(state);
  return { prevCastles, prevTerritory, prevWalls, prevEntities };
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

/** Finalize castle construction. Used after castle selection + build
 *  completes (both initial and reselection), and during host promotion to
 *  skip the castle build animation.
 *
 *  Does NOT flip the phase — the caller must subsequently run
 *  `enterCannonPhase(state)` (typically inside startCannonPhase's
 *  applyCheckpoint step) to transition to CANNON_PLACE. This keeps the
 *  phase flip + preparation bundled in one engine entry point. */
export function finalizeAndEnterCannonPhase(state: GameState): void {
  finalizeCastleConstruction(state);
}

/** Transition game state to CANNON_PLACE. This only sets the phase flag and
 *  timer; callers should prefer `enterCannonPhase` which additionally runs
 *  preparation (limits, facings) and returns per-player init data.
 *  Private — internal helper for enterCannonPhase + finalizeAndEnterCannonPhase. */
function enterCannonPlacePhase(state: GameState): void {
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
