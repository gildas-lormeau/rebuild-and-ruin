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

import { CannonMode } from "../shared/battle-types.ts";
import {
  addPlayerWalls,
  clearPlayerWalls,
  collectAllWalls,
  filterAliveOwnedTowers,
  sweepIsolatedWalls,
} from "../shared/board-occupancy.ts";
import { FID } from "../shared/feature-defs.ts";
import {
  BATTLE_TIMER,
  MASTER_BUILDER_BONUS_SECONDS,
  MODIFIER_ID,
  type ModifierDiff,
} from "../shared/game-constants.ts";
import { Phase } from "../shared/game-phase.ts";
import { modifierDef } from "../shared/modifier-defs.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import {
  eliminatePlayer,
  emptyFreshInterior,
  isPlayerAlive,
  isPlayerSeated,
  type Player,
} from "../shared/player-types.ts";
import {
  isBalloonCannon,
  packTile,
  setGrass,
  unpackTile,
} from "../shared/spatial.ts";
import type {
  ControllerIdentity,
  SelectionController,
} from "../shared/system-interfaces.ts";
import {
  type GameState,
  hasFeature,
  type UpgradeOfferTuple,
} from "../shared/types.ts";
import {
  IMPLEMENTED_UPGRADES,
  UID,
  type UpgradeId,
} from "../shared/upgrade-defs.ts";
import { cleanupBalloonHitTrackingAfterBattle } from "./battle-system.ts";
import {
  finalizeTerritoryWithScoring,
  recheckTerritoryOnly,
  removeBonusSquaresCoveredByWalls,
  replenishBonusSquares,
} from "./build-system.ts";
import {
  cannonSlotsForRound,
  computeDefaultFacings,
  filterActiveFiringCannons,
  findNearestValidCannonPlacement,
  isCannonEnclosed,
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
import {
  queueInterbattleGrunts,
  rollGruntWallAttacks,
  spawnGruntGroupOnZone,
  updateGruntBlockedBattles,
} from "./grunt-system.ts";
import {
  applyCrumblingWalls,
  applyFrozenRiver,
  applyGruntSurge,
  applySinkhole,
  applyWildfire,
  clearFrozenRiver,
  rollModifier,
} from "./round-modifiers.ts";

interface ScoreDelta {
  playerId: ValidPlayerSlot;
  delta: number;
  total: number;
}

/** Grunts spawned per player on first battle when nobody fires. */
const IDLE_FIRST_BATTLE_GRUNTS = 2;
/** Number of upgrade choices offered per pick. */
const OFFER_COUNT = 3;
/** First round that triggers upgrade picks (modern mode). */
const UPGRADE_FIRST_ROUND = 3;
const SUPPLY_DROP_BONUS = 2;

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

/** Prepare state for cannon phase: compute limits and default facings.
 *  Does NOT apply facings to existing cannons (the banner captures old
 *  facings first, then applyDefaultFacings runs after the snapshot).
 *  Does NOT init controllers — call prepareControllerCannonPhase separately. */
export function prepareCannonPhase(state: GameState): void {
  computeCannonLimitsForPhase(state);
  computeDefaultFacings(state);
  state.timer = state.cannonPlaceTimer;
}

/** Compute cannon-phase init data for a single player.
 *  Pure computation — no controller interaction.
 *  Used by both host (startCannonPhase loop) and watcher (handleCannonStartTransition).
 *  PRECONDITION: phase must already be CANNON_PLACE (set by enterCannonPlacePhase).
 *  Returns null for eliminated players (no init needed). */
export function prepareControllerCannonPhase(
  playerId: ValidPlayerSlot,
  state: GameState,
): { maxSlots: number; cursorPos: { row: number; col: number } } | null {
  if (state.phase !== Phase.CANNON_PLACE) {
    throw new Error(
      `prepareControllerCannonPhase called in ${Phase[state.phase]} — must be CANNON_PLACE`,
    );
  }
  const player = state.players[playerId];
  if (!isPlayerAlive(player)) return null;
  const maxSlots = state.cannonLimits[player.id] ?? 0;
  let cursorPos = {
    row: player.homeTower?.row ?? 0,
    col: player.homeTower?.col ?? 0,
  };
  if (player.homeTower) {
    const snapped = findNearestValidCannonPlacement(
      player,
      player.homeTower.row,
      player.homeTower.col,
      CannonMode.NORMAL,
      state,
    );
    if (snapped) cursorPos = snapped;
  }
  return { maxSlots, cursorPos };
}

/** Compute cannon limits for the upcoming cannon phase, store in state, and consume reselection markers. */
export function computeCannonLimitsForPhase(state: GameState): void {
  state.cannonLimits = state.players.map((player, idx) => {
    const base = cannonSlotsForRound(player, state);
    const supplyDrop = player.upgrades.get(UID.SUPPLY_DROP)
      ? SUPPLY_DROP_BONUS
      : 0;
    const salvage = state.salvageSlots[idx] ?? 0;
    return base + supplyDrop + salvage;
  });
  state.salvageSlots = state.players.map(() => 0);
  state.reselectedPlayers.clear();
}

/** Enter build from initial castle selection — builds castles first.
 *  Callers must init controllers afterwards (resetCannonFacings + startBuildPhase loop). */
export function enterBuildFromSelect(state: GameState): void {
  autoBuildCastles(state);
  replenishBonusSquares(state);
  setPhase(state, Phase.WALL_BUILD);
  state.timer = 0;
}

/** Enter build from reselection — castles already exist, just set phase.
 *  Callers must init controllers afterwards (resetCannonFacings + startBuildPhase loop). */
export function enterBuildFromReselect(state: GameState): void {
  if (hasFeature(state, FID.UPGRADES)) {
    state.modern!.masterBuilderLockout = 0;
    state.modern!.masterBuilderOwners = null;
  }
  setPhase(state, Phase.WALL_BUILD);
  state.timer = 0;
}

export function enterBattleFromCannon(state: GameState): ModifierDiff | null {
  decayBurningPits(state);
  sweepAllPlayersWalls(state);
  recheckTerritoryOnly(state);
  removeBonusSquaresCoveredByWalls(state, collectAllWalls(state));
  clearFrozenRiver(state);
  // Roll modifier at battle start so it isn't spoiled in the status bar during build.
  // Assignment order matters: save current modifier BEFORE rolling, because
  // rollModifier filters out lastModifierId to prevent back-to-back repeats.
  if (hasFeature(state, FID.MODIFIERS)) {
    state.modern!.lastModifierId = state.modern!.activeModifier;
    state.modern!.activeModifier = rollModifier(state);
  }
  const diff = applyBattleStartModifiers(state);
  rollGruntWallAttacks(state);
  setPhase(state, Phase.BATTLE);
  state.timer = BATTLE_TIMER;
  state.cannonballs = [];
  state.shotsFired = 0;
  electMortarCannons(state);
  if (hasFeature(state, FID.COMBOS)) {
    state.modern!.comboTracker = isCombosEnabled(state)
      ? createComboTracker(state.players.length)
      : null;
  }
  return diff;
}

/** Ceasefire: skip battle entirely — do pre-battle housekeeping then go straight to build.
 *  Performs the same cleanup as enterBattleFromCannon (decay pits, sweep walls)
 *  but skips modifiers, grunt attacks, and battle setup. */
export function enterBuildSkippingBattle(state: GameState): void {
  decayBurningPits(state);
  sweepAllPlayersWalls(state);
  recheckTerritoryOnly(state);
  removeBonusSquaresCoveredByWalls(state, collectAllWalls(state));
  clearFrozenRiver(state);
  enterBuildFromBattle(state);
}

/** Enter build from battle — cleans up battle state (balloons, captured cannons, grunts).
 *  Callers must init controllers afterwards (resetCannonFacings + startBuildPhase loop). */
export function enterBuildFromBattle(state: GameState): void {
  awardComboBonuses(state);
  cleanupBattleArtifacts(state);
  spawnIdleFirstBattleGrunts(state);
  recheckTerritoryOnly(state);
  state.round++;

  // ── RNG consumption (BEFORE checkpoint — order is load-bearing for online sync) ──
  // host/watcher/headless must consume RNG identically before BUILD_START checkpoint
  // is created. Do NOT insert RNG calls after this block or move these after setPhase.
  queueInterbattleGrunts(state);
  if (hasFeature(state, FID.UPGRADES)) {
    state.modern!.pendingUpgradeOffers = generateUpgradeOffers(state);
  }

  replenishBonusSquares(state);
  setPhase(state, Phase.WALL_BUILD);

  // Master Builder lockout: check before clearing upgrades.
  // - 1 owner → exclusive 5s head start, others locked out
  // - 2+ owners → everyone gets +5s (cancels out competitively), no lockout
  // - 0 owners → normal timer
  if (hasFeature(state, FID.UPGRADES)) {
    const mbPlayers = state.players.filter(
      (player) => !player.eliminated && player.upgrades.get(UID.MASTER_BUILDER),
    );
    const hasMasterBuilder = mbPlayers.length > 0;
    state.modern!.masterBuilderOwners = hasMasterBuilder
      ? new Set(mbPlayers.map((player) => player.id))
      : null;
    state.modern!.masterBuilderLockout =
      mbPlayers.length === 1 ? MASTER_BUILDER_BONUS_SECONDS : 0;
    state.timer =
      state.buildTimer + (hasMasterBuilder ? MASTER_BUILDER_BONUS_SECONDS : 0);
  } else {
    state.timer = state.buildTimer;
  }

  resetPlayerUpgrades(state);
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

/** Generate upgrade offers for all alive players. Uses state.rng for determinism.
 *  Called from enterBuildFromBattle so the RNG is consumed before the
 *  BUILD_START checkpoint is sent. Returns null if not applicable. */
export function generateUpgradeOffers(
  state: GameState,
): Map<ValidPlayerSlot, UpgradeOfferTuple> | null {
  if (!hasFeature(state, FID.UPGRADES)) return null;
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
  reselectQueue: ValidPlayerSlot[];
  reselectionPids: ValidPlayerSlot[];
  finalizeAndAdvance: () => void;
}): void {
  const { state, selectionStates, resetOverlaySelection, reselectionPids } =
    params;
  selectionStates.clear();
  resetOverlaySelection();
  params.reselectQueue.length = 0;

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

/** Compute per-player score deltas from the build phase.
 *  Returns only positive deltas for non-eliminated players.
 *  Callers add pixel positions for rendering (see runtime-score-deltas.ts). */
export function computeScoreDeltas(
  players: GameState["players"],
  preScores: readonly number[],
): ScoreDelta[] {
  return players
    .map((player, idx) => ({
      playerId: idx as ValidPlayerSlot,
      delta: player.score - (preScores[idx] ?? 0),
      total: player.score,
    }))
    .filter((entry) => entry.delta > 0 && !players[entry.playerId]!.eliminated);
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
  // Clear breach-queued grunts targeting this zone's player
  state.gruntSpawnQueue = state.gruntSpawnQueue.filter(
    (entry) => state.playerZones[entry.victimPlayerId] !== zone,
  );
  state.map.houses = state.map.houses.filter((house) => house.zone !== zone);
  state.bonusSquares = state.bonusSquares.filter(
    (bonus) => bonus.zone !== zone,
  );
  state.burningPits = state.burningPits.filter(
    (pit) => state.map.zones[pit.row]?.[pit.col] !== zone,
  );
  // Revert sinkhole tiles on this zone back to grass
  const sinkhole = state.modern?.sinkholeTiles;
  if (sinkhole) {
    for (const key of sinkhole) {
      const { r, c } = unpackTile(key);
      if (state.map.zones[r]?.[c] === zone) {
        setGrass(state.map.tiles, r, c);
        sinkhole.delete(key);
      }
    }
    if (sinkhole.size === 0) state.modern!.sinkholeTiles = null;
    state.map.mapVersion++;
  }
  for (let towerIndex = 0; towerIndex < state.map.towers.length; towerIndex++) {
    if (state.map.towers[towerIndex]!.zone === zone) {
      state.towerAlive[towerIndex] = true;
    }
  }
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

/** Modern mode: apply environmental modifiers at battle start.
 *  Returns a ModifierDiff for the reveal banner, or null if no modifier fired. */
function applyBattleStartModifiers(state: GameState): ModifierDiff | null {
  const mod = state.modern?.activeModifier;
  if (!mod) return null;
  const { label } = modifierDef(mod);
  if (mod === MODIFIER_ID.WILDFIRE) {
    const scar = applyWildfire(state);
    recheckTerritoryOnly(state);
    return { id: mod, label, changedTiles: [...scar], gruntsSpawned: 0 };
  }
  if (mod === MODIFIER_ID.CRUMBLING_WALLS) {
    const destroyed = applyCrumblingWalls(state);
    recheckTerritoryOnly(state);
    return { id: mod, label, changedTiles: destroyed, gruntsSpawned: 0 };
  }
  if (mod === MODIFIER_ID.GRUNT_SURGE) {
    const count = applyGruntSurge(state);
    return { id: mod, label, changedTiles: [], gruntsSpawned: count };
  }
  if (mod === MODIFIER_ID.FROZEN_RIVER) {
    const frozen = applyFrozenRiver(state);
    return { id: mod, label, changedTiles: [...frozen], gruntsSpawned: 0 };
  }
  if (mod === MODIFIER_ID.SINKHOLE) {
    const sunk = applySinkhole(state);
    recheckTerritoryOnly(state);
    return { id: mod, label, changedTiles: [...sunk], gruntsSpawned: 0 };
  }
  return null;
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

/** Clean up transient battle state: grunts, balloons, captured cannons, mortar flags. */
function cleanupBattleArtifacts(state: GameState): void {
  updateGruntBlockedBattles(state);
  cleanupBalloonHitTrackingAfterBattle(state);
  state.capturedCannons = [];
  for (const player of state.players) {
    player.cannons = player.cannons.filter(
      (cannon) => !isBalloonCannon(cannon),
    );
    // Clear mortar election (lasts one battle round)
    for (const cannon of player.cannons) {
      cannon.mortar = undefined;
    }
  }
}

/** Elect one mortar cannon per player who has the Mortar upgrade.
 *  Only standard (normal) cannons are eligible — super guns and balloons are excluded.
 *  If a player has no normal cannons, the upgrade is silently skipped.
 *  Uses synced RNG so election is deterministic for online play.
 *  Must be called after setPhase(BATTLE) and before any RNG-consuming
 *  code that follows in the battle-start sequence. */
function electMortarCannons(state: GameState): void {
  for (const player of state.players) {
    if (player.eliminated) continue;
    if (!player.upgrades.get(UID.MORTAR)) continue;
    const normalCannons = filterActiveFiringCannons(player).filter(
      (cannon) =>
        cannon.mode === CannonMode.NORMAL && isCannonEnclosed(cannon, player),
    );
    if (normalCannons.length === 0) continue;
    const elected = state.rng.pick(normalCannons);
    elected.mortar = true;
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

/** Draw N unique upgrades from the implemented pool using state.rng. */
function drawOffers(state: GameState): [UpgradeId, UpgradeId, UpgradeId] {
  const pool = [...IMPLEMENTED_UPGRADES];
  const picked: UpgradeId[] = [];

  for (let i = 0; i < OFFER_COUNT && pool.length > 0; i++) {
    const totalWeight = pool.reduce((sum, def) => sum + def.weight, 0);
    let roll = state.rng.next() * totalWeight;
    let chosenIdx = pool.length - 1;
    for (let poolIdx = 0; poolIdx < pool.length; poolIdx++) {
      roll -= pool[poolIdx]!.weight;
      if (roll <= 0) {
        chosenIdx = poolIdx;
        break;
      }
    }
    picked.push(pool[chosenIdx]!.id);
    pool.splice(chosenIdx, 1);
  }

  return picked as [UpgradeId, UpgradeId, UpgradeId];
}
