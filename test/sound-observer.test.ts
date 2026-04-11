/**
 * Sound observer test — verifies the `soundObserver` deps-injected test
 * seam captures every "would have played" intent fired through the
 * production sound pipeline, end-to-end through real sub-systems.
 *
 * Default sound level in headless is `SOUND_OFF`, so production code
 * paths early-return at the level check and never touch the Web Audio
 * API (which doesn't exist in Deno anyway). The observer fires *before*
 * that check, so it sees every intent regardless. The `battleEvents`
 * method has a special case: when an observer is installed it walks
 * the event list even with sound off, so per-event observations work.
 *
 * Mirrors the haptics observer test (`haptics-observer.test.ts`) and
 * uses the same proof shape: drive the game through the real pipeline,
 * assert that specific reasons appeared.
 */

import { assert, assertGreater } from "@std/assert";
import { Phase } from "../src/shared/game-phase.ts";
import type { SoundReason } from "../src/shared/system-interfaces.ts";
import { createScenario, waitForPhase } from "./scenario.ts";

Deno.test(
  "sound observer: phaseStart fires for phase transition banners",
  async () => {
    const reasons: SoundReason[] = [];
    using sc = await createScenario({
      seed: 42,
      soundObserver: { played: (reason) => reasons.push(reason) },
    });

    // Drive through the first build → battle sequence — multiple
    // phase banners fire, each calling `sound.phaseStart`.
    waitForPhase(sc, Phase.BATTLE);

    const phaseStarts = reasons.filter((r) => r === "phaseStart");
    assertGreater(
      phaseStarts.length,
      0,
      "expected at least one phaseStart sound during the first build→battle sequence",
    );
  },
);

Deno.test(
  "sound observer: battle:cannonFired fires per cannon shot through observer even with SOUND_OFF",
  async () => {
    const reasons: SoundReason[] = [];
    using sc = await createScenario({
      seed: 42,
      soundObserver: { played: (reason) => reasons.push(reason) },
    });

    // Drive past the first battle's mid-point so cannons have had a
    // chance to fire. The same shape as the haptics test — wait until
    // BATTLE phase, then run frames until at least one cannonFired
    // reason has been observed.
    waitForPhase(sc, Phase.BATTLE);
    sc.runUntil(
      () => reasons.includes("battle:cannonFired"),
      2000,
    );

    const cannonFired = reasons.filter((r) => r === "battle:cannonFired");
    assertGreater(
      cannonFired.length,
      0,
      "expected at least one battle:cannonFired sound during the first battle (was the observer installed?)",
    );
  },
);

Deno.test(
  "sound observer: drumsStart fires when entering selection / battle",
  async () => {
    const reasons: SoundReason[] = [];
    using sc = await createScenario({
      seed: 42,
      soundObserver: { played: (reason) => reasons.push(reason) },
    });

    // `runtime-selection.ts:180` and `:500` call `sound.drumsStart()`
    // when the selection phase enters its drumming sub-phases. Driving
    // to BATTLE crosses both call sites at least once.
    waitForPhase(sc, Phase.BATTLE);

    assert(
      reasons.includes("drumsStart"),
      `expected drumsStart sound during selection / pre-battle, got reasons: ${reasons.join(",")}`,
    );
  },
);
