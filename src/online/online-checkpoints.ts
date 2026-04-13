import {
  applyCheckpointModifierTiles,
  recomputeAllTerritory,
  rehydrateComboTracker,
} from "../game/index.ts";
import type {
  BattleStartData,
  BuildEndData,
  BuildStartData,
  CannonStartData,
} from "../protocol/checkpoint-data.ts";
import type {
  BalloonFlight,
  ThawingTile,
} from "../shared/core/battle-types.ts";
import { snapshotAllWalls } from "../shared/core/board-occupancy.ts";
import { FID } from "../shared/core/feature-defs.ts";
import { BATTLE_TIMER } from "../shared/core/game-constants.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isPlayerSeated } from "../shared/core/player-types.ts";
import { towerCenterPx } from "../shared/core/spatial.ts";
import type { OrbitParams } from "../shared/core/system-interfaces.ts";
import {
  type GameState,
  hasFeature,
  type UpgradeOfferTuple,
} from "../shared/core/types.ts";
import {
  applyCapturedCannons,
  applyGruntsCheckpoint,
  applyHousesCheckpoint,
  applyPlayersCheckpoint,
} from "./online-serialize.ts";

export interface CheckpointBattleAnim {
  territory: Set<number>[];
  walls: Set<number>[];
  flights: readonly { flight: BalloonFlight; progress: number }[];
  impacts: { row: number; col: number; age: number }[];
  thawing: ThawingTile[];
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

  applyCheckpointModifierTiles(deps.state, data);
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
  // No territory recompute here — the watcher's map is pre-modifier at this point,
  // so callers that need fresh territory (handleBattleStartTransition) recompute
  // after this call, before modifier tiles are restored.
  applyPlayersCheckpoint(deps.state, data.players);
  applyGruntsCheckpoint(deps.state, data.grunts);
  deps.state.burningPits = data.burningPits;
  deps.state.towerAlive = data.towerAlive;
  deps.battleAnim.territory = deps.snapshotTerritory();
  deps.battleAnim.walls = snapshotAllWalls(deps.state);

  applyCapturedCannons(deps.state, data.capturedCannons);

  applyCheckpointModifierTiles(deps.state, data);

  clearBattleProjectiles(deps);
  deps.state.timer = BATTLE_TIMER;
  // Matches host's enterBattleFromCannon.
  rehydrateComboTracker(deps.state);
  resetWatcherCrosshairs(deps);
  for (const player of deps.state.players) {
    if (!isPlayerSeated(player)) continue;
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
  applyCheckpointModifierTiles(deps.state, data);
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
  recomputeAllTerritory(deps.state);
  for (let idx = 0; idx < deps.state.players.length; idx++) {
    deps.state.players[idx]!.score =
      data.scores[idx] ?? deps.state.players[idx]!.score;
  }
}

/** Shared preamble for cannon-start and build-start checkpoints:
 *  runs capturePreState hook, then restores players, grunts, houses, bonus squares,
 *  tower liveness, burning pits, and recomputes territory from walls. */
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
  recomputeAllTerritory(deps.state);
  applyGruntsCheckpoint(deps.state, data.grunts);
  applyHousesCheckpoint(deps.state, data.houses);
  deps.state.bonusSquares = data.bonusSquares;
  deps.state.towerAlive = data.towerAlive;
  deps.state.burningPits = data.burningPits;
}

function clearBattleProjectiles(deps: CheckpointDeps): void {
  deps.state.cannonballs = [];
  deps.battleAnim.impacts = [];
  deps.battleAnim.thawing = [];
}

/** Clear all watcher crosshair/orbit tracking maps. */
function resetWatcherCrosshairs(deps: CheckpointDeps): void {
  deps.remoteCrosshairs.clear();
  deps.watcherCrosshairPos.clear();
  deps.watcherOrbitParams.clear();
  deps.watcherOrbitAngles.clear();
}
