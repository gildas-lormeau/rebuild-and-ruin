/**
 * Shared castle-build animation helpers.
 * Used by both main.ts (local play) and online-client.ts (online play).
 */

import type { GameState } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CastleWallPlan {
  playerId: number;
  tiles: number[];
}

export interface CastleBuildState {
  wallPlans: CastleWallPlan[];
  maxTiles: number;
  tileIdx: number;
  accum: number;
  onDone: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create the initial animation state for a castle-build sequence. */
export function createCastleBuildState(
  wallPlans: CastleWallPlan[],
  onDone: () => void,
): CastleBuildState {
  return {
    wallPlans,
    maxTiles: Math.max(...wallPlans.map((p) => p.tiles.length), 0),
    tileIdx: 0,
    accum: 0,
    onDone,
  };
}

/** Advance the castle-build animation by dt seconds.
 *  Returns { next, onDone } — next is null when the animation is finished,
 *  and onDone (if present) should be invoked by the caller. */
export function tickCastleBuildAnimation(params: {
  castleBuild: CastleBuildState | null;
  dt: number;
  wallBuildIntervalMs: number;
  state: GameState;
  render: () => void;
}): { next: CastleBuildState | null; onDone?: () => void } {
  const { castleBuild, dt, wallBuildIntervalMs, state, render } = params;
  if (!castleBuild) return { next: null };

  castleBuild.accum += dt * 1000;

  while (
    castleBuild.accum >= wallBuildIntervalMs &&
    castleBuild.tileIdx < castleBuild.maxTiles
  ) {
    castleBuild.accum -= wallBuildIntervalMs;
    for (const plan of castleBuild.wallPlans) {
      if (castleBuild.tileIdx < plan.tiles.length) {
        const key = plan.tiles[castleBuild.tileIdx]!;
        state.players[plan.playerId]!.walls.add(key);
      }
    }
    castleBuild.tileIdx++;
  }

  const totalTime = (castleBuild.maxTiles * wallBuildIntervalMs) / 1000;
  const elapsed = (castleBuild.tileIdx * wallBuildIntervalMs) / 1000;
  state.timer = Math.max(0, totalTime - elapsed);

  render();

  if (castleBuild.tileIdx < castleBuild.maxTiles) {
    return { next: castleBuild };
  }

  return { next: null, onDone: castleBuild.onDone };
}
