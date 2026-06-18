/**
 * AI life-lost decision. Today always CONTINUE; future surrender /
 * abandon strategies hook in here. Determinism contract: must stay
 * pure — no `state.rng` draws (runtime calls this lazily at commit,
 * with no cache; a wire-arrived choice would skip a watcher's draw
 * and drift state). RNG-needing strategies must derive a private Rng
 * via `deriveAiStrategySeed` — mirrors `aiPickUpgrade`.
 */

import {
  LifeLostChoice,
  type LifeLostEntry,
  type ResolvedChoice,
} from "../shared/core/dialog-state.ts";
import type { GameViewState } from "../shared/core/system-interfaces.ts";

/** AI decision for a pending life-lost entry. Defaults to CONTINUE; a
 *  test-only `testHooks.lifeLostChoices` override for this player wins (the
 *  only way to reach the human ABANDON / elimination path deterministically).
 *  Reading the override is pure — no `state.rng` draw — so the determinism
 *  contract above still holds. */
export function aiChooseLifeLost(
  entry: LifeLostEntry,
  state: GameViewState,
): ResolvedChoice {
  const forced = state.testHooks?.lifeLostChoices?.find(
    (override) => override.playerId === entry.playerId,
  );
  return forced?.choice ?? LifeLostChoice.CONTINUE;
}
