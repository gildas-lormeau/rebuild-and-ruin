import { resetCannonFacings } from "../game/cannon-system.ts";
import { createComboTracker, isCombosEnabled } from "../game/combo-system.ts";
import { reapplySinkholeTiles } from "../game/round-modifiers.ts";
import { snapshotAllWalls } from "../shared/board-occupancy.ts";
import type {
  BattleStartData,
  BuildStartData,
  CannonStartData,
  SerializedPlayer,
} from "../shared/checkpoint-data.ts";
import { FID } from "../shared/feature-defs.ts";
import { BATTLE_TIMER } from "../shared/game-constants.ts";
import type { PixelPos } from "../shared/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { towerCenterPx } from "../shared/spatial.ts";
import type { OrbitParams } from "../shared/system-interfaces.ts";
import {
  type GameState,
  hasFeature,
  type UpgradeOfferTuple,
} from "../shared/types.ts";
import {
  applyCapturedCannons,
  applyGruntsCheckpoint,
  applyHousesCheckpoint,
  applyPlayersCheckpoint,
} from "./online-serialize.ts";

export interface CheckpointBattleAnim {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: readonly {
    flight: { startX: number; startY: number; endX: number; endY: number };
    progress: number;
  }[];
  impacts: { row: number; col: number; age: number }[];
}

export interface CheckpointAccums {
  battle: number;
  cannon: number;
  select: number;
  build: number;
  grunt: number;
}

/** Shared deps for all checkpoint apply functions.
 *
 *  capturePreState callback pattern (two variants, both call BEFORE player state is overwritten):
 *    1. Delegated: applyCannonStart / applyBuildStart pass capturePreState into
 *       applyCommonCheckpoint, which calls it before applyPlayersCheckpoint.
 *    2. Direct: applyBattleStart / applyBuildEnd call capturePreState?.() inline
 *       because they have custom post-player-apply logic (territory snapshots, scores).
 *  Both guarantee: capturePreState runs before any player mutation. */
export interface CheckpointDeps {
  state: GameState;
  battleAnim: CheckpointBattleAnim;
  accum: CheckpointAccums;
  remoteCrosshairs: Map<number, PixelPos>;
  watcherCrosshairPos: Map<number, PixelPos>;
  watcherOrbitParams: Map<number, OrbitParams>;
  watcherOrbitAngles: Map<number, number>;
  snapshotTerritory: () => Set<number>[];
}

/** Apply a cannon-start checkpoint received from the host.
 *  @param capturePreState — Runs BEFORE applyPlayersCheckpoint overwrites player state.
 *    Use this to capture pre-state (walls, entities, scores) for banner animations.
 *  @sideeffect Clears all watcher visualization state (crosshairs, phantoms, idle phases)
 *  via resetWatcherCrosshairs(). Also clears in-flight cannonballs and impacts. */
export function applyCannonStartCheckpoint(
  data: CannonStartData,
  deps: CheckpointDeps,
  capturePreState?: () => void,
): void {
  applyCommonCheckpoint(data, deps, capturePreState);
  deps.state.cannonLimits = data.limits;
  deps.state.salvageSlots =
    data.salvageSlots ?? deps.state.players.map(() => 0);
  deps.state.timer = data.timer;
  deps.state.gruntSpawnQueue = (data.gruntSpawnQueue ?? []).map((entry) => ({
    row: entry.row,
    col: entry.col,
    victimPlayerId: entry.victimPlayerId,
  }));
  // Restore sinkhole tiles (permanent map mutations from prior rounds)
  if (hasFeature(deps.state, FID.MODIFIERS)) {
    deps.state.modern!.sinkholeTiles = data.sinkholeTiles
      ? new Set(data.sinkholeTiles)
      : null;
    reapplySinkholeTiles(deps.state);
  }
  clearBattleProjectiles(deps);
  resetWatcherCrosshairs(deps);
  resetCannonFacings(deps.state);
}

/** Apply a battle-start checkpoint received from the host.
 *  @param capturePreState — Runs BEFORE applyPlayersCheckpoint overwrites player state.
 *    Use this to capture pre-state (walls, entities, scores) for banner animations.
 *  @sideeffect Clears watcher crosshairs via resetWatcherCrosshairs(), re-initializes
 *  crosshair positions from home towers. Clears in-flight cannonballs and impacts. */
