/**
 * Game Engine — orchestration layer and phase transitions.
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
 * Sub-modules:
 *   - types.ts          — all interfaces, enums, constants
 *   - cannon-system.ts  — cannon placement & management
 *   - battle-system.ts  — firing, cannonballs, impacts, balloons
 *   - grunt-system.ts   — grunt spawning, movement, tower attacks
 *   - phase-build.ts    — piece placement, territory claiming
 */

import { cleanupBalloonHitTrackingAfterBattle } from "./battle-system.ts";
import {
  collectAllWalls,
  filterAliveOwnedTowers,
  sweepIsolatedWalls,
} from "./board-occupancy.ts";
import {
  claimTerritory,
  removeBonusSquaresCoveredByWalls,
  replenishBonusSquares,
} from "./build-system.ts";
import {
  cannonSlotsForRound,
  findNearestValidCannonPlacement,
  resetCannonFacings,
} from "./cannon-system.ts";
import {
  applyClumsyBuilders,
  computeCastleWallTiles,
  createCastle,
  spawnHousesInZone,
  startOfBuildPhaseHousekeeping,
} from "./castle-generation.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import {
  BATTLE_TIMER,
  BUILD_TIMER,
  CANNON_MAX_HP,
  CANNON_PLACE_TIMER,
  FIRST_GRUNT_SPAWN_ROUND,
  FIRST_ROUND_CANNONS,
  INTERBATTLE_GRUNT_SPAWN_ATTEMPTS,
  INTERBATTLE_GRUNT_SPAWN_CHANCE,
  STARTING_LIVES,
} from "./game-constants.ts";
import type { Castle, GameMap, Tower } from "./geometry-types.ts";
import {
  rollGruntWallAttacks,
  spawnGruntGroupOnZone,
  spawnGruntOnZone,
  updateGruntBlockedBattles,
} from "./grunt-system.ts";
import { generateMap, topZonesBySize } from "./map-generation.ts";
import { Rng } from "./rng.ts";
import { DIRS_4, isBalloonCannon, packTile, unpackTile } from "./spatial.ts";
import {
  assertNever,
  CannonMode,
  type GameState,
  isPlayerActive,
  Phase,
  type Player,
} from "./types.ts";

/** Grunts spawned per player on first battle when nobody fires. */
const IDLE_FIRST_BATTLE_GRUNTS = 2;
/** Probability of reversing castle-wall build animation direction. */
const CASTLE_RING_REVERSE_CHANCE = 0.5;

/** Create a game from a seed: generate map, pick zones, create state. */
export function createGameFromSeed(
  seed: number,
  maxPlayers: number,
): { map: GameMap; state: GameState; zones: number[]; playerCount: number } {
  const map = generateMap(seed);
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
      id: i,
      homeTower: null,
      castle: null,
      ownedTowers: [],
      walls: new Set(),
      interior: new Set(),
      cannons: [],
      lives: STARTING_LIVES,
      eliminated: false,
      score: 0,
      defaultFacing: 0,
    });
  }

  return {
    rng: new Rng(seed),
    map,
    phase: Phase.CASTLE_SELECT,
    round: 1,
    battleLength: Infinity,
    cannonMaxHp: CANNON_MAX_HP,
    buildTimer: BUILD_TIMER,
    cannonPlaceTimer: CANNON_PLACE_TIMER,
    firstRoundCannons: FIRST_ROUND_CANNONS,
    players,
    activePlayer: 0,
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
  };
}

/** Rebuild a player's home castle from scratch (used when continuing after losing a life). */
export function rebuildHomeCastle(state: GameState, player: Player): void {
  if (!player.homeTower) return;
  clearPlayerState(player, { keepHomeTower: true });
  const castle = createCastle(
    player.homeTower,
    state.map.tiles,
    state.map.towers,
  );
  player.castle = castle;
  const wallTiles = computeCastleWallTiles(castle, state.map.tiles);
  for (const [r, c] of wallTiles) {
    player.walls.add(packTile(r, c));
  }
  // Destroy houses under rebuilt castle walls
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    if (player.walls.has(packTile(house.row, house.col))) {
      house.alive = false;
    }
  }
  // Remove bonus squares under new walls
  removeBonusSquaresCoveredByWalls(state, player.walls);
  claimTerritory(state);
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
export function markPlayerReselected(state: GameState, playerId: number): void {
  state.reselectedPlayers.add(playerId);
}

/**
 * Complete the build phase using the canonical gameplay rules.
 * Owns wall sweeping, territory/tower revival, and the life check.
 */
