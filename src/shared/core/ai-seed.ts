/**
 * Per-(slot, round) seed derived from a match-stable base — lets callers
 * construct a private Rng whose draws don't touch state.rng. Used by
 * ai/ai-upgrade-pick.ts (lazy per-peer upgrade pick) and
 * online/online-host-promotion.ts (asymmetric strategy/personality Rng
 * on a promoted host). Formula MUST stay stable — recorded determinism
 * fixtures and promoted-host AI identity both depend on it.
 */

import type { ValidPlayerId } from "./player-slot.ts";

/** Large prime for deriving per-round AI strategy seeds (ensures uncorrelated rounds). */
const SEED_ROUND_MULTIPLIER = 1000003;
/** Golden ratio hash constant (2^32 × φ⁻¹) for deriving per-slot AI strategy seeds. */
const SEED_SLOT_MULTIPLIER = 0x9e3779b9;

export function deriveAiStrategySeed(
  baseSeed: number,
  round: number,
  slot: ValidPlayerId,
): number {
  return (
    (baseSeed + round * SEED_ROUND_MULTIPLIER + slot * SEED_SLOT_MULTIPLIER) >>>
    0 // >>> 0 coerces to uint32 (consistent seed behavior across platforms)
  );
}
