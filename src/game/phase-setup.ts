/**
 * Phase transition recipes, lifecycle, and preparation helpers.
 *
 * Owns the multi-step sequences that run when entering/leaving a phase:
 * wall sweeping, territory claiming, life penalties, castle construction,
 * cannon limits, grunt spawning, and battle cleanup.
 *
 * game-engine.ts keeps the state machine (nextPhase switch) and state factory;
 * it imports the enter* functions from here.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Phase-entry vs start-phase contract — canonical source (applies to every
 * phase defined here, e.g. enterCannonPlacePhase, enterBuildFromBattle,
 * enterBattleFromCannon, enterBuildSkippingBattle):
 *
 *   enterXPhase(state)           — mutates state.phase + timer. Called by
 *                                  nextPhase() (local) or as the
 *                                  `applyCheckpoint` step of executeTransition
 *                                  (online watcher / host after checkpoint).
 *
 *   prepareXPhase(state)         — computes derived state (cannon limits,
 *                                  default facings, combo tracker, modifier
 *                                  roll). Lives in cannon-system.ts /
 *                                  battle-system.ts / phase-setup.ts as
 *                                  appropriate; must run BEFORE the checkpoint
 *                                  is serialized so the computed values ship
 *                                  to watchers.
 *
 *   startXPhase(state, ctrl)     — per-controller initialization (bag reset,
 *                                  cursor placement, battle init). Lives on
 *                                  BaseController. Called as the
 *                                  `initControllers` step of executeTransition
 *                                  after the phase is applied.
 *
 * The split is load-bearing for online play: the host computes `prepareXPhase`
 * state and broadcasts it inside the checkpoint payload; the watcher skips
 * `prepare` entirely and runs only `enter` + `start`. Do NOT collapse the
 * three into one function — the watcher would diverge from the host.
 * ─────────────────────────────────────────────────────────────────────────
 */

import {
  clearPlayerWalls,
  collectAllWalls,
  filterAliveOwnedTowers,
  sweepIsolatedWalls,
} from "../shared/board-occupancy.ts";
import { FID } from "../shared/feature-defs.ts";
import {
  BATTLE_TIMER,
  MODIFIER_ID,
  type ModifierDiff,
} from "../shared/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/game-event-bus.ts";
import { Phase } from "../shared/game-phase.ts";
import { modifierDef } from "../shared/modifier-defs.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import {
  eliminatePlayer,
  emptyFreshInterior,
  isPlayerAlive,
  isPlayerEliminated,
  isPlayerSeated,
  type Player,
} from "../shared/player-types.ts";
import {
  isBalloonCannon,
  packTile,
  setGrass,
  unpackTile,
} from "../shared/spatial.ts";
import { type GameState, hasFeature } from "../shared/types.ts";
import { cleanupBalloonHitTrackingAfterBattle } from "./battle-system.ts";
import {
  finalizeTerritoryWithScoring,
  recheckTerritory,
  removeBonusSquaresCoveredByWalls,
  replenishBonusSquares,
} from "./build-system.ts";
import {
  filterActiveFiringCannons,
  homeEnclosedRegion,
  isCannonEnclosed,
} from "./cannon-system.ts";
import {
  applyClumsyBuilders,
  computeCastleWallTiles,
  createCastle,
  orderCastleWallsForAnimation,
  startOfBuildPhaseHousekeeping,
} from "./castle-generation.ts";
import {
  comboDemolitionBonus,
  createComboTracker,
  isCombosEnabled,
} from "./combo-system.ts";
import {
  rollGruntWallAttacks,
  spawnGruntGroupOnZone,
  spawnInterbattleGrunts,
  updateGruntBlockedBattles,
} from "./grunt-system.ts";
import {
  applyCrumblingWalls,
  applyFrozenRiver,
  applyGruntSurge,
  applyHighTide,
  applyRubbleClearing,
  applySinkhole,
  applyWildfire,
  clearFrozenRiver,
  clearHighTide,
  rollModifier,
} from "./round-modifiers.ts";
import {
  buildTimerBonus,
  generateUpgradeOffers,
  onBattlePhaseStart,
  onBuildPhaseStart,
  resetPlayerUpgrades,
} from "./upgrade-system.ts";

interface ScoreDelta {
  playerId: ValidPlayerSlot;
  delta: number;
  total: number;
}

/** Grunts spawned per player on first battle when nobody fires. */
const IDLE_FIRST_BATTLE_GRUNTS = 2;

