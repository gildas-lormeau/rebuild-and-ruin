/**
 * Multi-step phase transition recipes; phase-entry.ts wraps setPhase +
 * timer priming around these. Phase lifecycle splits three ways:
 * `prepareXPhase` (derived state, runs on host before checkpoint),
 * `enterXPhase` (state.phase + timer, runs on host and watcher),
 * `startXPhase` (per-controller init). The split is load-bearing for
 * online — collapsing would diverge watcher from host.
 */

import { isBalloonCannon } from "../shared/core/battle-types.ts";
import {
  collectAllWalls,
  filterAliveEnclosedTowers,
} from "../shared/core/board-occupancy.ts";
import { FID } from "../shared/core/feature-defs.ts";
import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import type { ModifierDiff } from "../shared/core/modifier-defs.ts";
import { markInteriorFresh } from "../shared/core/player-interior.ts";
import {
  isPlayerEliminated,
  type ValidPlayerId,
} from "../shared/core/player-slot.ts";
import {
  addScore,
  eliminatePlayer,
  initPlayerBag,
  isPlayerAlive,
  isPlayerSeated,
  loseLife,
  type Player,
} from "../shared/core/player-types.ts";
import {
  clearPlayerWalls,
  sweepIsolatedWalls,
} from "../shared/core/player-walls.ts";
import {
  DIRS_4,
  isGrass,
  packTile,
  setGrass,
  unpackTile,
  zoneAt,
} from "../shared/core/spatial.ts";
import {
  type GameState,
  hasFeature,
  resetShotsFired,
} from "../shared/core/types.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { cleanupBalloonHitTrackingAfterBattle } from "./battle-system.ts";
import {
  finalizeTerritoryWithScoring,
  recheckTerritory,
  recomputeAllTerritory,
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
  effectivePlanTiles,
  orderCastleWallsForAnimation,
  startOfBuildPhaseHousekeeping,
} from "./castle-generation.ts";
import { comboDemolitionBonus, createComboTracker } from "./combos.ts";
import { getDeadZones, getGruntTargetTower } from "./grunt-movement.ts";
import {
  recomputeGruntTargetedWalls,
  rollGruntWallAttacks,
  spawnGruntGroupOnZone,
  spawnGruntSurgeOnZone,
  spawnInterbattleGrunts,
  updateGruntBlockedBattles,
} from "./grunt-system.ts";
import {
  clearActiveInstantModifier,
  clearActiveModifiers,
  MODIFIER_IMPLS_BY_ID,
  rollModifier,
} from "./modifier-system.ts";
import { consumeSupplyBonuses } from "./modifiers/supply-ship.ts";
import {
  generateUpgradeOffers,
  onBattlePhaseStart,
  resetPlayerUpgrades,
  useSmallPieces,
} from "./upgrade-system.ts";
import { recomputeMapZones } from "./zone-recompute.ts";

