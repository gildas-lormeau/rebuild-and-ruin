/**
 * Haptics observer test — verifies the `hapticsObserver` deps-injected
 * test seam captures every vibrate intent fired through the production
 * haptics pipeline, and that the right reasons fire for the right game events.
 *
 * The observer fires BEFORE the platform/level gate (CAN_VIBRATE +
 * hapticsLevel), so tests can assert "this game event would have
 * triggered haptic X" without needing a real `navigator.vibrate`. In
 * deno, CAN_VIBRATE is false (no vibration API on `navigator`), so
 * production code paths early-return before the observer would see
 * anything — except `battleEvents`, which we modified to always walk
 * the event list when an observer is installed.
 *
 * Coverage:
 *   - `phaseChange` — fires once per phase banner; expected several
 *     times across the first build → cannon → battle sequence.
 *   - `wallDestroyed` — fires every time a cannonball destroys a wall
 *     owned by the POV player. Proxy for "POV-filtered battle events
 *     reach the observer." Picked over `towerKilled` because towers
 *     die rarely in pure-AI matches; wall destruction is constant.
 */

import { assert, assertGreater } from "@std/assert";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { HapticReason } from "../src/shared/core/system-interfaces.ts";
import { createScenario, waitForPhase } from "./scenario.ts";

interface HapticCall {
  reason: HapticReason;
  ms: number;
}

Deno.test(
  "haptics observer: phaseChange fires for phase transition banners",
  async () => {
    const calls: HapticCall[] = [];
    using sc = await createScenario({
      seed: 42,
      hapticsObserver: {
        vibrate: (reason, ms) => {
          calls.push({ reason, ms });
        },
      },
    });

    // Drive the game from CASTLE_SELECT through to the first BATTLE — at
    // least one phase-transition banner fires along the way (round
    // start, build start, etc.), and each one calls `haptics.phaseChange`.
    waitForPhase(sc, Phase.BATTLE);

    const phaseChanges = calls.filter((call) => call.reason === "phaseChange");
    assertGreater(
      phaseChanges.length,
      0,
      "expected at least one phaseChange haptic during the first build→battle sequence",
    );
    // Sanity: the duration matches HAPTIC_PHASE_CHANGE_MS in runtime-haptics.ts.
    const PHASE_CHANGE_MS = 250;
    assert(
      phaseChanges.every((call) => call.ms === PHASE_CHANGE_MS),
      `phaseChange ms should always be ${PHASE_CHANGE_MS}, got ${phaseChanges
        .map((call) => call.ms)
        .join(",")}`,
    );
  },
);

Deno.test(
  "haptics observer: wallDestroyed reaches the observer even though CAN_VIBRATE=false",
  async () => {
    const calls: HapticCall[] = [];
    using sc = await createScenario({
      seed: 42,
      hapticsObserver: {
        vibrate: (reason, ms) => {
          calls.push({ reason, ms });
        },
      },
    });

    // Run the full match — player 0's walls take cross-fire damage within
    // the first round of any AI-vs-AI seed, and the haptic is POV-filtered
    // to player 0 (the scenario default), so this is seed-robust.
    sc.runGame();

    const wallDestroyed = calls.filter(
      (call) => call.reason === "wallDestroyed",
    );
    assertGreater(
      wallDestroyed.length,
      0,
      "expected at least one wallDestroyed haptic during the match (was the observer installed?)",
    );
    // Duration should match the constant in runtime-haptics.ts so a
    // refactor fails loudly instead of silently drifting.
    const WALL_HIT_MS = 200;
    assert(
      wallDestroyed[0]!.ms === WALL_HIT_MS,
      `wallDestroyed ms should be ${WALL_HIT_MS}, got ${wallDestroyed[0]!.ms}`,
    );
  },
);
