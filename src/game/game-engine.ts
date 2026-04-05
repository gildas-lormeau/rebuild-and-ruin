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

import type { Impact } from "../shared/battle-types.ts";
import type { ModifierDiff } from "../shared/game-constants.ts";
import {
  BUILD_TIMER,
  CANNON_MAX_HP,
  CANNON_PLACE_TIMER,
  FIRST_ROUND_CANNONS,
  GAME_MODE_CLASSIC,
  STARTING_LIVES,
} from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import type { GameMap, Tower } from "../shared/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { emptyFreshInterior, type Player } from "../shared/player-types.ts";
import { Rng } from "../shared/rng.ts";
import type { GameState } from "../shared/types.ts";
import { assertNever } from "../shared/utils.ts";
import { generateMap, topZonesBySize } from "./map-generation.ts";
import {
  enterBattleFromCannon,
  enterBuildFromBattle,
  enterBuildFromReselect,
  enterBuildFromSelect,
  setPhase,
} from "./phase-setup.ts";

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

export function createGameState(
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
    balloonHits: new Map(),
    bonusSquares: [],
    battleCountdown: 0,
    reselectedPlayers: new Set(),
    playerZones: [],
    cannonLimits: [],
    gameMode: GAME_MODE_CLASSIC,
    modern: null,
  };
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

export function nextPhase(state: GameState): ModifierDiff | null {
  const { phase } = state;
  switch (phase) {
    case Phase.CASTLE_SELECT:
      enterBuildFromSelect(state);
      return null;
    case Phase.CASTLE_RESELECT:
      enterBuildFromReselect(state);
      return null;
    case Phase.WALL_BUILD:
      enterCannonPlacePhase(state);
      return null;
    case Phase.CANNON_PLACE:
      return enterBattleFromCannon(state);
    case Phase.BATTLE:
      enterBuildFromBattle(state);
      return null;
    default:
      assertNever(phase);
  }
}

/** Transition game state to CANNON_PLACE. This only sets the phase flag and timer.
 *
 *  Phase-entry vs start-phase contract (applies to all phases):
 *    enterXPhase()  — mutates state.phase + timer (called by nextPhase / local transitions)
 *    prepareXPhase() — computes derived state (limits, facings) without touching phase
 *    initControllerForXPhase() — initializes each controller for the new phase
 *
 *  In local play, nextPhase() calls enterCannonPlacePhase directly.
 *  In online play, the host calls prepareCannonPhase() first (to include limits
 *  in the checkpoint), then executeTransition() runs enterCannonPlacePhase as a step.
 *  This ordering difference is by design — the checkpoint must contain computed limits. */
export function enterCannonPlacePhase(state: GameState): void {
  setPhase(state, Phase.CANNON_PLACE);
  state.timer = 0;
}

/** Tick game core: age impacts, dispatch to phase handlers. */
export function tickGameCore(params: {
  dt: number;
  state: GameState;
  battleAnim: { impacts: Impact[] };
  impactFlashDuration: number;
  tickCannonPhase: (dt: number) => void;
  tickBattleCountdown: (dt: number) => void;
  tickBattlePhase: (dt: number) => void;
  tickBuildPhase: (dt: number) => void;
}): void {
  const {
    dt,
    state,
    battleAnim,
    impactFlashDuration,
    tickCannonPhase,
    tickBattleCountdown,
    tickBattlePhase,
    tickBuildPhase,
  } = params;

  // Age and filter impact flashes regardless of phase
  for (const imp of battleAnim.impacts) imp.age += dt;
  battleAnim.impacts = battleAnim.impacts.filter(
    (imp) => imp.age < impactFlashDuration,
  );

  if (state.phase === Phase.CANNON_PLACE) {
    tickCannonPhase(dt);
  } else if (state.phase === Phase.BATTLE) {
    if (state.battleCountdown > 0) {
      tickBattleCountdown(dt);
    } else {
      tickBattlePhase(dt);
    }
  } else if (state.phase === Phase.WALL_BUILD) {
    tickBuildPhase(dt);
  }
}
