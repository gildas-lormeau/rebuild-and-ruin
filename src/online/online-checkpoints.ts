import { createComboTracker, isCombosEnabled } from "../game/combo-system.ts";
import {
  reapplyHighTideTiles,
  reapplySinkholeTiles,
} from "../game/round-modifiers.ts";
import { snapshotAllWalls } from "../shared/board-occupancy.ts";
import type {
  BattleStartData,
  BuildEndData,
  BuildStartData,
  CannonStartData,
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
 *  All four apply functions share the signature (data, deps, capturePreState?).
 *  capturePreState always runs BEFORE applyPlayersCheckpoint overwrites player state.
 *  Delegated variant (cannon/build-start) passes it through applyCommonCheckpoint;
 *  direct variant (battle-start/build-end) calls it inline before player mutation. */
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
  restoreSpawnQueue(deps.state, data);
  restoreModifierTileState(deps.state, data);
  clearBattleProjectiles(deps);
  resetWatcherCrosshairs(deps);
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
  restoreSpawnQueue(deps.state, data);
  restoreModifierTileState(deps.state, data);

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
 *  @param capturePreState — Runs BEFORE applyPlayersCheckpoint overwrites player state.
 *    Use this to capture pre-state for banner animations.
 *  @sideeffect Clears in-flight cannonballs and impacts. Resets grunt accumulator.
 *  Does NOT reset watcher crosshairs (build phase has no crosshairs). */
export function applyBuildStartCheckpoint(
  data: BuildStartData,
  deps: CheckpointDeps,
  capturePreState?: () => void,
): void {
  applyCommonCheckpoint(data, deps, capturePreState);
  deps.state.round = data.round;
  deps.state.timer = data.timer;
  if (hasFeature(deps.state, FID.MODIFIERS)) {
    restoreModifierTileState(deps.state, data);
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
}

/** Apply a build-end checkpoint: players + host-computed scores.
 *  Only needs state from deps (no crosshairs/battleAnim/territory to reset).
 *  @param capturePreState — Runs BEFORE applyPlayersCheckpoint overwrites player state.
 *    Use this to capture pre-state (walls, scores, castles) for banner animations. */
export function applyBuildEndCheckpoint(
  data: BuildEndData,
  deps: Pick<CheckpointDeps, "state">,
  capturePreState?: () => void,
): void {
  capturePreState?.();
  applyPlayersCheckpoint(deps.state, data.players);
  for (let idx = 0; idx < deps.state.players.length; idx++) {
    deps.state.players[idx]!.score =
      data.scores[idx] ?? deps.state.players[idx]!.score;
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

function restoreSpawnQueue(
  state: GameState,
  data: {
    gruntSpawnQueue?: {
      row: number;
      col: number;
      victimPlayerId: ValidPlayerSlot;
    }[];
  },
): void {
  state.gruntSpawnQueue = (data.gruntSpawnQueue ?? []).map((entry) => ({
    row: entry.row,
    col: entry.col,
    victimPlayerId: entry.victimPlayerId,
  }));
}

/** Restore tile-mutating modifier state from checkpoint data.
 *  Handles frozenTiles (optional), highTideTiles, and sinkholeTiles.
 *  Calls reapply functions to re-mutate the map tiles (which are regenerated from seed). */
function restoreModifierTileState(
  state: GameState,
  data: {
    frozenTiles?: number[] | null;
    highTideTiles?: number[] | null;
    sinkholeTiles?: number[] | null;
  },
): void {
  if (!hasFeature(state, FID.MODIFIERS)) return;
  if ("frozenTiles" in data) {
    state.modern!.frozenTiles = data.frozenTiles
      ? new Set(data.frozenTiles)
      : null;
  }
  state.modern!.highTideTiles = data.highTideTiles
    ? new Set(data.highTideTiles)
    : null;
  state.modern!.sinkholeTiles = data.sinkholeTiles
    ? new Set(data.sinkholeTiles)
    : null;
  reapplyHighTideTiles(state);
  reapplySinkholeTiles(state);
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
