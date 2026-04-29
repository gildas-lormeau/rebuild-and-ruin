/**
 * Dust Storm modifier — adds random jitter to cannonball trajectories.
 *
 * The apply function is a no-op (no tile mutations); the effect is applied
 * per-frame in battle-system.ts via applyDustStormJitter.
 */

import { MODIFIER_ID } from "../../shared/core/game-constants.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Maximum trajectory jitter (degrees) applied by Dust Storm. */
const DUST_STORM_JITTER_DEG = 15;
export const dustStormImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: () => ({ changedTiles: [] as number[], gruntsSpawned: 0 }),
  // Trajectory jitter only — no map / wall mutation.
  skipsRecheck: true,
  // One `state.rng.next()` call per fire — the jitter angle drawn by
  // `applyDustStormJitter`. The wire-applied `applyCannonFired` reads
  // this count from `MODIFIER_REGISTRY` and mirrors the draws so
  // `state.rng` stays in lockstep across peers.
  fireRngDraws: 1,
};

/** Apply Dust Storm trajectory jitter to a target offset. Returns the
 *  perturbed (x, y) world position when Dust Storm is active, or the
 *  original target unchanged otherwise. RNG is consumed only when the
 *  modifier is active and the target is non-degenerate — preserving
 *  determinism with the original inline implementation. */
export function applyDustStormJitter(
  state: GameState,
  startX: number,
  startY: number,
  targetX: number,
  targetY: number,
): { x: number; y: number } {
  if (state.modern?.activeModifier !== MODIFIER_ID.DUST_STORM) {
    return { x: targetX, y: targetY };
  }
  const dx = targetX - startX;
  const dy = targetY - startY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return { x: targetX, y: targetY };
  const jitterRad =
    ((state.rng.next() * 2 - 1) * DUST_STORM_JITTER_DEG * Math.PI) / 180;
  const cosJ = Math.cos(jitterRad);
  const sinJ = Math.sin(jitterRad);
  return {
    x: startX + (dx * cosJ - dy * sinJ),
    y: startY + (dx * sinJ + dy * cosJ),
  };
}
