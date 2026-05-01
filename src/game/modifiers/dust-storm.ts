/**
 * Dust Storm modifier — adds random jitter to cannonball trajectories.
 *
 * The apply function is a no-op (no tile mutations); the effect is applied
 * per-fire in battle-system.ts via applyDustStormJitter.
 */

import { MODIFIER_ID } from "../../shared/core/game-constants.ts";
import type { GameState } from "../../shared/core/types.ts";
import type { ModifierImpl } from "./modifier-types.ts";

/** Maximum trajectory jitter (degrees) applied by Dust Storm. */
const DUST_STORM_JITTER_DEG = 15;
/** Size of the precomputed jitter buffer drawn at battle-start when
 *  dust-storm rolls. Generous upper bound for fires-per-battle (4 players
 *  × ~12 cannons × 30s / cooldown ≈ 700 worst case); modulo'd if exceeded
 *  so cross-peer determinism is preserved either way. */
const DUST_STORM_JITTER_BUFFER_SIZE = 1024;
export const dustStormImpl: ModifierImpl = {
  lifecycle: "instant",
  apply: () => ({ changedTiles: [] as number[], gruntsSpawned: 0 }),
  // Trajectory jitter only — no map / wall mutation.
  skipsRecheck: true,
  // No per-fire `state.rng` draws: jitter values are precomputed at
  // battle-start (`precomputeDustStormJitters` in `prepareBattleState`)
  // and indexed by `state.shotsFired` at fire time. See the file
  // docstring for why precompute beats the wire-applied mirror under
  // the lockstep cannon-fire schedule.
};

/** Pre-draw the jitter buffer when dust-storm is the active modifier.
 *  Called from `prepareBattleState` after `rollModifier`, on every peer
 *  at the same logical sim tick — so both peers consume the same prefix
 *  of `state.rng` and end up with identical buffers.
 *
 *  Why precompute: drawing rng at fire time created a SAFETY-window
 *  asymmetry under the lockstep cannon-fire schedule — the originator
 *  drew at simTick=N (during `prepareCannonFireForLockstep`) while the
 *  receiver mirrored at simTick=N+SAFETY (via
 *  `consumeFireRngForActiveModifier`). During those 8 ticks the peers'
 *  rng states diverged, and other rng-drawing battle code
 *  (e.g. `gruntAttackTowers`'s wall-attack roll) consumed off the
 *  divergent streams, drifting state cross-peer. Precomputing closes
 *  that window — fires consume from a frozen buffer, no rng draws at
 *  apply time on either peer. */
export function precomputeDustStormJitters(state: GameState): void {
  if (state.modern?.activeModifier !== MODIFIER_ID.DUST_STORM) {
    state.modern!.precomputedDustStormJitters = [];
    return;
  }
  const jitters = new Array<number>(DUST_STORM_JITTER_BUFFER_SIZE);
  for (let i = 0; i < DUST_STORM_JITTER_BUFFER_SIZE; i++) {
    jitters[i] =
      ((state.rng.next() * 2 - 1) * DUST_STORM_JITTER_DEG * Math.PI) / 180;
  }
  state.modern!.precomputedDustStormJitters = jitters;
}

/** Apply Dust Storm trajectory jitter to a target offset. Returns the
 *  perturbed (x, y) world position when Dust Storm is active, or the
 *  original target unchanged otherwise. Reads from the buffer
 *  precomputed at battle-start — no rng draws at fire time, so
 *  originator and receiver compute identical jitter at the lockstep
 *  apply tick. */
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
