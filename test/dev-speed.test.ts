/**
 * `__dev.speed(N)` determinism test.
 *
 * Invariant: running the game for K frames at speed=N produces a bus event
 * log identical to running for K*N frames at speed=1.
 *
 * This is the load-bearing property of the dev speed mechanism. If it
 * holds, "speed up" is just sub-stepping the same game logic — no RNG
 * drift, no skipped collisions, no visual artifacts. If it does NOT hold
 * (e.g. because dt is multiplied instead of sub-stepped), the game state
 * diverges from a normal-speed run with the same seed and "speed up"
 * silently corrupts the simulation.
 *
 * The previous implementation `dt *= speedMultiplier` failed this test
 * — at speed=16, dt=0.256s per frame caused grunts and cannonballs to
 * skip past walls and water boundaries, RNG consumption shifted, and the
 * event log diverged within ~50 frames.
 */

import { assertEquals } from "@std/assert";
import { createScenario, recordEvents } from "./scenario.ts";

/** Test cases: speed=2, speed=4, speed=16. Each compares K outer frames
 *  at the given speed against K*speed frames at speed=1. */
const SEED = 42;
const FRAMES_AT_SPEED_N = 100;

for (const SPEED of [2, 4, 16] as const) {
  Deno.test(
    `dev speed: ${FRAMES_AT_SPEED_N} frames at speed=${SPEED} == ${FRAMES_AT_SPEED_N * SPEED} frames at speed=1 (bus event parity)`,
    async () => {
      // Reference run at normal speed.
      const reference = await createScenario({ seed: SEED, mode: "modern" });
      const referenceEvents = recordEvents(reference);
      reference.tick(FRAMES_AT_SPEED_N * SPEED);

      // Sub-stepped run at SPEED× — fewer outer frames, but each frame
      // sub-steps SPEED times so the total game-time advance matches.
      const sped = await createScenario({
        seed: SEED,
        mode: "modern",
        speedMultiplier: SPEED,
      });
      const spedEvents = recordEvents(sped);
      sped.tick(FRAMES_AT_SPEED_N);

      // Bus event logs must match byte-for-byte. Compare event count first
      // so the failure message points at the first divergence (much more
      // useful than a giant per-event diff).
      if (spedEvents.length !== referenceEvents.length) {
        const min = Math.min(spedEvents.length, referenceEvents.length);
        let firstDiff = min;
        for (let i = 0; i < min; i++) {
          if (
            JSON.stringify(spedEvents[i]) !==
            JSON.stringify(referenceEvents[i])
          ) {
            firstDiff = i;
            break;
          }
        }
        throw new Error(
          `event count mismatch: speed=${SPEED} produced ${spedEvents.length}, ` +
            `speed=1 produced ${referenceEvents.length}. ` +
            `First divergence at index ${firstDiff}: ` +
            `sped=${JSON.stringify(spedEvents[firstDiff])}, ` +
            `reference=${JSON.stringify(referenceEvents[firstDiff])}`,
        );
      }

      for (let i = 0; i < referenceEvents.length; i++) {
        assertEquals(
          spedEvents[i],
          referenceEvents[i],
          `event ${i} (${spedEvents[i]!.type}) differs between speed=${SPEED} and speed=1`,
        );
      }
    },
  );
}
