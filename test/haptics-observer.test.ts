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
 *   - `battleEvents` — fires for `cannonFired`, `wallDestroyed`, etc.
 *     during the first battle. We assert that AT LEAST `cannonFired`
 *     reaches the observer because every battle has cannons firing.
 */

import { assert, assertGreater } from "@std/assert";
import { Phase } from "../src/shared/game-phase.ts";
import type { HapticReason } from "../src/shared/system-interfaces.ts";
import { createScenario, waitForPhase } from "./scenario.ts";

interface HapticCall {
  reason: HapticReason;
  ms: number;
  minLevel: 1 | 2;
}

Deno.test(
  "haptics observer: phaseChange fires for phase transition banners",
  async () => {
    const calls: HapticCall[] = [];
    using sc = await createScenario({
      seed: 42,
      hapticsObserver: {
        vibrate: (reason, ms, minLevel) => {
          calls.push({ reason, ms, minLevel });
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
    // Sanity: the duration matches HAPTIC_PHASE_CHANGE_MS in haptics-system.ts.
    const PHASE_CHANGE_MS = 40;
    assert(
      phaseChanges.every((call) => call.ms === PHASE_CHANGE_MS),
      `phaseChange ms should always be ${PHASE_CHANGE_MS}, got ${phaseChanges
        .map((call) => call.ms)
        .join(",")}`,
    );
  },
);

Deno.test(
  "haptics observer: battle events fire cannonFired through observer even though CAN_VIBRATE=false",
  async () => {
    const calls: HapticCall[] = [];
    using sc = await createScenario({
      seed: 42,
      hapticsObserver: {
        vibrate: (reason, ms, minLevel) => {
          calls.push({ reason, ms, minLevel });
        },
      },
    });

    // Drive past the first battle's mid-point so cannons have a chance
    // to fire. The simplest "saw cannons firing" check: wait until
    // BATTLE phase, then run a few hundred frames so the AI controllers
    // queue at least one shot per zone.
    waitForPhase(sc, Phase.BATTLE);
    sc.runUntil(
      () => calls.some((call) => call.reason === "cannonFired"),
      2000,
    );

    const cannonFired = calls.filter((call) => call.reason === "cannonFired");
    assertGreater(
      cannonFired.length,
      0,
      "expected at least one cannonFired haptic during the first battle (was the observer installed?)",
    );
    // Cannon-fired haptics target the local POV player (slot 0 in headless
    // single-machine mode); both `minLevel` and `ms` should match the
    // constants in haptics-system.ts so a refactor of the constants makes
    // this test fail loudly instead of silently drifting.
    const CANNON_FIRED_MS = 15;
    assert(
      cannonFired[0]!.ms === CANNON_FIRED_MS,
      `cannonFired ms should be ${CANNON_FIRED_MS}, got ${cannonFired[0]!.ms}`,
    );
  },
);