interface ScoreDelta {
  playerId: ValidPlayerId;
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

/** Prepare battle state at the end of CANNON_PLACE, before the BATTLE_START
 *  checkpoint is broadcast. Runs post-cannon-place cleanup (pit decay, wall
 *  sweep, territory recheck), clears the previous round's modifier, rolls
 *  the round's modifier, applies battle-start modifier effects, and primes
 *  battle fields (timer, cannonballs, combo tracker). Does NOT flip
 *  `state.phase` — that's owned by the phase machine (`enter-modifier-reveal`
 *  or `enter-battle`). `lastModifierId` was already saved in `finalizeBattle`
 *  (before the checkpoint).
 *
 *  Round-scoped: the previous round's modifier state (frozen tiles, high
 *  tide, low water, frostbite chip) stays live through BATTLE → UPGRADE_PICK
 *  → WALL_BUILD → next CANNON_PLACE, and is cleared HERE — just before the
 *  modifier-reveal banner — so the new modifier rolls against neutral
 *  terrain. `clearActiveModifiers` runs AFTER `recheckTerritory` to preserve
 *  the RNG-draw ordering established by commit 349608a7. */
export function prepareBattleState(state: GameState): ModifierDiff | null {
  preBattleSweep(state);
  recheckTerritory(state);
  clearActiveModifiers(state);
  if (hasFeature(state, FID.MODIFIERS)) {
    state.modern!.activeModifier = rollModifier(state);
  }
  const diff = applyBattleStartModifiers(state);
  // Emit AFTER apply so consumers can read post-apply state.modern.*Held
  // (rubble pits, dead cannons, destroyed walls, etc.) directly from
  // the event handler without having to defer to the next tick.
  if (state.modern?.activeModifier) {
    emitGameEvent(state.bus, GAME_EVENT.MODIFIER_APPLIED, {
      modifierId: state.modern.activeModifier,
      round: state.round,
    });
  }
  rollGruntWallAttacks(state);
  // Phase flip + state.timer prime happen later — `enter-modifier-reveal`
  // (when a modifier was rolled) or `enter-battle` calls the matching
  // game/ enter*Phase helper. state.phase stays on CANNON_PLACE until then.
  state.cannonballs = [];
  resetShotsFired(state);
  state.pendingCannonFires.clear();
  onBattlePhaseStart(state, {
    filterActiveFiringCannons,
    isCannonEnclosed,
    homeEnclosedRegion,
  });
  if (hasFeature(state, FID.COMBOS)) {
    state.modern!.comboTracker = createComboTracker(state.players.length);
  }
  return diff;
}

/** Ceasefire: skip battle entirely — do pre-battle housekeeping then go
 *  straight to build. Mirrors the post-battle path: `clearActiveModifiers`
 *  runs before `finalizeBattle`'s `recheckTerritory` so any clear-driven
 *  grunt mutation (frozen-river thaw kills grunts on water) settles before
 *  enclosed-grunt respawn draws RNG. Skips modifier roll, grunt attacks,
 *  and battle setup — the round had no battle. */
export function enterBuildSkippingBattle(state: GameState): void {
  preBattleSweep(state);
  clearActiveModifiers(state);
  finalizeBattle(state);
  prepareNextRound(state);
}

/** Old-round housekeeping run after BATTLE ends (battle-done) or at ceasefire
 *  entry. Closes out battle artifacts (balloons, captured cannons, grunts),
 *  clears the fresh-castle grace period, snapshots `activeModifier` as
 *  `lastModifierId` for the next roll.
 *
 *  Does NOT clear modifier state — round-scoped modifiers (frozen, high
 *  tide, low water, frostbite chip) stay live through UPGRADE_PICK +
 *  WALL_BUILD + next CANNON_PLACE and clear in `prepareBattleState` just
 *  before the next roll. Permanent map mutations (sinkhole grass→water,
 *  wildfire scars) have no `clear` hook.
 *
 *  Does NOT emit `ROUND_END` (that fires from `finalizeRound` once the
 *  build-phase score is computed) and does NOT increment `state.round`
 *  (that happens in the `round-end` transition's mutate, right after
 *  `finalizeRound` — before the score overlay / life-lost dialog
 *  display, and skipped entirely on the game-over branch). The round
 *  being closed isn't actually finished here — it stays open through
 *  UPGRADE_PICK and WALL_BUILD until the score is finalized. */
export function finalizeBattle(state: GameState): void {
  awardComboBonuses(state);
  cleanupBattleArtifacts(state);
  spawnIdleFirstBattleGrunts(state);
  recheckTerritory(state);
  // End of the protected battle — clear the fresh-castle grace period flag.
  for (const player of state.players) player.inGracePeriod = false;
  // Reset per-battle grunt decisions — fresh `targetedWall` is recomputed
  // for the next battle in `finalizeRoundCleanup` (end of WALL_BUILD);
  // `attackDone` action points refresh every battle.
  for (const grunt of state.grunts) {
    grunt.targetedWall = undefined;
    delete grunt.attackDone;
  }
  // Clear the active instant modifier (dust-storm jitter buffer,
  // rubble-clearing held snapshot) so WALL_BUILD + next-CANNON_PLACE
  // checkpoints don't carry stale battle-only state.
  clearActiveInstantModifier(state);
  // Save activeModifier as lastModifierId BEFORE the build-start checkpoint
  // is created — rollModifier reads lastModifierId to prevent back-to-back repeats.
  // Must happen here (not in prepareBattleState) so watchers see the same
  // lastModifierId when rollModifier runs at battle start.
  if (hasFeature(state, FID.MODIFIERS)) {
    state.modern!.lastModifierId = state.modern!.activeModifier;
  }
}

/** New-round seeding run after `finalizeBattle`. Consumes RNG to spawn
 *  interbattle grunts, generate upgrade offers, replenish bonus squares,
 *  and init per-player piece bags. Order is load-bearing for online sync —
 *  the BUILD_START checkpoint is created after this completes, and host /
 *  watcher / headless must produce identical RNG sequences. Callers must
 *  init controllers afterwards (resetCannonFacings + startBuildPhase loop).
 *
 *  Does NOT increment `state.round` — that happens later, in the
 *  `round-end` transition's mutate at the end of WALL_BUILD (and is
 *  skipped on the game-over branch). Helpers that need to know the
 *  round they're seeding for receive `upcomingRound` as an explicit
 *  parameter so the timing knowledge ("we're called pre-increment")
 *  lives only in this function, not in every helper. */
export function prepareNextRound(state: GameState): void {
  const upcomingRound = state.round + 1;

  // ── RNG consumption (BEFORE checkpoint — order is load-bearing for online sync) ──
  // host/watcher/headless must consume RNG identically before BUILD_START checkpoint
  // is created. Do NOT insert RNG calls after this block or move these after setPhase.
  spawnInterbattleGrunts(state, upcomingRound);
  if (hasFeature(state, FID.UPGRADES)) {
    state.modern!.pendingUpgradeOffers = generateUpgradeOffers(
      state,
      upcomingRound,
    );
  }

  replenishBonusSquares(state);
  // Phase flip happens later — `enter-wall-build` (dispatched by the
  // phase machine after `battle-done` / `ceasefire`) calls
  // `enterWallBuildPhase`. Engine-level setup runs here but state.phase
  // stays on BATTLE until that mutate fires.

  // Upgrade-effect setup for the new build phase (`onBuildPhaseStart`:
  // Master Builder owners + lockout) is anchored in `enterWallBuildPhase`
  // (game/phase-entry.ts) — AFTER `applyUpgradePicks` has applied THIS
  // round's picks, alongside the `state.timer` anchoring. Running it here
  // (battle-done, before the upgrade pick) would freeze the owner/lockout
  // set at the PREVIOUS round's picks, so a Master Builder bought this
  // round would grant no exclusive window in the build phase it was picked
  // for, and host/watcher would disagree.
  resetPlayerUpgrades(state);
  startOfBuildPhaseHousekeeping(state);

  // Per-player piece bag init — moved out of controller.startBuildPhase
  // so host and watcher consume RNG identically (watchers have no local
  // controllers, so the per-controller path was host-only). `currentPiece`
  // is game state (read by AI strategy + human UI during BUILD), so it
  // belongs in the engine. Iterate in slot order for deterministic RNG.
  for (const player of state.players) {
    if (!isPlayerSeated(player)) continue;
    // Small-pieces draw bag flag: union of the Small Pieces upgrade and
    // a queued supply-ship `small_pieces_bias` bonus for this player.
    // consumeSupplyBonuses drains the queue so the bias only applies
    // for this one bag init.
    const smallPiecesBonus =
      consumeSupplyBonuses(state, player.id, "small_pieces_bias") > 0;
    const smallPieces = useSmallPieces(player) || smallPiecesBonus;
    initPlayerBag(player, upcomingRound, state.rng, smallPieces);
  }
}

/** Emit `ROUND_START` for the round the engine just rolled into.
 *  `state.round` must already reflect the new round value — round-end's
 *  mutate increments it immediately before this call, and only on the
 *  continue/reselect path: the game-over peek returns early with the
 *  counter still at the closing round and this emit suppressed. (That
 *  ordering is why `routeLifeLostResolution` re-checks only the
 *  alive-count condition afterwards, never the round limit.) */
export function emitRoundStart(state: GameState): void {
  emitGameEvent(state.bus, GAME_EVENT.ROUND_START, { round: state.round });
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

/** Finalize game state for players who built a fresh castle this round.
 *  Snapshots castle walls for debris-sweep protection. The
 *  `player.inGracePeriod` flag is set at confirm-time (in `confirmTowerSelection`)
 *  and cleared in `finalizeBattle`, so this function just iterates flagged
 *  players and snapshots wall tiles. Round 1's auto-built castle and a
 *  mid-game reselected castle are treated identically. */
export function finalizeFreshCastles(state: GameState): void {
  // The castle build animation already placed walls (including clumsy extras)
  // via addPlayerWall. Don't rebuild — just do cleanup.
  for (const player of state.players) {
    if (!player.inGracePeriod) continue;
    if (!player.homeTower) continue;
    // Protect animated walls from debris sweep
    player.castleWallTiles = new Set(player.walls);
  }
}

/** Compute per-player score deltas from the build phase.
 *  Returns only positive deltas for non-eliminated players.
 *  Callers add pixel positions for rendering (see runtime/subsystems/score-deltas.ts). */
export function computeScoreDeltas(
  players: GameState["players"],
  preScores: readonly number[],
): ScoreDelta[] {
  return players
    .map((player, idx) => ({
      playerId: idx as ValidPlayerId,
      delta: player.score - (preScores[idx] ?? 0),
      total: player.score,
    }))
    .filter(
      (entry) => entry.delta > 0 && isPlayerAlive(players[entry.playerId]),
    );
}

/** Prepare castle walls for all players, returning ordered wall tiles per player
 *  for animated construction. Seeds `player.castleWallTiles` with the planned
 *  ring so renderers, mobile auto-unzoom, and presence-check sites see the
 *  player as "has a castle" the moment the plan commits — not at finalize
 *  time when the animation completes. `finalizeFreshCastles` reconciles
 *  against the actual `player.walls` (in case the animation was interrupted).
 *  Does NOT add walls or interior; those are added tile-by-tile by the
 *  build animation via `addPlayerWall`.
 *
 *  When high_tide is active during a reselect cycle, project the flooded
 *  ring back to water for the planner so the auto-built ring naturally
 *  avoids tiles that are visually-water (preserves the
 *  walls-cannot-be-built-on-flood invariant for new castles). */
export function prepareCastleWallsForPlayer(
  state: GameState,
  playerId: ValidPlayerId,
): { playerId: ValidPlayerId; tiles: TileKey[] } | null {
  const player = state.players[playerId];
  if (!player?.homeTower) return null;
  const planTiles = effectivePlanTiles(state);
  const castle = createCastle(player.homeTower, planTiles, state.map.towers);

  // Get wall tiles and apply clumsy builders to a temp set
  const wallTiles = computeCastleWallTiles(castle, planTiles);
  const tempWalls = new Set<TileKey>();
  for (const [r, c] of wallTiles) tempWalls.add(packTile(r, c));
  applyClumsyBuilders(
    tempWalls,
    castle,
    planTiles,
    state.rng,
    state.map.towers,
  );

  const ordered = orderCastleWallsForAnimation(
    castle,
    wallTiles,
    tempWalls,
    state.rng,
  );
  player.castleWallTiles = new Set(ordered);
  return { playerId: player.id, tiles: ordered };
}

/** Phase A of end-of-build finalization — state mutations that the score
 *  overlay and life-lost dialog depend on:
 *    - territory + scoring + tower revival + enclosed house/grunt/bonus
 *      resolution (`finalizeTerritoryWithScoring`)
 *    - life penalties (`applyLifePenalties`)
 *
 *  Emits `ROUND_END` after the score is computed — the round is officially
 *  closed at this point. The caller (round-end's mutate) advances the
 *  counter immediately after this returns, unless its game-over peek ends
 *  the match — the counter then stays at the closing round.
 *
 *  Wall + grunt cleanup (isolated-wall removal, grunts in eliminated zones,
 *  recompute targetedWall) is deferred to `finalizeRoundCleanup` so the
 *  sweeps reveal under the cannons banner rather than popping during the
 *  score overlay. */
export function finalizeRound(state: GameState): {
  needsReselect: ValidPlayerId[];
  eliminated: ValidPlayerId[];
} {
  finalizeTerritoryWithScoring(state);
  const result = applyLifePenalties(state);
  emitGameEvent(state.bus, GAME_EVENT.ROUND_END, { round: state.round });
  return result;
}

/** Phase B — wall + grunt cleanup deferred from `finalizeRound`.
 *  Called from the transitions that fire the cannons banner
 *  (`advance-to-cannon`, and `castle-done` for round > 1 reselects) so
 *  the sweeps reveal under the banner instead of popping during the
 *  score overlay. The game-over routes never run it — the final board
 *  keeps its un-swept state (cosmetic only: scoring already closed in
 *  Phase A).
 *
 *  `recomputeAllTerritory` refreshes interior after the wall mutation to
 *  keep the `walls epoch == interior epoch` invariant that downstream
 *  readers enforce. Critically, it does NOT run the full `recheckTerritory`
 *  pass 2 (which does enclosed-grunt respawn using `state.rng.bool`) —
 *  that would consume RNG and desync every seed-dependent test. Territory
 *  mutations (grunt respawn, house destruction, bonus capture) already
 *  ran in Phase A via `finalizeTerritoryWithScoring`. */
export function finalizeRoundCleanup(state: GameState): void {
  sweepAllPlayersWalls(state);
  recomputeAllTerritory(state);
  sweepGruntsInDeadZones(state);
  recomputeGruntTargetedWalls(state);
}

/** Shared pre-battle housekeeping run from both the real battle path
 *  (`prepareBattleState`) and the ceasefire path (`enterBuildSkippingBattle`).
 *  Decays burning pits, sweeps disconnected walls, removes bonus squares
 *  covered by walls.
 *
 *  Does NOT include `recheckTerritory` — callers run it inline because
 *  battle-scoped modifier clears (`finalizeBattle.clearActiveModifiers`)
 *  must follow recheckTerritory to keep the RNG-draw ordering established
 *  by commit 349608a7 (clearFrozenRiver kills grunts on water tiles;
 *  placing it before vs after recheckTerritory would shift the
 *  enclosed-grunt-respawn RNG draws). The three steps here all leave
 *  walls, towers, and the grunt set unchanged, so they're safe to bundle. */
function preBattleSweep(state: GameState): void {
  decayBurningPits(state);
  sweepAllPlayersWalls(state);
  removeBonusSquaresCoveredByWalls(state, collectAllWalls(state));
}

/** Remove grunts sitting in any eliminated player's zone. resetZoneState
 *  handles the one-shot sweep at the moment of elimination; this covers
 *  stragglers that drift into a dead zone in subsequent rounds (e.g.
 *  frozen-river crossings when the zone owner was already eliminated). */
function sweepGruntsInDeadZones(state: GameState): void {
  const deadZones = getDeadZones(state);
  if (deadZones.size === 0) return;
  state.grunts = state.grunts.filter((grunt) => {
    const gruntZone = zoneAt(state.map, grunt.row, grunt.col);
    return gruntZone === undefined || !deadZones.has(gruntZone);
  });
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
  needsReselect: ValidPlayerId[];
  eliminated: ValidPlayerId[];
} {
  const needsReselect: ValidPlayerId[] = [];
  const eliminated: ValidPlayerId[] = [];
  for (const player of state.players) {
    if (isPlayerEliminated(player)) continue;
    const hasAliveTower = filterAliveEnclosedTowers(player, state).length > 0;
    if (!hasAliveTower) {
      loseLife(player);
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
      if (zone !== undefined) {
        resetZoneState(state, zone, isPlayerEliminated(player));
      }
    }
  }
  return { needsReselect, eliminated };
}

/** Destructive teardown of a zone after a player loses a life or is
 *  eliminated. Restores the zone's territory to its starting baseline so
 *  the player can rebuild on neutral ground:
 *    - clears grunts, houses, burning pits, bonus squares inside the zone
 *    - revives the zone's towers
 *    - forces every non-grass tile in the zone back to grass (sinkholes),
 *      drops those tiles from the sinkholeTiles tracker, then recomputes
 *      `state.map.zones` so the restored grass folds back into the
 *      player's zone topology
 *
 *  River-state outside the zone (frozen river, river-edge effects whose
 *  tiles aren't owned by this zone) is untouched — modifiers are global
 *  by definition; only their per-zone footprint goes away here.
 *
 *  `ownerEliminated` distinguishes life-loss from elimination. The two
 *  cases agree on every step except the cross-zone grunt sweep in
 *  `evictEntitiesInZone` — see that function's contract. */
function resetZoneState(
  state: GameState,
  zone: ZoneId,
  ownerEliminated: boolean,
): void {
  evictEntitiesInZone(state, zone, ownerEliminated);
  for (let towerIndex = 0; towerIndex < state.map.towers.length; towerIndex++) {
    if (state.map.towers[towerIndex]!.zone === zone) {
      state.towerAlive[towerIndex] = true;
    }
  }
  restoreZoneGrass(state, zone);
  recomputeMapZones(state);
}

/** Remove every entity bound to `zone` — grunts (in-zone or, when the
 *  owner is eliminated, targeting an in-zone tower), houses, bonus
 *  squares, burning pits. Towers are NOT evicted; the caller revives
 *  them. Zone-keyed counterpart to `evictEntitiesOnTiles` (which is
 *  tile-set-keyed).
 *
 *  Cross-zone grunts (in another zone but targeting a tower in `zone`)
 *  are only wiped when `ownerEliminated`. On a plain life-loss reset
 *  the zone's towers are revived by `resetZoneState` two lines later,
 *  so a grunt mid-crossing to attack one of them keeps a valid target
 *  and must survive. */
function evictEntitiesInZone(
  state: GameState,
  zone: ZoneId,
  ownerEliminated: boolean,
): void {
  state.grunts = state.grunts.filter((grunt) => {
    if (zoneAt(state.map, grunt.row, grunt.col) === zone) return false;
    if (ownerEliminated && grunt.targetTowerIdx !== undefined) {
      if (getGruntTargetTower(state, grunt)?.zone === zone) return false;
    }
    return true;
  });
  state.map.houses = state.map.houses.filter((house) => house.zone !== zone);
  state.bonusSquares = state.bonusSquares.filter(
    (bonus) => bonus.zone !== zone,
  );
  state.burningPits = state.burningPits.filter(
    (pit) => zoneAt(state.map, pit.row, pit.col) !== zone,
  );
}

/** Force every non-grass tile inside `zone`'s territory back to grass and
 *  drop those tile keys from the sinkhole tracker.
 *
 *  Walks tower-anchored: BFS from one of the zone's towers, treating
 *  grass AND sinkhole-mutated water as walkable, stopping at original
 *  river. This catches sinkhole tiles even after a recompute dropped
 *  them out of the live zones array.
 *
 *  high_tide does not appear here: it no longer mutates tiles (the
 *  flooded set is derived from the static map; see `computeFloodedTiles`).
 *  Low-water no longer mutates tiles either (the exposed riverbed set
 *  on `state.modern.exposedRiverbedTiles` is the source of truth; tiles
 *  stay water), so it doesn't appear here. */
function restoreZoneGrass(state: GameState, zone: ZoneId): void {
  const anchor = state.map.towers.find((tower) => tower.zone === zone);
  if (!anchor) return;
  const tiles = state.map.tiles;
  const sinkholeTiles = state.modern?.sinkholeTiles;
  const visited = new Set<TileKey>();
  const queue: TileKey[] = [packTile(anchor.row, anchor.col)];
  visited.add(queue[0]!);
  while (queue.length > 0) {
    const key = queue.shift()!;
    const { row, col } = unpackTile(key);
    if (!isGrass(tiles, row, col)) {
      setGrass(tiles, row, col);
      sinkholeTiles?.delete(key);
    }
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
      const neighborKey = packTile(nr, nc);
      if (visited.has(neighborKey)) continue;
      const isWalkable =
        isGrass(tiles, nr, nc) || sinkholeTiles?.has(neighborKey) === true;
      if (!isWalkable) continue;
      visited.add(neighborKey);
      queue.push(neighborKey);
    }
  }
  if (state.modern) {
    if (sinkholeTiles && sinkholeTiles.size === 0)
      state.modern.sinkholeTiles = null;
  }
}

/** Reset a player's board state (walls, interior, cannons, towers,
 *  castle, home tower) for a new round. The player remains in the game —
 *  only their placed objects are cleared. Contrast with eliminatePlayer
 *  which permanently removes the player. */
function resetPlayerBoardState(player: Player): void {
  clearPlayerWalls(player);
  // clearPlayerWalls bumps wallsEpoch; sync interiorEpoch here so a remote-slot
  // receiver doesn't throw stale-interior before the rebuild's recheckTerritory
  // catches up (castle animation runs from OPPONENT_PIECE_PLACED only).
  markInteriorFresh(player, new Set());
  player.cannons = [];
  player.enclosedTowers = [];
  player.castleWallTiles = new Set();
  player.homeTower = null;
}

/** Decay burning pits at battle start — pits created during a battle
 *  remain at full intensity through repair/cannon phases. */
function decayBurningPits(state: GameState): void {
  for (const pit of state.burningPits) pit.roundsLeft--;
  state.burningPits = state.burningPits.filter((pit) => pit.roundsLeft > 0);
}

/** Modern mode: apply environmental modifiers at battle start.
 *  Dispatches to the modifier registry — no per-modifier knowledge needed here.
 *  Always reconciles territory afterwards unless the impl opts out via
 *  `skipsRecheck: true` (see ModifierImpl docs).
 *  Returns a ModifierDiff for the reveal banner, or null if no modifier fired. */
function applyBattleStartModifiers(state: GameState): ModifierDiff | null {
  const mod = state.modern?.activeModifier;
  if (!mod) return null;
  const impl = MODIFIER_IMPLS_BY_ID[mod];
  const result = impl.apply(state);
  // Execute any spawn requests the modifier emitted (grunt-surge stays in
  // the deep-logic layer by returning descriptors instead of calling
  // grunt-system directly). RNG draws happen inside spawnGruntSurgeOnZone
  // and are deterministic given the input request order, which matches
  // state.players iteration order in the producing modifier.
  const spawnedTiles: TileKey[] = [];
  let spawnedCount = 0;
  if (result.spawnRequests && result.spawnRequests.length > 0) {
    const gruntsBefore = state.grunts.length;
    for (const req of result.spawnRequests) {
      spawnGruntSurgeOnZone(state, req.playerId, req.count);
    }
    for (let i = gruntsBefore; i < state.grunts.length; i++) {
      const grunt = state.grunts[i]!;
      spawnedTiles.push(packTile(grunt.row, grunt.col));
    }
    spawnedCount = state.grunts.length - gruntsBefore;
  }
  if (!impl.skipsRecheck) recheckTerritory(state);
  const changedTiles =
    spawnedTiles.length === 0
      ? result.changedTiles
      : [...result.changedTiles, ...spawnedTiles];
  // Persist the changed-tile set on state alongside `activeModifier` so
  // the `MODIFIER_REVEAL` dwell-phase render can draw a tile pulse
  // without needing to re-derive what the modifier touched.
  state.modern!.activeModifierChangedTiles = changedTiles;
  return {
    id: mod,
    changedTiles,
    gruntsSpawned: result.gruntsSpawned + spawnedCount,
  };
}

/** Award combo demolition bonuses and clear the tracker. */
function awardComboBonuses(state: GameState): void {
  const tracker = state.modern?.comboTracker;
  if (!tracker) return;
  const bonuses = comboDemolitionBonus(tracker);
  for (let i = 0; i < bonuses.length; i++) {
    if (bonuses[i]! > 0 && isPlayerAlive(state.players[i])) {
      addScore(state.players[i]!, bonuses[i]!);
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
