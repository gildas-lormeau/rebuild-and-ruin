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
  finalizeTerritoryWithScoring,
  recheckTerritoryOnly,
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
import type {
  ControllerIdentity,
  PlayerController,
  SelectionController,
} from "./controller-interfaces.ts";
import {
  BATTLE_TIMER,
  FIRST_GRUNT_SPAWN_ROUND,
  GAME_MODE_MODERN,
  INTERBATTLE_GRUNT_SPAWN_ATTEMPTS,
  INTERBATTLE_GRUNT_SPAWN_CHANCE,
  MODIFIER_ID,
  type ValidPlayerSlot,
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
  type UpgradeOfferTuple,
} from "./types.ts";
import { IMPLEMENTED_UPGRADES, UID, type UpgradeId } from "./upgrade-defs.ts";

/** Grunts spawned per player on first battle when nobody fires. */
const IDLE_FIRST_BATTLE_GRUNTS = 2;
/** Extra build seconds per Master Builder upgrade stack. */
const MASTER_BUILDER_BONUS_SECONDS = 5;
/** Number of upgrade choices offered per pick. */
const OFFER_COUNT = 3;
/** First round that triggers upgrade picks (modern mode). */
const UPGRADE_FIRST_ROUND = 3;

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
  recheckTerritoryOnly(state);
}

/**
 * Complete the build phase using the canonical gameplay rules.
 * Owns wall sweeping, territory/tower revival, and the life check.
 */
export function finalizeBuildPhase(state: GameState): {
  needsReselect: ValidPlayerSlot[];
  eliminated: ValidPlayerSlot[];
} {
  sweepAllPlayersWalls(state);
  finalizeTerritoryWithScoring(state);
  return applyLifePenalties(state);
}

