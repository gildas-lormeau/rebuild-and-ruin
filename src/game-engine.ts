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

import { collectAllWalls } from "./board-occupancy.ts";
import { cannonSlotsUsed } from "./cannon-system.ts";
import type { GameMap } from "./geometry-types.ts";
import {
  rollGruntWallAttacks,
  spawnGruntGroupOnZone,
  spawnGruntOnZone,
  updateGruntBlockedBattles,
} from "./grunt-system.ts";
import {
  applyClumsyBuilders,
  buildCastle,
  generateMap,
  getCastleWallTiles,
  spawnHousesInZone,
  startOfBuildPhaseHousekeeping,
  topZonesBySize,
} from "./map-generation.ts";
import { claimTerritory, replenishBonusSquares } from "./phase-build.ts";
import type { PlayerController } from "./player-controller.ts";
import { Rng } from "./rng.ts";
import { countWallNeighbors, DIRS_4, isCannonAlive, packTile, snapAngle, unpackTile } from "./spatial.ts";
import type { GameState, Player } from "./types.ts";
import {
  BATTLE_TIMER,
  BUILD_TIMER,
  CANNON_MAX_HP,
  CANNON_PLACE_TIMER,
  FIRST_GRUNT_SPAWN_ROUND,
  FIRST_ROUND_CANNONS,
  INTERBATTLE_GRUNT_SPAWN_ATTEMPTS,
  INTERBATTLE_GRUNT_SPAWN_CHANCE,
  isPlayerActive,
  MAX_CANNON_LIMIT_ON_RESELECT,
  Phase,
  STARTING_LIVES,
} from "./types.ts";

function removeBonusSquaresCoveredByWalls(
  state: GameState,
  walls: Set<number>,
): void {
  state.bonusSquares = state.bonusSquares.filter(
    (bonusSquare) => !walls.has(packTile(bonusSquare.row, bonusSquare.col)),
  );
}


function cleanupBalloonHitTrackingAfterBattle(state: GameState): void {
  // Reset balloon hit counters for cannons that were captured (used this battle)
  for (const cc of state.capturedCannons) {
    state.balloonHits.delete(cc.cannon);
  }

  // Also clean up hit counters for destroyed cannons
  for (const [cannon] of state.balloonHits) {
    if (!isCannonAlive(cannon)) state.balloonHits.delete(cannon);
  }

  // Clear capturerIds for non-captured cannons so only the deciding
  // battle's contributors can win (hit count persists across battles)
  for (const [, hit] of state.balloonHits) {
    hit.capturerIds = [];
  }
}

function sweepAllPlayersWalls(state: GameState): void {
  for (const player of state.players) {
    sweepIsolatedWalls(player.walls);
  }
}

// ---------------------------------------------------------------------------
// Banner text (shared between local host and online watcher)
// ---------------------------------------------------------------------------

export const BANNER_PLACE_CANNONS = "Place Cannons";
export const BANNER_PLACE_CANNONS_SUB = "Position inside fort walls";
export const BANNER_BATTLE = "Prepare for Battle";
export const BANNER_BATTLE_SUB = "Shoot at enemy walls";
export const BANNER_BUILD = "Build & Repair";
export const BANNER_BUILD_SUB = "Surround castles, repair walls";
export const BANNER_SELECT = "Select your home castle";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