/** Finalize castle construction — claim territory, refill houses, replenish bonus squares. */
export function finalizeCastleConstruction(state: GameState): void {
  recheckTerritory(state);
  startOfBuildPhaseHousekeeping(state);
  replenishBonusSquares(state);
}

export function enterBattleFromCannon(state: GameState): ModifierDiff | null {
  decayBurningPits(state);
  sweepAllPlayersWalls(state);
  recheckTerritory(state);
  removeBonusSquaresCoveredByWalls(state, collectAllWalls(state));
  clearFrozenRiver(state);
  clearHighTide(state);
  // Roll modifier at battle start so it isn't spoiled in the status bar during build.
  // lastModifierId was already saved in enterBuildFromBattle (before the checkpoint).
  if (hasFeature(state, FID.MODIFIERS)) {
    state.modern!.activeModifier = rollModifier(state);
    if (state.modern!.activeModifier !== null) {
      emitGameEvent(state.bus, GAME_EVENT.MODIFIER_APPLIED, {
        modifierId: state.modern!.activeModifier,
        round: state.round,
      });
    }
  }
  const diff = applyBattleStartModifiers(state);
  rollGruntWallAttacks(state);
  setPhase(state, Phase.BATTLE);
  state.timer = BATTLE_TIMER;
  state.cannonballs = [];
  state.shotsFired = 0;
  onBattlePhaseStart(state, {
    filterActiveFiringCannons,
    isCannonEnclosed,
    homeEnclosedRegion,
  });
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
  recheckTerritory(state);
  removeBonusSquaresCoveredByWalls(state, collectAllWalls(state));
  clearFrozenRiver(state);
  clearHighTide(state);
  enterBuildFromBattle(state);
}

/** Enter build from battle — cleans up battle state (balloons, captured cannons, grunts).
 *  Callers must init controllers afterwards (resetCannonFacings + startBuildPhase loop). */
export function enterBuildFromBattle(state: GameState): void {
  awardComboBonuses(state);
  cleanupBattleArtifacts(state);
  spawnIdleFirstBattleGrunts(state);
  recheckTerritory(state);
  // Save activeModifier as lastModifierId BEFORE the build-start checkpoint
  // is created — rollModifier reads lastModifierId to prevent back-to-back repeats.
  // Must happen here (not in enterBattleFromCannon) so watchers see the same
  // lastModifierId when rollModifier runs at battle start.
  if (hasFeature(state, FID.MODIFIERS)) {
    state.modern!.lastModifierId = state.modern!.activeModifier;
  }
  emitGameEvent(state.bus, GAME_EVENT.ROUND_END, { round: state.round });
  state.round++;
  emitGameEvent(state.bus, GAME_EVENT.ROUND_START, { round: state.round });

  // ── RNG consumption (BEFORE checkpoint — order is load-bearing for online sync) ──
  // host/watcher/headless must consume RNG identically before BUILD_START checkpoint
  // is created. Do NOT insert RNG calls after this block or move these after setPhase.
  spawnInterbattleGrunts(state);
  if (hasFeature(state, FID.UPGRADES)) {
    state.modern!.pendingUpgradeOffers = generateUpgradeOffers(state);
  }

  replenishBonusSquares(state);
  setPhase(state, Phase.WALL_BUILD);

  // Upgrade-effect setup for the new build phase (Master Builder owners +
  // lockout, plus any future hooks wired into onBuildPhaseStart).
  onBuildPhaseStart(state);
  state.timer = state.buildTimer + buildTimerBonus(state);

  resetPlayerUpgrades(state);
  startOfBuildPhaseHousekeeping(state);
}

/**
 * Centralized phase setter — every phase mutation flows through here,
 * making the phase state machine traceable from a single call-site.
 * Online mode uses this to reconcile client phase with server checkpoints.
 */
export function setPhase(state: GameState, phase: Phase): void {
  emitGameEvent(state.bus, GAME_EVENT.PHASE_END, {
    phase: state.phase,
    round: state.round,
  });
  state.phase = phase;
  emitGameEvent(state.bus, GAME_EVENT.PHASE_START, {
    phase: state.phase,
    round: state.round,
  });
}

/** Finalize game state for reselected players — protect walls from debris
 *  sweep and destroy houses under rebuilt castle walls.
 *  Runtime caller is responsible for clearing its own selection/overlay state. */
