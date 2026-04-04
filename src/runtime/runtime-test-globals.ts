/**
 * Dev-only test automation globals — exposes mode, phase, crosshair, and
 * targeting data on `window` for E2E test scripts.
 */

import { Mode, Phase } from "../shared/game-phase.ts";
import { TILE_SIZE } from "../shared/grid.ts";
import { unpackTile } from "../shared/spatial.ts";
import { isStateReady, type RuntimeState } from "./runtime-state.ts";
import type { RuntimeConfig } from "./runtime-types.ts";

/** Expose mode, phase, and targeting data for E2E test automation (dev only). */
export function exposeTestGlobals(
  runtimeState: RuntimeState,
  config: Pick<RuntimeConfig, "getMyPlayerId">,
): void {
  if (typeof window === "undefined") return;
  const w = globalThis as unknown as Record<string, unknown>;
  w.__testMode = Mode[runtimeState.mode];
  w.__testPhase = isStateReady(runtimeState)
    ? Phase[runtimeState.state.phase]
    : "";
  w.__testTimer = isStateReady(runtimeState) ? runtimeState.state.timer : 0;
  const myPid = config.getMyPlayerId();
  if (isStateReady(runtimeState) && myPid >= 0) {
    const enemies: { x: number; y: number }[] = [];
    for (const player of runtimeState.state.players) {
      if (player.id === myPid || player.eliminated) continue;
      for (const c of player.cannons) {
        if (c.hp > 0)
          enemies.push({
            // +0.5 converts tile top-left to tile center (pixel coords)
            x: (c.col + 0.5) * TILE_SIZE,
            y: (c.row + 0.5) * TILE_SIZE,
          });
      }
    }
    w.__testEnemyCannons = enemies;
    const targets: { x: number; y: number }[] = [...enemies];
    for (const player of runtimeState.state.players) {
      if (player.id === myPid || player.eliminated) continue;
      for (const key of player.walls) {
        const { r, c } = unpackTile(key);
        targets.push({ x: (c + 0.5) * TILE_SIZE, y: (r + 0.5) * TILE_SIZE });
      }
    }
    w.__testEnemyTargets = targets;
    const myCtrl = runtimeState.controllers[myPid];
    if (myCtrl) {
      const ch = myCtrl.getCrosshair();
      if (ch) w.__testCrosshair = { x: ch.x, y: ch.y };
    }
  }
}
