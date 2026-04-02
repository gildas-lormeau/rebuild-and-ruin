/**
 * Phase transition recipes, lifecycle, and preparation helpers.
 *
 * Owns the multi-step sequences that run when entering/leaving a phase:
 * wall sweeping, territory claiming, life penalties, castle construction,
 * cannon limits, grunt spawning, and battle cleanup.
 *
 * game-engine.ts keeps the state machine (nextPhase switch) and state factory;
 * it imports the enter* functions from here.
 */

import { cleanupBalloonHitTrackingAfterBattle } from "./battle-system.ts";
import {
  addPlayerWalls,
  clearPlayerWalls,
  collectAllWalls,
  filterAliveOwnedTowers,
  sweepIsolatedWalls,
} from "./board-occupancy.ts";
import {
  finalizeTerritory,
  recheckTerritory,
  removeBonusSquaresCoveredByWalls,
  replenishBonusSquares,
} from "./build-system.ts";
import {
  cannonSlotsForRound,
  computeDefaultFacings,
  findNearestValidCannonPlacement,
  resetCannonFacings,
} from "./cannon-system.ts";
import {
  applyClumsyBuilders,
  computeCastleWallTiles,
  createCastle,
  orderCastleWallsForAnimation,
  spawnHousesInZone,
  startOfBuildPhaseHousekeeping,
} from "./castle-generation.ts";
import {
  comboDemolitionBonus,
  createComboTracker,
  isCombosEnabled,
} from "./combo-system.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import {
  BATTLE_TIMER,
  FIRST_GRUNT_SPAWN_ROUND,
  INTERBATTLE_GRUNT_SPAWN_ATTEMPTS,
  INTERBATTLE_GRUNT_SPAWN_CHANCE,
  MID,
} from "./game-constants.ts";
import {
  rollGruntWallAttacks,
  spawnGruntGroupOnZone,
  spawnGruntOnZone,
  updateGruntBlockedBattles,
} from "./grunt-system.ts";
import {
  applyCrumblingWalls,
  applyFrozenRiver,
  applyGruntSurge,
  applyWildfire,
  clearFrozenRiver,
  rollModifier,
} from "./round-modifiers.ts";
import { isBalloonCannon, packTile } from "./spatial.ts";
import {
  CannonMode,
  emptyFreshInterior,
  type GameState,
  isPlayerAlive,
  isPlayerSeated,
  Phase,
  type Player,
} from "./types.ts";
import { UID } from "./upgrade-defs.ts";
import { generateUpgradeOffers } from "./upgrade-pick.ts";

/** Grunts spawned per player on first battle when nobody fires. */
const IDLE_FIRST_BATTLE_GRUNTS = 2;
/** Extra build seconds per Master Builder upgrade stack. */
const MASTER_BUILDER_BONUS = 5;

/** Rebuild a player's home castle from scratch (used when continuing after losing a life). */
export function rebuildHomeCastle(state: GameState, player: Player): void {
  if (!player.homeTower) return;
  resetPlayerBoardState(player, { keepHomeTower: true });
  const plan = prepareCastleWallsForPlayer(state, player.id);
  if (!plan) return;
  addPlayerWalls(player, plan.tiles);
  player.castleWallTiles = new Set(plan.tiles);
  // Destroy houses under rebuilt castle walls
  for (const house of state.map.houses) {
    if (!house.alive) continue;
    if (player.walls.has(packTile(house.row, house.col))) {
      house.alive = false;
    }
  }
  // Remove bonus squares under new walls
  removeBonusSquaresCoveredByWalls(state, player.walls);
  recheckTerritory(state);
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
  finalizeTerritory(state);
  return applyLifePenalties(state);
}

/** Finalize castle construction — claim territory, refill houses, replenish bonus squares. */
export function finalizeCastleConstruction(state: GameState): void {
  recheckTerritory(state);
  startOfBuildPhaseHousekeeping(state);
  replenishBonusSquares(state);
}

