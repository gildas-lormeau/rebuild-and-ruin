import type { PixelPos } from "../shared/core/geometry-types.ts";
import { isPlayerSeated } from "../shared/core/player-types.ts";
import { towerCenterPx } from "../shared/core/spatial.ts";
import { type GameState } from "../shared/core/types.ts";

export interface CheckpointAccums {
  battle: number;
  cannon: number;
  select: number;
  build: number;
  grunt: number;
}

/** Shared deps for watcher-side UI cleanup hooks.
 *  Game-state mutations are owned by the phase-machine watcher mutate
 *  (which runs `enterBattlePhase` / `enterCannonPhase` locally). This
 *  bag carries only the watcher-specific UI maps that have no host
 *  equivalent. */
export interface CheckpointDeps {
  state: GameState;
  accum: CheckpointAccums;
  remoteCrosshairs: Map<number, PixelPos>;
  watcherCrosshairPos: Map<number, PixelPos>;
  snapshotTerritory: () => Set<number>[];
}

/** Watcher-side UI cleanup at cannon-phase entry. Game state is mutated by
 *  `enterCannonPhase` (and any source-phase prefix) running locally in the
 *  watcher mutate — see `CANNON_ENTRY_WATCHER_STEP` in
 *  `runtime-phase-machine.ts`. This helper handles only the watcher-specific
 *  UI maps that have no equivalent on the host, plus an in-flight cannonball
 *  clear in case any leaked through battle exit. */
export function applyCannonStartWatcherUI(deps: CheckpointDeps): void {
  deps.state.cannonballs = [];
  resetWatcherCrosshairs(deps);
}

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

/** Clear all watcher crosshair tracking maps. */
function resetWatcherCrosshairs(deps: CheckpointDeps): void {
  deps.remoteCrosshairs.clear();
  deps.watcherCrosshairPos.clear();
}
