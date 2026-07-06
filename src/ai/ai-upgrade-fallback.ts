/**
 * Deterministic uniform upgrade fallback: draw one offer from a private Rng
 * seeded by `deriveAiStrategySeed(rngSeed, round, playerId)`, so every peer
 * reproduces the pick from state alone without touching the shared lockstep
 * `state.rng`. Plain `rngSeed` (not GameState) keeps it low-layer, importable
 * by both `controllers/` (human max-timer fallback) and `ai-upgrade-pick.ts`.
 * Uniform on purpose: it resolves slots with no archetype (a timed-out human).
 */

import { deriveAiStrategySeed } from "../shared/core/ai-seed.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import { Rng } from "../shared/platform/rng.ts";

/** Draw one upgrade uniformly at random from `offers`, deterministically per
 *  `(rngSeed, round, playerId)`. Callers pass `state.rng.seed` as `rngSeed`. */
export function forcedUpgradePick(
  offers: readonly UpgradeId[],
  rngSeed: number,
  round: number,
  playerId: ValidPlayerId,
): UpgradeId {
  const pickRng = new Rng(deriveAiStrategySeed(rngSeed, round, playerId));
  return offers[Math.floor(pickRng.next() * offers.length)]!;
}