/** Advance state through nextPhase until CANNON_PLACE is reached. */
export function advanceToCannonPlacePhase(
  state: GameState,
  nextPhase: (state: GameState) => void,
): void {
  // Safety limit: at most 5 transitions to reach CANNON_PLACE (SELECT→BUILD→CANNON = 2–3).
  // Prevents infinite loops if phase logic has a bug.
  const PHASE_ADVANCE_LIMIT = 5;
  for (
    let i = 0;
    i < PHASE_ADVANCE_LIMIT && state.phase !== Phase.CANNON_PLACE;
    i++
  ) {
    nextPhase(state);
  }
}

/** Prepare state for cannon phase: compute limits and default facings.
 *  Does NOT apply facings to existing cannons (the banner captures old
 *  facings first, then applyDefaultFacings runs after the snapshot).
 *  Does NOT init controllers — call initControllerForCannonPhase separately. */
export function prepareCannonPhase(state: GameState): void {
  computeCannonLimitsForPhase(state);
  computeDefaultFacings(state);
}

/** Initialize a single controller for the cannon phase: place cannons, snap
 *  cursor to nearest valid position near home tower, fire onCannonPhaseStart.
 *  Used by both host (startCannonPhase loop) and watcher (handleCannonStartTransition). */
export function initControllerForCannonPhase(
  ctrl: PlayerController,
  state: GameState,
): void {
  const player = state.players[ctrl.playerId];
  if (!isPlayerAlive(player)) return;
  const max = state.cannonLimits[player.id] ?? 0;
  ctrl.placeCannons(state, max);
  if (player.homeTower) {
    const tower = player.homeTower;
    const snapped = findNearestValidCannonPlacement(
      player,
      tower.row,
      tower.col,
      CannonMode.NORMAL,
      state,
    );
    ctrl.cannonCursor = snapped ?? { row: tower.row, col: tower.col };
  }
  ctrl.onCannonPhaseStart(state);
}

/** Compute cannon limits for the upcoming cannon phase, store in state, and consume reselection markers. */
export function computeCannonLimitsForPhase(state: GameState): void {
  state.cannonLimits = state.players.map((player) =>
    cannonSlotsForRound(player, state),
  );
  state.reselectedPlayers.clear();
}

