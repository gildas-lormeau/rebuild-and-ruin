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
  clearInflightCannonballs(deps);
  resetWatcherCrosshairs(deps);
}

/** Apply a battle-start checkpoint received from the host. Watcher-side
 *  counterpart to `enterBattlePhase` — when this returns, `state` has
 *  post-modifier tiles and recomputed territory. Phase flip to
 *  `Phase.BATTLE` is the machine's responsibility (uniform with every
 *  other watcher checkpoint apply fn): the caller does
 *  `setPhase(state, Phase.BATTLE)` after this returns.
 *  @param capturePreState — Runs BEFORE applyPlayersCheckpoint overwrites player state.
 *    Use this to capture pre-state (walls, entities, scores) for banner animations.
 *  @sideeffect Clears watcher crosshairs via resetWatcherCrosshairs(), re-initializes
 *  crosshair positions from home towers. Clears in-flight cannonballs. Impact
 *  / thaw flashes are cleared by the machine's postMutate. */
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

  applyCapturedCannons(deps.state, data.capturedCannons);

  applyCheckpointModifierTiles(deps.state, data);

  // Mirror host's `applyBattleStartModifiers`: sync `activeModifier` +
  // `activeModifierChangedTiles` onto the watcher's state from the
  // BATTLE_START message so the MODIFIER_REVEAL dwell-phase render has
  // the same data on both sides. `activeModifier` on the watcher used
  // to drift (never synced except via full-state sync) — this closes
  // that gap for modifiers feature.
  if (hasFeature(deps.state, FID.MODIFIERS)) {
    deps.state.modern!.activeModifier = data.modifierDiff?.id ?? null;
    deps.state.modern!.activeModifierChangedTiles =
      data.modifierDiff?.changedTiles ?? [];
  }

  // State-level projectile clear (mirrors host's enterBattleFromCannon).
  deps.state.cannonballs = [];
  deps.state.timer = BATTLE_TIMER;
  rehydrateComboTracker(deps.state);
  resetWatcherCrosshairs(deps);
  for (const player of deps.state.players) {
    if (!isPlayerSeated(player)) continue;
    deps.watcherCrosshairPos.set(player.id, towerCenterPx(player.homeTower));
  }

  // Territory recompute runs on the post-modifier map. Phase flip happens
  // in the machine's watcher mutate, uniform with cannon-start / build-start
  // / build-end (which also don't setPhase inside the checkpoint apply fn).
  recomputeAllTerritory(deps.state);
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
  clearInflightCannonballs(deps);
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

/** Clear in-flight cannonballs from game state. Checkpoints only touch
 *  game state; the corresponding battleAnim visual clears (impact + thaw
 *  flashes) happen at the machine level via `postMutate: clearBattleAnim`
 *  on every exiting-battle / cannon-entry transition. */
function clearInflightCannonballs(deps: CheckpointDeps): void {
  deps.state.cannonballs = [];
}

/** Clear all watcher crosshair/orbit tracking maps. */
function resetWatcherCrosshairs(deps: CheckpointDeps): void {
  deps.remoteCrosshairs.clear();
  deps.watcherCrosshairPos.clear();
  deps.watcherOrbitParams.clear();
  deps.watcherOrbitAngles.clear();
}