/** Finalize castle construction — claim territory, refill houses, replenish bonus squares. */
export function finalizeCastleConstruction(state: GameState): void {
  recheckTerritoryOnly(state);
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
 *  cursor to nearest valid position near home tower, fire startCannonPhase.
 *  Used by both host (startCannonPhase loop) and watcher (handleCannonStartTransition).
 *  PRECONDITION: phase must already be CANNON_PLACE (set by enterCannonPlacePhase). */
export function initControllerForCannonPhase(
  ctrl: PlayerController,
  state: GameState,
): void {
  if (state.phase !== Phase.CANNON_PLACE) {
    throw new Error(
      `initControllerForCannonPhase called in ${Phase[state.phase]} — must be CANNON_PLACE`,
    );
  }
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
  ctrl.startCannonPhase(state);
}

/** Compute cannon limits for the upcoming cannon phase, store in state, and consume reselection markers. */
export function computeCannonLimitsForPhase(state: GameState): void {
  state.cannonLimits = state.players.map((player) =>
    cannonSlotsForRound(player, state),
  );
  state.reselectedPlayers.clear();
}

/** Initialize build phase controllers — reset facings, clear accumulators.
 *  PRECONDITION: phase must already be WALL_BUILD (set by enterBuildFrom*). */
export function initBuildPhaseControllers(
  state: GameState,
  controllers: readonly PlayerController[],
  skipController?: (playerId: ValidPlayerSlot) => boolean,
): void {
  if (state.phase !== Phase.WALL_BUILD) {
    throw new Error(
      `initBuildPhaseControllers called in ${Phase[state.phase]} — must be WALL_BUILD`,
    );
  }
  resetCannonFacings(state);
  for (const ctrl of controllers) {
    if (skipController?.(ctrl.playerId)) continue;
    const player = state.players[ctrl.playerId];
    if (player?.eliminated) continue;
    ctrl.startBuildPhase(state);
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
  decayBurningPits(state);
  sweepAllPlayersWalls(state);
  recheckTerritoryOnly(state);
  spawnInterbattleGrunts(state);
  removeBonusSquaresCoveredByWalls(state, collectAllWalls(state));
  clearFrozenRiver(state);
  applyBattleStartModifiers(state);
  rollGruntWallAttacks(state);
  setPhase(state, Phase.BATTLE);
  state.timer = BATTLE_TIMER;
  state.cannonballs = [];
  state.shotsFired = 0;
  if (state.modern) {
    state.modern.comboTracker = isCombosEnabled(state)
      ? createComboTracker(state.players.length)
      : null;
  }
}

/** Enter build from battle — cleans up battle state (balloons, captured cannons, grunts).
 *  Callers must call initBuildPhaseControllers() afterwards to init controllers. */
export function enterBuildFromBattle(state: GameState): void {
  awardComboBonuses(state);
  cleanupBattleArtifacts(state);
  spawnIdleFirstBattleGrunts(state);
  recheckTerritoryOnly(state);
  state.round++;

  // ── RNG consumption (BEFORE checkpoint — order is load-bearing for online sync) ──
  // host/watcher/headless must consume RNG identically before BUILD_START checkpoint
  // is created. Do NOT insert RNG calls after this block or move these after setPhase.
  // Assignment order matters: save current modifier BEFORE rolling, because
  // rollModifier filters out lastModifierId to prevent back-to-back repeats.
  if (state.modern) {
    state.modern.lastModifierId = state.modern.activeModifier;
    state.modern.activeModifier = rollModifier(state);
    state.modern.pendingUpgradeOffers = generateUpgradeOffers(state);
  }

  replenishBonusSquares(state);
  setPhase(state, Phase.WALL_BUILD);
  // Master Builder: +5s if any alive player has it (check before clearing upgrades)
  const hasMasterBuilder = state.players.some(
    (pl) => !pl.eliminated && pl.upgrades.get(UID.MASTER_BUILDER),
  );
  state.timer =
    state.buildTimer + (hasMasterBuilder ? MASTER_BUILDER_BONUS_SECONDS : 0);
  resetPlayerUpgrades(state);
  startOfBuildPhaseHousekeeping(state);
  applyBuildStartModifiers(state);
}

/**
 * Centralized phase setter — every phase mutation flows through here,
 * making the phase state machine traceable from a single call-site.
 * Online mode uses this to reconcile client phase with server checkpoints.
 */
export function setPhase(state: GameState, phase: Phase): void {
  state.phase = phase;
}

/** Generate upgrade offers for all alive players. Uses state.rng for determinism.
 *  Called from enterBuildFromBattle so the RNG is consumed before the
 *  BUILD_START checkpoint is sent. Returns null if not applicable. */
export function generateUpgradeOffers(
  state: GameState,
): Map<ValidPlayerSlot, UpgradeOfferTuple> | null {
  if (state.gameMode !== GAME_MODE_MODERN) return null;
  if (state.round < UPGRADE_FIRST_ROUND) return null;

  const offers = new Map<ValidPlayerSlot, UpgradeOfferTuple>();
  for (const player of state.players) {
    if (player.eliminated || !player.homeTower) continue;
    offers.set(player.id, drawOffers(state));
  }
  return offers.size > 0 ? offers : null;
}

/** Process the reselection queue. Returns players still needing UI interaction.
 *  `processPlayer` returns: "done" (AI picked), "pending" (needs UI), or "remote" (remote human). */
export function processReselectionQueue<
  T extends ControllerIdentity & SelectionController = ControllerIdentity &
    SelectionController,
>(params: {
  reselectQueue: ValidPlayerSlot[];
  state: GameState;
  controllers: T[];
  initTowerSelection: (pid: ValidPlayerSlot, zone: number) => void;
  processPlayer: (
    pid: ValidPlayerSlot,
    ctrl: T,
    zone: number,
  ) => "done" | "pending";
  onDone: (pid: ValidPlayerSlot, ctrl: T) => void;
}): {
  remaining: ValidPlayerSlot[] /** True if any player still needs interactive castle selection. */;
  needsUI: boolean;
} {
  const remaining: ValidPlayerSlot[] = [];
  let needsUI = false;
  for (const pid of params.reselectQueue) {
    const ctrl = params.controllers[pid]!;
    const zone = params.state.playerZones[pid] ?? 0;
    const result = params.processPlayer(pid, ctrl, zone);
    if (result === "done") {
      params.onDone(pid, ctrl);
    } else {
      remaining.push(pid);
      needsUI = true;
      params.initTowerSelection(pid, zone);
    }
  }
  return { remaining, needsUI };
}

/** Finish reselection — clear selection state, reset reselecting players, animate castles. */
export function completeReselection(params: {
  state: GameState;
  selectionStates: Map<number, { highlighted: number; confirmed: boolean }>;
  resetOverlaySelection: () => void;
  reselectQueue: { length: number };
  reselectionPids: ValidPlayerSlot[];
  finalizeAndAdvance: () => void;
}): void {
  const { state, selectionStates, resetOverlaySelection, reselectionPids } =
    params;
  selectionStates.clear();
  resetOverlaySelection();
  (params.reselectQueue as number[]).length = 0;

  // The castle build animation already placed walls (including clumsy extras)
  // via addPlayerWall. Don't rebuild — just do cleanup.
  const pids = new Set(reselectionPids);
  for (const pid of pids) {
    const player = state.players[pid]!;
    if (!player.homeTower) continue;
    // Protect animated walls from debris sweep
    player.castleWallTiles = new Set(player.walls);
    // Destroy houses under rebuilt castle walls
    for (const house of state.map.houses) {
      if (!house.alive) continue;
      if (player.walls.has(packTile(house.row, house.col))) {
        house.alive = false;
      }
    }
  }

  params.finalizeAndAdvance();
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
  needsReselect: ValidPlayerSlot[];
  eliminated: ValidPlayerSlot[];
} {
  const needsReselect: ValidPlayerSlot[] = [];
  const eliminated: ValidPlayerSlot[] = [];
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
  state.grunts = state.grunts.filter((grunt) => {
    if (state.map.zones[grunt.row]?.[grunt.col] === zone) return false;
    // Remove grunts stuck en route to towers in this zone (e.g. frozen river crossings)
    if (grunt.targetTowerIdx !== undefined) {
      if (state.map.towers[grunt.targetTowerIdx]?.zone === zone) return false;
    }
    return true;
  });
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
  recheckTerritoryOnly(state);
  for (const player of state.players) {
    if (player.homeTower) spawnHousesInZone(state, player.homeTower.zone);
  }
}

function prepareCastleWalls(
  state: GameState,
): { playerId: ValidPlayerSlot; tiles: number[] }[] {
  const result: { playerId: ValidPlayerSlot; tiles: number[] }[] = [];
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
  playerId: ValidPlayerSlot,
): { playerId: ValidPlayerSlot; tiles: number[] } | null {
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

/** Decay burning pits at battle start — pits created during a battle
 *  remain at full intensity through repair/cannon phases. */
function decayBurningPits(state: GameState): void {
  for (const pit of state.burningPits) pit.roundsLeft--;
  state.burningPits = state.burningPits.filter((pit) => pit.roundsLeft > 0);
}

/** From round 2+, each seated player has a chance to get grunts spawned on their zone. */
function spawnInterbattleGrunts(state: GameState): void {
  if (state.round < FIRST_GRUNT_SPAWN_ROUND) return;
  for (const player of state.players.filter(isPlayerSeated)) {
    for (let i = 0; i < INTERBATTLE_GRUNT_SPAWN_ATTEMPTS; i++) {
      if (state.rng.bool(INTERBATTLE_GRUNT_SPAWN_CHANCE)) {
        spawnGruntOnZone(state, player.id);
      }
    }
  }
}

/** Modern mode: apply environmental modifiers at battle start. */
function applyBattleStartModifiers(state: GameState): void {
  const mod = state.modern?.activeModifier;
  if (mod === MODIFIER_ID.WILDFIRE) {
    applyWildfire(state);
    recheckTerritoryOnly(state);
  }
  if (mod === MODIFIER_ID.GRUNT_SURGE) applyGruntSurge(state);
  if (mod === MODIFIER_ID.FROZEN_RIVER) applyFrozenRiver(state);
}

/** Award combo demolition bonuses and clear the tracker. */
function awardComboBonuses(state: GameState): void {
  const tracker = state.modern?.comboTracker;
  if (!tracker) return;
  const bonuses = comboDemolitionBonus(tracker);
  for (let i = 0; i < bonuses.length; i++) {
    if (bonuses[i]! > 0 && !state.players[i]!.eliminated) {
      state.players[i]!.score += bonuses[i]!;
    }
  }
  state.modern!.comboTracker = null;
}

/** Clean up transient battle state: grunts, balloons, captured cannons. */
function cleanupBattleArtifacts(state: GameState): void {
  updateGruntBlockedBattles(state);
  cleanupBalloonHitTrackingAfterBattle(state);
  state.capturedCannons = [];
  for (const player of state.players) {
    player.cannons = player.cannons.filter(
      (cannon) => !isBalloonCannon(cannon),
    );
  }
}

/** First battle with no shots fired: spawn grouped grunts as punishment. */
function spawnIdleFirstBattleGrunts(state: GameState): void {
  if (state.round !== 1 || state.shotsFired !== 0) return;
  for (const player of state.players.filter(isPlayerSeated)) {
    spawnGruntGroupOnZone(state, player.id, IDLE_FIRST_BATTLE_GRUNTS);
  }
}

/** All upgrades last one round — clear damaged-wall markers and upgrade maps. */
function resetPlayerUpgrades(state: GameState): void {
  for (const player of state.players) {
    player.damagedWalls.clear();
    player.upgrades.clear();
  }
}

/** Modern mode: apply environmental modifiers at build start. */
function applyBuildStartModifiers(state: GameState): void {
  if (state.modern?.activeModifier === MODIFIER_ID.CRUMBLING_WALLS) {
    applyCrumblingWalls(state);
    recheckTerritoryOnly(state);
  }
}

/** Draw N unique upgrades from the implemented pool using state.rng. */
function drawOffers(state: GameState): [UpgradeId, UpgradeId, UpgradeId] {
  const pool = [...IMPLEMENTED_UPGRADES];
  const picked: UpgradeId[] = [];

  for (let i = 0; i < OFFER_COUNT && pool.length > 0; i++) {
    const totalWeight = pool.reduce((sum, def) => sum + def.weight, 0);
    let roll = state.rng.next() * totalWeight;
    let chosenIdx = pool.length - 1;
    for (let ci = 0; ci < pool.length; ci++) {
      roll -= pool[ci]!.weight;
      if (roll <= 0) {
        chosenIdx = ci;
        break;
      }
    }
    picked.push(pool[chosenIdx]!.id);
    pool.splice(chosenIdx, 1);
  }

  return picked as [UpgradeId, UpgradeId, UpgradeId];
}
