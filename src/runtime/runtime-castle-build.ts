/**
 * Shared castle-build animation helpers.
 * Used by both main.ts (local play) and online-client.ts (online play).
 */

import { addPlayerWall } from "../shared/board-occupancy.ts";
import type {
  CastleBuildState,
  CastleWallPlan,
} from "../shared/interaction-types.ts";
import type { GameState } from "../shared/types.ts";

/** Create the initial animation state for a castle-build sequence. */
export function createCastleBuildState(
  wallPlans: readonly CastleWallPlan[],
): CastleBuildState {
  return {
    wallPlans,
    maxTiles: Math.max(...wallPlans.map((plan) => plan.tiles.length), 0),
    wallTimelineIdx: 0,
    accum: 0,
  };
}

/** Advance the castle-build animation by dt seconds.
 *  Returns { next } — next is null when the animation is finished.
 *  @param dt — delta time in SECONDS (converted to ms internally via ×1000). */
export function tickCastleBuildAnimation(params: {
  castleBuild: CastleBuildState | null;
  /** Delta time in seconds (not ms). */
  dt: number;
  wallBuildIntervalMs: number;
  state: GameState;
  onProgress?: () => void;
  onWallsPlaced?: () => void;
}): { next: CastleBuildState | null } {
  const {
    castleBuild,
    dt,
    wallBuildIntervalMs,
    state,
    onProgress,
    onWallsPlaced,
  } = params;
  if (!castleBuild) return { next: null };

  castleBuild.accum += dt * 1000; // dt is seconds; accum and wallBuildIntervalMs are ms

  let placed = false;
  while (
    castleBuild.accum >= wallBuildIntervalMs &&
    castleBuild.wallTimelineIdx < castleBuild.maxTiles
  ) {
    castleBuild.accum -= wallBuildIntervalMs;
    for (const plan of castleBuild.wallPlans) {
      if (castleBuild.wallTimelineIdx < plan.tiles.length) {
        const key = plan.tiles[castleBuild.wallTimelineIdx]!;
        const owner = state.players[plan.playerId]!;
        addPlayerWall(owner, key);
        placed = true;
      }
    }
    castleBuild.wallTimelineIdx++;
  }

  if (placed) onWallsPlaced?.();
  onProgress?.();

  if (castleBuild.wallTimelineIdx < castleBuild.maxTiles) {
    return { next: castleBuild };
  }

  return { next: null };
}
