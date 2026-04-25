import {
  applyCheckpointModifierTiles,
  recomputeAllTerritory,
} from "../game/index.ts";
import type { CannonStartData } from "../protocol/checkpoint-data.ts";
import type { PixelPos } from "../shared/core/geometry-types.ts";
import { isPlayerSeated } from "../shared/core/player-types.ts";
import { towerCenterPx } from "../shared/core/spatial.ts";
import type { OrbitParams } from "../shared/core/system-interfaces.ts";
import { type GameState } from "../shared/core/types.ts";
import {
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
/** Watcher-side UI cleanup at battle entry. Game state is mutated by
 *  `enterBattlePhase` running locally in the watcher mutate (see
 *  CANNON_PLACE_DONE). This helper handles only the watcher-specific
 *  UI maps that have no equivalent on the host. */
export function applyBattleStartWatcherUI(deps: CheckpointDeps): void {
  resetWatcherCrosshairs(deps);
  for (const player of deps.state.players) {
    if (!isPlayerSeated(player)) continue;
    deps.watcherCrosshairPos.set(player.id, towerCenterPx(player.homeTower));
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