export function finalizeReselectedPlayers(
  state: GameState,
  reselectionPids: readonly ValidPlayerSlot[],
): void {
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
    .filter(
      (entry) => entry.delta > 0 && isPlayerAlive(players[entry.playerId]),
    );
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

/**
 * Complete the build phase using the canonical gameplay rules.
 * Owns wall sweeping, territory/tower revival, and the life check.
 * Exported for game-engine.ts finishBuildPhase composition only —
 * not a public API; game-engine.ts is the canonical caller.
 */
export function finalizeBuildPhase(state: GameState): {
  needsReselect: ValidPlayerSlot[];
  eliminated: ValidPlayerSlot[];
} {
  sweepAllPlayersWalls(state);
  finalizeTerritoryWithScoring(state);
  return applyLifePenalties(state);
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
    if (isPlayerEliminated(player)) continue;
    const hasAliveTower = filterAliveOwnedTowers(player, state).length > 0;
    if (!hasAliveTower) {
      player.lives--;
      emitGameEvent(state.bus, GAME_EVENT.LIFE_LOST, {
        playerId: player.id,
        livesRemaining: player.lives,
        round: state.round,
      });
      const zone = state.playerZones[player.id];
      resetPlayerBoardState(player);
      if (player.lives <= 0) {
        eliminatePlayer(player);
        emitGameEvent(state.bus, GAME_EVENT.PLAYER_ELIMINATED, {
          playerId: player.id,
          round: state.round,
        });
        eliminated.push(player.id);
      } else {
        needsReselect.push(player.id);
      }
      if (zone !== undefined) resetZoneState(state, zone);
    }
  }
  return { needsReselect, eliminated };
}

/** Destructive teardown of a zone after player elimination: removes all grunts,
 *  houses, burning pits, and bonus squares in the zone; reverts sinkhole tiles
 *  back to grass; revives all towers in the zone. Not a simple "reset" — it
 *  permanently modifies game state for the eliminated zone. */
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
  state.bonusSquares = state.bonusSquares.filter(
    (bonus) => bonus.zone !== zone,
  );
  state.burningPits = state.burningPits.filter(
    (pit) => state.map.zones[pit.row]?.[pit.col] !== zone,
  );
  // Revert high tide tiles on this zone back to grass
  const highTide = state.modern?.highTideTiles;
  if (highTide) {
    for (const key of highTide) {
      const { r, c } = unpackTile(key);
      if (state.map.zones[r]?.[c] === zone) {
        setGrass(state.map.tiles, r, c);
        highTide.delete(key);
      }
    }
    if (highTide.size === 0) state.modern!.highTideTiles = null;
    state.map.mapVersion++;
  }
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
    recheckTerritory(state);
    return { id: mod, label, changedTiles: [...scar], gruntsSpawned: 0 };
  }
  if (mod === MODIFIER_ID.CRUMBLING_WALLS) {
    const destroyed = applyCrumblingWalls(state);
    recheckTerritory(state);
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
    recheckTerritory(state);
    return { id: mod, label, changedTiles: [...sunk], gruntsSpawned: 0 };
  }
  if (mod === MODIFIER_ID.HIGH_TIDE) {
    const flooded = applyHighTide(state);
    recheckTerritory(state);
    return { id: mod, label, changedTiles: [...flooded], gruntsSpawned: 0 };
  }
  if (mod === MODIFIER_ID.DUST_STORM) {
    return { id: mod, label, changedTiles: [], gruntsSpawned: 0 };
  }
  if (mod === MODIFIER_ID.RUBBLE_CLEARING) {
    const cleared = applyRubbleClearing(state);
    return { id: mod, label, changedTiles: cleared, gruntsSpawned: 0 };
  }
  return null;
}

/** Award combo demolition bonuses and clear the tracker. */
function awardComboBonuses(state: GameState): void {
  const tracker = state.modern?.comboTracker;
  if (!tracker) return;
  const bonuses = comboDemolitionBonus(tracker);
  for (let i = 0; i < bonuses.length; i++) {
    if (bonuses[i]! > 0 && isPlayerAlive(state.players[i])) {
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
    // Clear mortar/shield election (lasts one battle round)
    for (const cannon of player.cannons) {
      cannon.mortar = undefined;
      cannon.shielded = undefined;
    }
  }
}

/** First battle with no shots fired: spawn grouped grunts as punishment. */
function spawnIdleFirstBattleGrunts(state: GameState): void {
  if (state.round !== 1 || state.shotsFired !== 0) return;
  for (const player of state.players.filter(isPlayerSeated)) {
    spawnGruntGroupOnZone(state, player.id, IDLE_FIRST_BATTLE_GRUNTS);
  }
}
