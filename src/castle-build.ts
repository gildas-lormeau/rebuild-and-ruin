/**
 * Shared castle-build animation helpers.
 * Used by both main.ts (local play) and online-client.ts (online play).
 */

import { addPlayerWall } from "./board-occupancy.ts";
import type { ValidPlayerSlot } from "./game-constants.ts";
import type { GameState } from "./types.ts";

export interface CastleWallPlan {
  playerId: ValidPlayerSlot;
  tiles: number[];
}

export interface CastleBuildState {
  wallPlans: readonly CastleWallPlan[];
  maxTiles: number;
  tileIdx: number;
  accum: number;
}

/** Create the initial animation state for a castle-build sequence. */
export function createCastleBuildState(
  wallPlans: readonly CastleWallPlan[],
): CastleBuildState {
  return {
    wallPlans,
    maxTiles: Math.max(...wallPlans.map((plan) => plan.tiles.length), 0),
    tileIdx: 0,
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
  render: () => void;
  onWallsPlaced?: () => void;
}): { next: CastleBuildState | null } {
  const { castleBuild, dt, wallBuildIntervalMs, state, render, onWallsPlaced } =
    params;
  if (!castleBuild) return { next: null };

  castleBuild.accum += dt * 1000; // dt is seconds; accum and wallBuildIntervalMs are ms

  let placed = false;
  while (
    castleBuild.accum >= wallBuildIntervalMs &&
    castleBuild.tileIdx < castleBuild.maxTiles
  ) {
    castleBuild.accum -= wallBuildIntervalMs;
    for (const plan of castleBuild.wallPlans) {
      if (castleBuild.tileIdx < plan.tiles.length) {
        const key = plan.tiles[castleBuild.tileIdx]!;
        const owner = state.players[plan.playerId]!;
        addPlayerWall(owner, key);
        placed = true;
      }
    }
    castleBuild.tileIdx++;
  }

  if (placed) onWallsPlaced?.();
  render();

  if (castleBuild.tileIdx < castleBuild.maxTiles) {
    return { next: castleBuild };
  }

  return { next: null };
}
