import { snapshotAllWalls } from "./board-occupancy.ts";
import { resetCannonFacings } from "./cannon-system.ts";
import type {
  BattleStartData,
  BuildStartData,
  CannonStartData,
  SerializedPlayer,
} from "./checkpoint-data.ts";
import { createComboTracker, isCombosEnabled } from "./combo-system.ts";
import type { OrbitParams } from "./controller-interfaces.ts";
import { BATTLE_TIMER, type ValidPlayerSlot } from "./game-constants.ts";
import type { PixelPos } from "./geometry-types.ts";
import {
  applyCapturedCannons,
  applyGruntsCheckpoint,
  applyHousesAlive,
  applyPlayersCheckpoint,
} from "./online-serialize.ts";
import { towerCenterPx } from "./spatial.ts";
import type { GameState } from "./types.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

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
  deps.state.timer = data.timer;
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

  // Restore frozen river state (matches host's applyFrozenRiver in enterBattleFromCannon)
  deps.state.frozenTiles = data.frozenTiles ? new Set(data.frozenTiles) : null;

  clearBattleProjectiles(deps);
  deps.state.timer = BATTLE_TIMER;
  // Create combo tracker on watcher (matches host's enterBattleFromCannon)
  deps.state.comboTracker = isCombosEnabled(deps.state)
    ? createComboTracker(deps.state.players.length)
    : null;
  resetWatcherCrosshairs(deps);
  for (const player of deps.state.players) {
    if (player.eliminated || !player.homeTower) continue;
    deps.watcherCrosshairPos.set(player.id, towerCenterPx(player.homeTower));
  }
}

/** Apply a build-start checkpoint received from the host.
 *  @param capturePreState — Runs BEFORE applyPlayersCheckpoint overwrites player state.
 *    Use this to capture pre-state (walls, entities, scores) for banner animations.
 *  @sideeffect Clears in-flight cannonballs and impacts. Resets grunt accumulator
 *  and cannon facings. Does NOT reset watcher crosshairs (build phase has no crosshairs). */
export function applyBuildStartCheckpoint(
  data: BuildStartData,
  deps: CheckpointDeps,
  capturePreState?: () => void,
): void {
  applyCommonCheckpoint(data, deps, capturePreState);
  deps.state.round = data.round;
  deps.state.timer = data.timer;
  deps.state.activeModifier =
    (data.activeModifier as typeof deps.state.activeModifier) ?? null;
  deps.state.lastModifierId =
    (data.lastModifierId as typeof deps.state.lastModifierId) ?? null;
  deps.state.pendingUpgradeOffers = data.pendingUpgradeOffers
    ? new Map(
        data.pendingUpgradeOffers.map(([pid, offers]) => [
          pid as ValidPlayerSlot,
          offers as [UpgradeId, UpgradeId, UpgradeId],
        ]),
      )
    : null;
  // Frozen river persists through build phase (thawed at next battle start)
  deps.state.frozenTiles = data.frozenTiles ? new Set(data.frozenTiles) : null;
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
    | "housesAlive"
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
  applyHousesAlive(deps.state, data.housesAlive);
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