export function applyBattleStartCheckpoint(
  data: BattleStartData,
  deps: CheckpointDeps,
  capturePreState?: () => void,
): void {
  capturePreState?.();
  applyPlayersCheckpoint(deps.state, data.players);
  applyGruntsCheckpoint(deps.state, data.grunts);
  deps.state.burningPits = data.burningPits;
  deps.state.towerAlive = data.towerAlive;
  deps.battleAnim.territory = deps.snapshotTerritory();
  deps.battleAnim.walls = snapshotAllWalls(deps.state);

  applyCapturedCannons(deps.state, data.capturedCannons);
  deps.state.gruntSpawnQueue = (data.gruntSpawnQueue ?? []).map((entry) => ({
    row: entry.row,
    col: entry.col,
    victimPlayerId: entry.victimPlayerId,
  }));

  // Restore frozen river state (matches host's applyFrozenRiver in enterBattleFromCannon)
  if (hasFeature(deps.state, FID.MODIFIERS)) {
    deps.state.modern!.frozenTiles = data.frozenTiles
      ? new Set(data.frozenTiles)
      : null;
    deps.state.modern!.sinkholeTiles = data.sinkholeTiles
      ? new Set(data.sinkholeTiles)
      : null;
    reapplySinkholeTiles(deps.state);
  }

  clearBattleProjectiles(deps);
  deps.state.timer = BATTLE_TIMER;
  // Create combo tracker on watcher (matches host's enterBattleFromCannon)
  if (hasFeature(deps.state, FID.COMBOS)) {
    deps.state.modern!.comboTracker = isCombosEnabled(deps.state)
      ? createComboTracker(deps.state.players.length)
      : null;
  }
  resetWatcherCrosshairs(deps);
  for (const player of deps.state.players) {
    if (player.eliminated || !player.homeTower) continue;
    deps.watcherCrosshairPos.set(player.id, towerCenterPx(player.homeTower));
  }
}

/** Apply a build-start checkpoint received from the host.
 *  @sideeffect Clears in-flight cannonballs and impacts. Resets grunt accumulator
 *  and cannon facings. Does NOT reset watcher crosshairs (build phase has no crosshairs). */
export function applyBuildStartCheckpoint(
  data: BuildStartData,
  deps: CheckpointDeps,
): void {
  applyCommonCheckpoint(data, deps);
  deps.state.round = data.round;
  deps.state.timer = data.timer;
  if (hasFeature(deps.state, FID.MODIFIERS)) {
    // Modifier is rolled at battle start now — clear it for the build phase
    deps.state.modern!.activeModifier = null;
    // Frozen river persists through build phase (thawed at next battle start)
    deps.state.modern!.frozenTiles = data.frozenTiles
      ? new Set(data.frozenTiles)
      : null;
    deps.state.modern!.sinkholeTiles = data.sinkholeTiles
      ? new Set(data.sinkholeTiles)
      : null;
    reapplySinkholeTiles(deps.state);
  }
  if (hasFeature(deps.state, FID.UPGRADES)) {
    deps.state.modern!.pendingUpgradeOffers = data.pendingUpgradeOffers
      ? new Map(
          data.pendingUpgradeOffers.map(([pid, offers]) => [
            pid as ValidPlayerSlot,
            offers as UpgradeOfferTuple,
          ]),
        )
      : null;
    // Master Builder lockout (exclusive build window)
    deps.state.modern!.masterBuilderLockout = data.masterBuilderLockout ?? 0;
    deps.state.modern!.masterBuilderOwners = data.masterBuilderOwners
      ? new Set(data.masterBuilderOwners as ValidPlayerSlot[])
      : null;
  }
  deps.state.gruntSpawnQueue = (data.gruntSpawnQueue ?? []).map((entry) => ({
    row: entry.row,
    col: entry.col,
    victimPlayerId: entry.victimPlayerId,
  }));
  clearBattleProjectiles(deps);
  deps.accum.grunt = 0;
  resetCannonFacings(deps.state);
}

/** Apply a build-end checkpoint: players + host-computed scores.
 *  @param capturePreState — Runs BEFORE applyPlayersCheckpoint overwrites player state.
 *    Use this to capture pre-state (walls, scores, castles) for banner animations. */
export function applyBuildEndCheckpoint(
  state: GameState,
  players: readonly SerializedPlayer[],
  scores: readonly number[],
  capturePreState?: () => void,
): void {
  capturePreState?.();
  applyPlayersCheckpoint(state, players);
  for (let i = 0; i < state.players.length; i++) {
    state.players[i]!.score = scores[i] ?? state.players[i]!.score;
  }
}

/** Shared preamble for cannon-start and build-start checkpoints:
 *  runs capturePreState hook, then restores players, grunts, houses, bonus squares,
 *  tower liveness, and burning pits from the checkpoint data. */
function applyCommonCheckpoint(
  data: Pick<
    CannonStartData,
    | "players"
    | "grunts"
    | "houses"
    | "bonusSquares"
    | "towerAlive"
    | "burningPits"
  >,
  deps: CheckpointDeps,
  capturePreState?: () => void,
): void {
  capturePreState?.();
  applyPlayersCheckpoint(deps.state, data.players);
  applyGruntsCheckpoint(deps.state, data.grunts);
  applyHousesCheckpoint(deps.state, data.houses);
  deps.state.bonusSquares = data.bonusSquares;
  deps.state.towerAlive = data.towerAlive;
  deps.state.burningPits = data.burningPits;
}

/** Clear in-flight cannonballs and visual impacts.
 *  Named clearBattleProjectiles to avoid confusion with the controller method
 *  initBattleState() which resets cannon rotation and cursors (different concern). */
function clearBattleProjectiles(deps: CheckpointDeps): void {
  deps.state.cannonballs = [];
  deps.battleAnim.impacts = [];
}

/** Clear all watcher crosshair/orbit tracking maps. */
function resetWatcherCrosshairs(deps: CheckpointDeps): void {
  deps.remoteCrosshairs.clear();
  deps.watcherCrosshairPos.clear();
  deps.watcherOrbitParams.clear();
  deps.watcherOrbitAngles.clear();
}