export function finalizeBuildPhase(state: GameState): {
  needsReselect: number[];
  eliminated: number[];
} {
  sweepAllPlayersWalls(state);
  claimTerritory(state, true);
  return applyLifePenalties(state);
}

/** Finalize castle construction — claim territory, spawn houses, replenish bonus squares. */
export function finalizeCastleConstruction(state: GameState): void {
  claimTerritory(state);
  for (const player of state.players) {
    if (player.homeTower) spawnHousesInZone(state, player.homeTower.zone);
  }
  replenishBonusSquares(state);
}

/** Advance state through nextPhase until CANNON_PLACE is reached. */
export function advanceToCannonPlacePhase(state: GameState): void {
  const MAX_ADVANCES = 5;
  for (let i = 0; i < MAX_ADVANCES && state.phase !== Phase.CANNON_PLACE; i++) {
    nextPhase(state);
  }
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

export function enterCannonPlacePhase(state: GameState): void {
  setPhase(state, Phase.CANNON_PLACE);
  state.timer = 0;
}

/** Initialize cannon phase: compute limits, reset facings, let controllers place. */
export function initCannonPhase(params: {
  state: GameState;
  controllers: PlayerController[];
  skipController?: (playerId: number) => boolean;
}): void {
  const { state, controllers, skipController } = params;

  computeCannonLimitsForPhase(state);
  resetCannonFacings(state);

  // Let each controller place cannons
  for (const ctrl of controllers) {
    if (skipController?.(ctrl.playerId)) continue;
    const player = state.players[ctrl.playerId]!;
    if (player.eliminated) continue;
    const max = state.cannonLimits[player.id] ?? 0;
    ctrl.placeCannons(state, max);
  }

  // Initialize cannon cursor near home tower for all controllers
  for (const ctrl of controllers) {
    if (skipController?.(ctrl.playerId)) continue;
    const player = state.players[ctrl.playerId]!;
    if (player.eliminated) continue;
    if (player.homeTower) {
      const t = player.homeTower;
      const snapped = findNearestValidCannonPlacement(
        player,
        t.row,
        t.col,
        CannonMode.NORMAL,
        state,
      );
      ctrl.cannonCursor = snapped ?? { row: t.row, col: t.col };
    }
    ctrl.onCannonPhaseStart(state);
  }
}

/** Compute cannon limits for the upcoming cannon phase, store in state, and consume reselection markers. */
export function computeCannonLimitsForPhase(state: GameState): void {
  state.cannonLimits = state.players.map((player) =>
    cannonSlotsForRound(player, state),
  );
  state.reselectedPlayers.clear();
}

/** Initialize build phase controllers — reset facings, clear accumulators. */
export function initBuildPhase(
  state: GameState,
  controllers: readonly PlayerController[],
  skipController?: (playerId: number) => boolean,
): void {
  resetCannonFacings(state);
  for (const ctrl of controllers) {
    if (skipController?.(ctrl.playerId)) continue;
    const player = state.players[ctrl.playerId];
    if (player?.eliminated) continue;
    ctrl.startBuild(state);
  }
}

/** Enter build from initial castle selection — builds castles first.
 *  Callers must call initBuildPhase() afterwards to init controllers. */
function enterBuildFromSelect(state: GameState): void {
  autoBuildCastles(state);
  replenishBonusSquares(state);
  setPhase(state, Phase.WALL_BUILD);
  state.timer = 0;
}

/** Enter build from reselection — castles already exist, just set phase.
 *  Callers must call initBuildPhase() afterwards to init controllers. */
function enterBuildFromReselect(state: GameState): void {
  setPhase(state, Phase.WALL_BUILD);
  state.timer = 0;
}

function enterBattleFromCannon(state: GameState): void {
  // Decay burning pits at the start of each battle (not after — so pits
  // created during a battle remain at full intensity through repair/cannon)
  for (const pit of state.burningPits) pit.roundsLeft--;
  state.burningPits = state.burningPits.filter((p) => p.roundsLeft > 0);

  sweepAllPlayersWalls(state);
  claimTerritory(state);
  // From round 2+, each player has a chance to get grunts spawned on their zone
  if (state.round >= FIRST_GRUNT_SPAWN_ROUND) {
    for (const player of state.players.filter(isPlayerActive)) {
      for (let i = 0; i < INTERBATTLE_GRUNT_SPAWN_ATTEMPTS; i++) {
        if (state.rng.bool(INTERBATTLE_GRUNT_SPAWN_CHANCE)) {
          spawnGruntOnZone(state, player.id);
        }
      }
    }
  }
  const allWalls = collectAllWalls(state);
  removeBonusSquaresCoveredByWalls(state, allWalls);
  rollGruntWallAttacks(state);
  setPhase(state, Phase.BATTLE);
  state.timer = BATTLE_TIMER;
  state.cannonballs = [];
  state.shotsFired = 0;
}

function sweepAllPlayersWalls(state: GameState): void {
  for (const player of state.players) {
    sweepIsolatedWalls(player.walls);
  }
}

/** Enter build from battle — cleans up battle state (balloons, captured cannons, grunts).
 *  Callers must call initBuildPhase() afterwards to init controllers. */
function enterBuildFromBattle(state: GameState): void {
  updateGruntBlockedBattles(state);
  cleanupBalloonHitTrackingAfterBattle(state);
  state.capturedCannons = [];
  // Remove all balloon bases (they disappear after battle)
  for (const player of state.players) {
    player.cannons = player.cannons.filter((c) => !isBalloonCannon(c));
  }
  // First battle with no shots fired (nobody playing): spawn grouped grunts per player
  if (state.round === 1 && state.shotsFired === 0) {
    for (const player of state.players.filter(isPlayerActive)) {
      spawnGruntGroupOnZone(state, player.id, IDLE_FIRST_BATTLE_GRUNTS);
    }
  }
  claimTerritory(state);
  state.round++;
  replenishBonusSquares(state);
  setPhase(state, Phase.WALL_BUILD);
  state.timer = state.buildTimer;
  startOfBuildPhaseHousekeeping(state);
}

/**
 * Centralized phase setter — every phase mutation flows through here,
 * making the phase state machine traceable from a single call-site.
 * Online mode uses this to reconcile client phase with server checkpoints.
 */
export function setPhase(state: GameState, phase: Phase): void {
  state.phase = phase;
}

/**
 * Check if any player failed to enclose a tower. Decrement lives, reset their zone.
 * Returns { needsReselect, eliminated } — caller handles controller notifications.
 */
function applyLifePenalties(state: GameState): {
  needsReselect: number[];
  eliminated: number[];
} {
  const needsReselect: number[] = [];
  const eliminated: number[] = [];
  for (const player of state.players) {
    if (player.eliminated) continue;
    const hasAliveTower = filterAliveOwnedTowers(player, state).length > 0;
    if (!hasAliveTower) {
      player.lives--;
      const zone = state.playerZones[player.id];
      clearPlayerState(player);
      if (player.lives <= 0) {
        eliminatePlayer(player);
        eliminated.push(player.id);
      } else {
        needsReselect.push(player.id);
      }
      if (zone !== undefined) resetZoneState(state, zone);
    }
  }
  return { needsReselect, eliminated };
}

export function resetZoneState(state: GameState, zone: number): void {
  state.grunts = state.grunts.filter(
    (grunt) => state.map.zones[grunt.row]?.[grunt.col] !== zone,
  );
  state.map.houses = state.map.houses.filter((house) => house.zone !== zone);
  state.bonusSquares = state.bonusSquares.filter((bs) => bs.zone !== zone);
  state.burningPits = state.burningPits.filter(
    (pit) => state.map.zones[pit.row]?.[pit.col] !== zone,
  );
  for (let towerIndex = 0; towerIndex < state.map.towers.length; towerIndex++) {
    if (state.map.towers[towerIndex]!.zone === zone) {
      state.towerAlive[towerIndex] = true;
    }
  }
}

/** Mark a player as eliminated (used when abandoning in life-lost dialog). */
export function eliminatePlayer(player: Player): void {
  player.eliminated = true;
  player.lives = 0;
}

/** Clear all mutable state from a player (used when losing a life or being eliminated). */
function clearPlayerState(
  player: Player,
  options?: { keepHomeTower?: boolean },
): void {
  player.walls.clear();
  player.interior.clear();
  player.cannons = [];
  player.ownedTowers = [];
  player.castle = null;
  if (!options?.keepHomeTower) player.homeTower = null;
}

/** Build all castles instantly (used by headless tests via nextPhase). */
function autoBuildCastles(state: GameState): void {
  const plans = prepareCastleWalls(state);
  for (const plan of plans) {
    const player = state.players[plan.playerId]!;
    for (const key of plan.tiles) player.walls.add(key);
  }
  claimTerritory(state);
  for (const player of state.players) {
    if (player.homeTower) spawnHousesInZone(state, player.homeTower.zone);
  }
}

function prepareCastleWalls(
  state: GameState,
): { playerId: number; tiles: number[] }[] {
  const result: { playerId: number; tiles: number[] }[] = [];
  for (const player of state.players) {
    const plan = prepareCastleWallsForPlayer(state, player.id);
    if (plan) result.push(plan);
  }
  return result;
}

/** Prepare castle walls for all players, returning ordered wall tiles per player
 *  for animated construction. Sets castle but does NOT add walls or interior. */
export function prepareCastleWallsForPlayer(
  state: GameState,
  playerId: number,
): { playerId: number; tiles: number[] } | null {
  const player = state.players[playerId];
  if (!player?.homeTower) return null;
  const castle = createCastle(
    player.homeTower,
    state.map.tiles,
    state.map.towers,
  );
  player.castle = castle;

  // Get wall tiles and apply clumsy builders to a temp set
  const wallTiles = computeCastleWallTiles(castle, state.map.tiles);
  const tempWalls = new Set<number>();
  for (const [r, c] of wallTiles) tempWalls.add(packTile(r, c));
  applyClumsyBuilders(
    tempWalls,
    castle,
    state.map.tiles,
    state.rng,
    state.map.towers,
  );

  const ordered = orderCastleWallsForAnimation(
    castle,
    wallTiles,
    tempWalls,
    state.rng,
  );
  return { playerId: player.id, tiles: ordered };
}

/**
 * Order castle wall tiles for the build animation.
 * Walks the clean ring in perimeter order (CW or CCW), then interleaves
 * any extra tiles from clumsy builders right after their ring neighbor.
 */
function orderCastleWallsForAnimation(
  castle: Castle,
  ringTiles: readonly [number, number][],
  finalWalls: Set<number>,
  rng: Rng,
): number[] {
  const ringSet = new Set<number>();
  for (const [r, c] of ringTiles) ringSet.add(packTile(r, c));

  const ringWalk = buildPerimeterWalk(castle, ringSet);
  if (rng.bool(CASTLE_RING_REVERSE_CHANCE)) ringWalk.reverse();

  const extras = new Set<number>();
  for (const k of finalWalls) {
    if (!ringSet.has(k)) extras.add(k);
  }
  // Some ring tiles may have been removed by clumsy builders
  // (sweep phase removes tiles with ≤1 neighbor). Filter ring walk.
  const activeRing = ringWalk.filter((k) => finalWalls.has(k));

  return interleaveExtras(activeRing, extras, finalWalls);
}

/** Walk the castle perimeter clockwise: top→right→bottom→left. */
function buildPerimeterWalk(
  castle: Castle,
  ringSet: ReadonlySet<number>,
): number[] {
  const wL = castle.left - 1,
    wR = castle.right + 1,
    wT = castle.top - 1,
    wB = castle.bottom + 1;

  const walk: number[] = [];
  // Top edge (left to right)
  for (let c = wL; c <= wR; c++) {
    const k = packTile(wT, c);
    if (ringSet.has(k)) walk.push(k);
  }
  // Right edge (top+1 to bottom)
  for (let r = wT + 1; r <= wB; r++) {
    const k = packTile(r, wR);
    if (ringSet.has(k)) walk.push(k);
  }
  // Bottom edge (right-1 to left)
  for (let c = wR - 1; c >= wL; c--) {
    const k = packTile(wB, c);
    if (ringSet.has(k)) walk.push(k);
  }
  // Left edge (bottom-1 to top+1)
  for (let r = wB - 1; r > wT; r--) {
    const k = packTile(r, wL);
    if (ringSet.has(k)) walk.push(k);
  }
  return walk;
}

/** After each ring tile, insert any adjacent extra tiles, then append remainders. */
function interleaveExtras(
  activeRing: readonly number[],
  extras: ReadonlySet<number>,
  finalWalls: ReadonlySet<number>,
): number[] {
  const ordered: number[] = [];
  const placed = new Set<number>();
  for (const k of activeRing) {
    if (placed.has(k)) continue;
    ordered.push(k);
    placed.add(k);
    const { r, c } = unpackTile(k);
    for (const [dr, dc] of DIRS_4) {
      const nk = packTile(r + dr, c + dc);
      if (extras.has(nk) && !placed.has(nk)) {
        ordered.push(nk);
        placed.add(nk);
      }
    }
  }
  // Safety: add any remaining tiles not yet placed
  for (const k of finalWalls) {
    if (!placed.has(k)) ordered.push(k);
  }
  return ordered;
}