/** Initialize build phase controllers — reset facings, clear accumulators. */
export function initBuildPhaseControllers(
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
 *  Callers must call initBuildPhaseControllers() afterwards to init controllers. */
export function enterBuildFromSelect(state: GameState): void {
  autoBuildCastles(state);
  replenishBonusSquares(state);
  setPhase(state, Phase.WALL_BUILD);
  state.timer = 0;
}

/** Enter build from reselection — castles already exist, just set phase.
 *  Callers must call initBuildPhaseControllers() afterwards to init controllers. */
export function enterBuildFromReselect(state: GameState): void {
  setPhase(state, Phase.WALL_BUILD);
  state.timer = 0;
}

export function enterBattleFromCannon(state: GameState): void {
  // Decay burning pits at the start of each battle (not after — so pits
  // created during a battle remain at full intensity through repair/cannon)
  for (const pit of state.burningPits) pit.roundsLeft--;
  state.burningPits = state.burningPits.filter((pit) => pit.roundsLeft > 0);

  sweepAllPlayersWalls(state);
  recheckTerritory(state);
  // From round 2+, each player has a chance to get grunts spawned on their zone
  if (state.round >= FIRST_GRUNT_SPAWN_ROUND) {
    for (const player of state.players.filter(isPlayerSeated)) {
      for (let i = 0; i < INTERBATTLE_GRUNT_SPAWN_ATTEMPTS; i++) {
        if (state.rng.bool(INTERBATTLE_GRUNT_SPAWN_CHANCE)) {
          spawnGruntOnZone(state, player.id);
        }
      }
    }
  }
  const allWalls = collectAllWalls(state);
  removeBonusSquaresCoveredByWalls(state, allWalls);
  // Thaw frozen river from previous round (before applying new modifier)
  clearFrozenRiver(state);
  // Modern mode: apply battle-start modifiers
  if (state.activeModifier === MID.WILDFIRE) {
    applyWildfire(state);
    recheckTerritory(state);
  }
  if (state.activeModifier === MID.GRUNT_SURGE) applyGruntSurge(state);
  if (state.activeModifier === MID.FROZEN_RIVER) applyFrozenRiver(state);

  rollGruntWallAttacks(state);
  setPhase(state, Phase.BATTLE);
  state.timer = BATTLE_TIMER;
  state.cannonballs = [];
  state.shotsFired = 0;
  // Modern mode: create combo tracker for this battle
  state.comboTracker = isCombosEnabled(state)
    ? createComboTracker(state.players.length)
    : null;
}

/** Enter build from battle — cleans up battle state (balloons, captured cannons, grunts).
 *  Callers must call initBuildPhaseControllers() afterwards to init controllers. */
export function enterBuildFromBattle(state: GameState): void {
  // Modern mode: award demolition bonuses before clearing battle state
  if (state.comboTracker) {
    const bonuses = comboDemolitionBonus(state.comboTracker);
    for (let i = 0; i < bonuses.length; i++) {
      if (bonuses[i]! > 0 && !state.players[i]!.eliminated) {
        state.players[i]!.score += bonuses[i]!;
      }
    }
    state.comboTracker = null;
  }
  updateGruntBlockedBattles(state);
  cleanupBalloonHitTrackingAfterBattle(state);
  state.capturedCannons = [];
  // Remove all balloon bases (they disappear after battle)
  for (const player of state.players) {
    player.cannons = player.cannons.filter((c) => !isBalloonCannon(c));
  }
  // First battle with no shots fired (nobody playing): spawn grouped grunts per player
  if (state.round === 1 && state.shotsFired === 0) {
    for (const player of state.players.filter(isPlayerSeated)) {
      spawnGruntGroupOnZone(state, player.id, IDLE_FIRST_BATTLE_GRUNTS);
    }
  }
  recheckTerritory(state);
  state.round++;

  // Modern mode: roll modifier and generate upgrade offers (RNG consumed
  // before BUILD_START checkpoint so host/watcher/headless all agree)
  state.lastModifierId = state.activeModifier;
  state.activeModifier = rollModifier(state);
  state.pendingUpgradeOffers = generateUpgradeOffers(state);

  replenishBonusSquares(state);
  setPhase(state, Phase.WALL_BUILD);
  // Master Builder: +5s if any alive player has it (check before clearing)
  const hasMasterBuilder = state.players.some(
    (pl) => !pl.eliminated && pl.upgrades.get(UID.MASTER_BUILDER),
  );
  state.timer =
    state.buildTimer + (hasMasterBuilder ? MASTER_BUILDER_BONUS : 0);

  // All upgrades last one round — clear after timer is computed
  for (const player of state.players) {
    player.damagedWalls.clear();
    player.upgrades.clear();
  }
  startOfBuildPhaseHousekeeping(state);

  // Modern mode: apply build-start modifiers (after housekeeping so territory is fresh)
  if (state.activeModifier === MID.CRUMBLING_WALLS) {
    applyCrumblingWalls(state);
    recheckTerritory(state);
  }
}

/**
 * Centralized phase setter — every phase mutation flows through here,
 * making the phase state machine traceable from a single call-site.
 * Online mode uses this to reconcile client phase with server checkpoints.
 */
export function setPhase(state: GameState, phase: Phase): void {
  state.phase = phase;
}

function sweepAllPlayersWalls(state: GameState): void {
  for (const player of state.players) {
    sweepIsolatedWalls(player);
  }
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
      resetPlayerBoardState(player);
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

/** Mark a player as permanently eliminated (sets eliminated flag + zeroes lives).
 *  Used when the player abandons in the life-lost dialog.
 *  Contrast with resetPlayerBoardState which resets board state but keeps the player alive. */
export function eliminatePlayer(player: Player): void {
  player.eliminated = true;
  player.lives = 0;
}

/** Reset a player's board state (walls, interior, cannons, towers, castle) for a new round.
 *  The player remains in the game — only their placed objects are cleared.
 *  Contrast with eliminatePlayer which permanently removes the player.
 *  Called at the start of each build round (and during reselection with keepHomeTower). */
function resetPlayerBoardState(
  player: Player,
  options?: { keepHomeTower?: boolean },
): void {
  clearPlayerWalls(player);
  player.interior = emptyFreshInterior();
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
    addPlayerWalls(player, plan.tiles);
    player.castleWallTiles = new Set(plan.tiles);
  }
  recheckTerritory(state);
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
