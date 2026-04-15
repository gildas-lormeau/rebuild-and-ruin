/**
 * Regression: bus observers (sound / haptics / stats) rebind on rematch.
 *
 * Each new game installs a fresh `state.bus`; the old subscription is
 * dropped with the old bus. `phaseTicks.subscribeBusObservers()` runs
 * from `bootstrapGame`'s `onStateReady` hook, keyed on bus identity —
 * so a rematch must trigger a fresh subscription on the new bus.
 *
 * Pre-fix this was a boolean flag (`busSubscribed`) that latched `true`
 * after game 1 and silently blocked re-subscription on game 2. Battle
 * events continued to emit on the new bus but sound / haptics / stats
 * observers never heard them. The bug was hidden from `network-vs-local`
 * because that suite doesn't rematch, and hidden from user-visible
 * testing because it only surfaced after a rematch.
 *
 * This test uses the `sc.rematch()` helper to trigger the scenario-level
 * equivalent of the game-over rematch button, then asserts that a
 * battle-layer sound reason fires on the NEW bus.
 */

import { assert } from "@std/assert";
import type { SoundReason } from "../src/shared/core/system-interfaces.ts";
import { createScenario } from "./scenario.ts";

const MAX_TIMEOUT_MS = 600_000;

Deno.test("bus observers rebind to the new state.bus after rematch", async () => {
  let cannonFiredCount = 0;
  using sc = await createScenario({
    seed: 1,
    mode: "classic",
    rounds: 2,
    soundObserver: {
      played: (reason: SoundReason) => {
        if (reason === "battle:cannonFired") cannonFiredCount++;
      },
    },
  });

  // Game 1: run long enough for AI to reach battle and fire at least
  // one cannon. The observer is threaded in at scenario construction
  // time; if this fails, the test itself is misconfigured (not a
  // regression of the code under test).
  sc.runUntil(() => cannonFiredCount > 0, { timeoutMs: MAX_TIMEOUT_MS });
  const game1Count = cannonFiredCount;
  assert(
    game1Count > 0,
    "observer never saw battle:cannonFired on game 1 — scenario broken",
  );

  // Rematch: installs a new state (with a new bus) via bootstrapGame,
  // which re-runs `onStateReady` → `phaseTicks.subscribeBusObservers()`.
  // Pre-fix the boolean flag latched and this second subscribe was a
  // no-op, leaving the new bus unsubscribed.
  await sc.rematch();
  const countAfterRematch = cannonFiredCount;

  // Game 2: wait for another cannon fire on the new bus. If the observer
  // failed to rebind, this loops until the scenario timeout with the
  // counter stuck at `countAfterRematch`.
  sc.runUntil(() => cannonFiredCount > countAfterRematch, {
    timeoutMs: MAX_TIMEOUT_MS,
  });
  assert(
    cannonFiredCount > countAfterRematch,
    `observer didn't rebind to game 2's bus (counter stuck at ${countAfterRematch})`,
  );
});