/** Rebuild a player's home castle from scratch (used when continuing after losing a life). */
export function rebuildHomeCastle(state: GameState, player: Player): void {
  if (!player.homeTower) return;
  const homeTower = player.homeTower;
  clearPlayerState(player);
  player.homeTower = homeTower;
  const castle = buildCastle(
    player.homeTower,
    state.map.tiles,
    state.map.towers,
  );
  player.castle = castle;
  const wallTiles = getCastleWallTiles(castle, state.map.tiles);
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

function enterBuildFromSelect(state: GameState): void {
  autoBuildCastles(state);
  replenishBonusSquares(state);
  state.phase = Phase.WALL_BUILD;
  state.timer = 0;
}

function enterBuildFromReselect(state: GameState): void {
  state.phase = Phase.WALL_BUILD;
  state.timer = 0;
}

export function enterCannonPlacePhase(state: GameState): void {
  state.phase = Phase.CANNON_PLACE;
  state.timer = 0;
}

export function enterCastleReselectPhase(state: GameState): void {
  state.phase = Phase.CASTLE_RESELECT;
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
  state.phase = Phase.BATTLE;
  state.timer = BATTLE_TIMER;
  state.cannonballs = [];
  state.shotsFired = 0;
}

function enterBuildFromBattle(state: GameState): void {
  updateGruntBlockedBattles(state);
  cleanupBalloonHitTrackingAfterBattle(state);
  state.capturedCannons = [];
  // Remove all balloon bases (they disappear after battle)
  for (const player of state.players) {
    player.cannons = player.cannons.filter((c) => !c.balloon);
  }
  // First battle with no shots fired (nobody playing): spawn 2 grouped grunts per player
  if (state.round === 1 && state.shotsFired === 0) {
    for (const player of state.players.filter(isPlayerActive)) {
      spawnGruntGroupOnZone(state, player.id, 2);
    }
  }
  claimTerritory(state);
  state.round++;
  replenishBonusSquares(state);
  state.phase = Phase.WALL_BUILD;
  state.timer = state.buildTimer;
  startOfBuildPhaseHousekeeping(state);
}

export function nextPhase(state: GameState): void {
  switch (state.phase) {
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
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Clear all mutable state from a player (used when losing a life or being eliminated). */
export function clearPlayerState(player: Player): void {
  player.walls.clear();
  player.interior.clear();
  player.cannons = [];
  player.ownedTowers = [];
  player.castle = null;
  player.homeTower = null;
}

/**
 * Reset cannon facings to point toward the average enemy position.
 * Call at the start of the cannon phase and after reselection.
 */
export function resetCannonFacings(state: GameState): void {
  for (const player of state.players) {
    if (!isPlayerActive(player)) continue;
    const px = player.homeTower.col + 1;
    const py = player.homeTower.row + 1;
    let ex = 0, ey = 0, count = 0;
    for (const other of state.players) {
      if (other.id === player.id || !isPlayerActive(other)) continue;
      ex += other.homeTower.col + 1;
      ey += other.homeTower.row + 1;
      count++;
    }
    let facing = 0;
    if (count > 0) {
      ex /= count;
      ey /= count;
      const dx = ex - px;
      const dy = ey - py;
      facing = snapAngle(Math.atan2(dx, -dy), Math.PI / 2); // 0 = up, snapped to 90°
    }
    player.defaultFacing = facing;
    for (const cannon of player.cannons) {
      cannon.facing = facing;
    }
  }
}

/** Mark a player as having reselected a castle this round. */
export function markPlayerReselected(state: GameState, playerId: number): void {
  state.reselectedPlayers.add(playerId);
}

/**
 * Compute the total cannon slot limit for a player this round.
 * `isReselected` is true for players who just chose a new castle after losing a life.
 */
function cannonSlotsForRound(
  player: Player,
  state: GameState,
): number {
  const existingSlots = cannonSlotsUsed(player);
  let newSlots: number;
  if (state.reselectedPlayers.has(player.id)) {
    newSlots = Math.min(
      state.firstRoundCannons + (STARTING_LIVES - player.lives),
      MAX_CANNON_LIMIT_ON_RESELECT,
    );
  } else if (state.round === 1) {
    newSlots = state.firstRoundCannons;
  } else {
    const aliveTowers = getAliveOwnedTowers(player, state);
    const ownsHome = player.homeTower && aliveTowers.some(t => t === player.homeTower);
    const otherCount = aliveTowers.length - (ownsHome ? 1 : 0);
    newSlots = (ownsHome ? 2 : 0) + otherCount;
  }
  return existingSlots + newSlots;
}

/** Compute cannon limits for the upcoming cannon phase, store in state, and consume reselection markers. */
export function computeCannonLimitsForPhase(state: GameState): void {
  state.cannonLimits = state.players.map((player) => cannonSlotsForRound(player, state));
  state.reselectedPlayers.clear();
}

/**
 * Check if any player failed to enclose a tower. Decrement lives, reset their zone.
 * Returns { needsReselect, eliminated } — caller handles controller notifications.
 */
function applyLifePenalties(
  state: GameState,
): { needsReselect: number[]; eliminated: number[] } {
  const needsReselect: number[] = [];
  const eliminated: number[] = [];
  for (const player of state.players) {
    if (player.eliminated) continue;
    const hasAliveTower = getAliveOwnedTowers(player, state).length > 0;
    if (!hasAliveTower) {
      player.lives--;
      const zone = state.playerZones[player.id];
      clearPlayerState(player);
      if (player.lives <= 0) {
        player.eliminated = true;
        eliminated.push(player.id);
      } else {
        needsReselect.push(player.id);
      }
      if (zone !== undefined) resetZoneState(state, zone);
    }
  }
  return { needsReselect, eliminated };
}

/**
 * Complete the build phase using the canonical gameplay rules.
 * Owns wall sweeping, territory/tower revival, and the life check.
 */
export function finalizeBuildPhase(
  state: GameState,
): { needsReselect: number[]; eliminated: number[] } {
  sweepAllPlayersWalls(state);
  claimTerritory(state, true);
  return applyLifePenalties(state);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Prepare castle walls for all players, returning ordered wall tiles per player
 *  for animated construction. Sets castle but does NOT add walls or interior. */
export function prepareCastleWallsForPlayer(state: GameState, playerId: number): { playerId: number; tiles: number[] } | null {
  const player = state.players[playerId];
  if (!player?.homeTower) return null;
  const castle = buildCastle(player.homeTower, state.map.tiles, state.map.towers);
  player.castle = castle;

  // Get wall tiles and apply clumsy builders to a temp set
  const wallTiles = getCastleWallTiles(castle, state.map.tiles);
  const tempWalls = new Set<number>();
  for (const [r, c] of wallTiles) tempWalls.add(packTile(r, c));
  applyClumsyBuilders(tempWalls, castle, state.map.tiles, state.rng, state.map.towers);

  // Order tiles: walk the clean ring in perimeter order, then interleave
  // any extra tiles from clumsy builders right after their ring neighbor.
  const { left, top, right, bottom } = castle;
  const wL = left - 1, wR = right + 1, wT = top - 1, wB = bottom + 1;

  // 1. Build the clean ring walk (clockwise or counterclockwise)
  const ringSet = new Set<number>();
  for (const [r, c] of wallTiles) ringSet.add(packTile(r, c));

  const ringWalk: number[] = [];
  // Top edge (left to right)
  for (let c = wL; c <= wR; c++) { const k = packTile(wT, c); if (ringSet.has(k)) ringWalk.push(k); }
  // Right edge (top+1 to bottom)
  for (let r = wT + 1; r <= wB; r++) { const k = packTile(r, wR); if (ringSet.has(k)) ringWalk.push(k); }
  // Bottom edge (right-1 to left)
  for (let c = wR - 1; c >= wL; c--) { const k = packTile(wB, c); if (ringSet.has(k)) ringWalk.push(k); }
  // Left edge (bottom-1 to top+1)
  for (let r = wB - 1; r > wT; r--) { const k = packTile(r, wL); if (ringSet.has(k)) ringWalk.push(k); }

  // Randomly reverse for counterclockwise
  if (state.rng.bool(0.5)) ringWalk.reverse();

  // 2. Find extra tiles added by clumsy builders (in tempWalls but not in ringSet)
  const extras = new Set<number>();
  for (const k of tempWalls) {
    if (!ringSet.has(k)) extras.add(k);
  }
  // Some ring tiles may have been removed by clumsy builders
  // (sweep phase removes tiles with ≤1 neighbor). Filter ring walk.
  const activeRing = ringWalk.filter(k => tempWalls.has(k));

  // 3. Interleave: after each ring tile, insert any adjacent extras
  const ordered: number[] = [];
  const placed = new Set<number>();
  for (const k of activeRing) {
    if (placed.has(k)) continue;
    ordered.push(k);
    placed.add(k);
    // Insert any extras adjacent to this ring tile
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
  for (const k of tempWalls) {
    if (!placed.has(k)) ordered.push(k);
  }

  return { playerId: player.id, tiles: ordered };
}

function prepareCastleWalls(state: GameState): { playerId: number; tiles: number[] }[] {
  const result: { playerId: number; tiles: number[] }[] = [];
  for (const player of state.players) {
    const plan = prepareCastleWallsForPlayer(state, player.id);
    if (plan) result.push(plan);
  }
  return result;
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

export function resetZoneState(state: GameState, zone: number): void {
  state.grunts = state.grunts.filter(
    (grunt) => state.map.zones[grunt.row]?.[grunt.col] !== zone,
  );
  state.map.houses = state.map.houses.filter((house) => house.zone !== zone);
  state.burningPits = state.burningPits.filter(
    (pit) => state.map.zones[pit.row]?.[pit.col] !== zone,
  );
  for (let towerIndex = 0; towerIndex < state.map.towers.length; towerIndex++) {
    if (state.map.towers[towerIndex]!.zone === zone) {
      state.towerAlive[towerIndex] = true;
    }
  }
}

function getAliveOwnedTowers(player: Player, state: GameState) {
  return player.ownedTowers.filter((tower) => state.towerAlive[tower.index]!);
}

/**
 * Sweep one layer of debris wall tiles (0 or 1 orthogonal neighbor).
 * Collects all isolated tiles first, then removes them in one batch.
 */
function sweepIsolatedWalls(walls: Set<number>): void {
  const toRemove: number[] = [];
  for (const key of walls) {
    const { r, c } = unpackTile(key);
    if (countWallNeighbors(walls, r, c) <= 1) toRemove.push(key);
  }
  for (const key of toRemove) walls.delete(key);
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

/** Initialize build phase controllers — reset facings, clear accumulators. */
export function initBuildPhase(
  state: GameState,
  controllers: PlayerController[],
  skipController?: (playerId: number) => boolean,
): void {
  resetCannonFacings(state);
  for (const ctrl of controllers) {
    if (skipController?.(ctrl.playerId)) continue;
    ctrl.startBuild(state);
  }
}
