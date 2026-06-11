/**
 * Castle-build animation helpers. Sole consumer: the selection
 * sub-system (`subsystems/selection.ts`), which drives the wall-build
 * animation at the end of both CASTLE_SELECT cycles.
 */

import { emitGameEvent, GAME_EVENT } from "../shared/core/game-event-bus.ts";
import { addPlayerWall } from "../shared/core/player-walls.ts";
import type { GameState } from "../shared/core/types.ts";
import type {
  CastleBuildState,
  CastleWallPlan,
} from "../shared/ui/interaction-types.ts";

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
        emitGameEvent(state.bus, GAME_EVENT.CASTLE_BUILD_TILE, {
          playerId: plan.playerId,
          tileKey: key,
        });
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
