/**
 * Dust Storm — battle-only cannonball-trajectory jitter. `apply`
 * precomputes a 1024-entry buffer from `state.rng` at BATTLE_START
 * (identical across peers at the same sim tick); each fire reads
 * `buffer[shotsFired % length]` via `applyDustStormJitter` (no per-fire
 * rng draws → no schedule-vs-apply asymmetry under lockstep).
 * `onBattleEnd` clears the buffer.
 */

import { MODIFIER_ID } from "../../shared/core/game-constants.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Maximum trajectory jitter (degrees) applied by Dust Storm. */
const DUST_STORM_JITTER_DEG = 15;
/** Size of the precomputed jitter buffer drawn at battle-start. Generous
 *  upper bound for fires-per-battle (4 players × ~12 cannons × 30s /
 *  cooldown ≈ 700 worst case); modulo'd if exceeded so cross-peer
 *  determinism is preserved either way. */
const DUST_STORM_JITTER_BUFFER_SIZE = 1024;
export const dustStormImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: (state: GameState) => {
    const jitters = new Array<number>(DUST_STORM_JITTER_BUFFER_SIZE);
    for (let i = 0; i < DUST_STORM_JITTER_BUFFER_SIZE; i++) {
      jitters[i] =
        ((state.rng.next() * 2 - 1) * DUST_STORM_JITTER_DEG * Math.PI) / 180;
    }
    state.modern!.precomputedDustStormJitters = jitters;
    return { changedTiles: [], gruntsSpawned: 0 };
  },
  onBattleEnd: (state: GameState) => {
    if (state.modern) state.modern.precomputedDustStormJitters = [];
  },
  // Trajectory jitter only — no map / wall mutation.
  skipsRecheck: true,
};

/** Apply Dust Storm trajectory jitter to a target offset. Returns the
 *  perturbed (x, y) world position when Dust Storm is active, or the
 *  original target unchanged otherwise. Reads from the buffer precomputed
 *  at battle-start — no rng draws at fire time, so originator and receiver
 *  compute identical jitter at the lockstep apply tick. */
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
  const buffer = state.modern.precomputedDustStormJitters;
  const jitterRad = buffer[state.shotsFired % buffer.length] ?? 0;
  const cosJ = Math.cos(jitterRad);
  const sinJ = Math.sin(jitterRad);
  return {
    x: startX + (dx * cosJ - dy * sinJ),
    y: startY + (dx * sinJ + dy * cosJ),
  };
}
