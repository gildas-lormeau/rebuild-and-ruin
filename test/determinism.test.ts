/**
 * Determinism test — replay scenarios from saved fixtures and assert that
 * every bus event matches byte-for-byte.
 *
 * If this test fails after a code change, the runtime is non-deterministic
 * for the affected seed. Either:
 *   - Revert the change (most likely — accidental RNG drift, Map iteration
 *     order assumption, etc.), OR
 *   - If the change is intentional and ALL the divergences are expected,
 *     re-record the fixture with `npm run record-determinism -- --seed N --mode M`
 *     and verify the new event log makes sense.
 *
 * NEVER update a fixture to "fix" a determinism failure without a written
 * justification — that's how subtle non-determinism bugs ship.
 */

import { assertEquals } from "@std/assert";
import { createScenario, recordEvents, type RecordedEvent } from "./scenario.ts";

interface Fixture {
  readonly seed: number;
  readonly opts: {
    readonly seed: number;
    readonly mode: "classic" | "modern";
    readonly rounds: number;
    /** Camera-determinism fixtures opt in: enables mobile auto-zoom so
     *  per-phase memory and CAMERA_TARGET event emission run during replay. */
    readonly mobileZoomEnabled?: boolean;
  };
  readonly timeoutMs: number;
  readonly eventCount: number;
  readonly events: RecordedEvent[];
}

const FIXTURES = [
  "seed-42-classic.json",
  // 5-round modern fixtures exercise the round-3+ feature gates:
  // modifier rolls (MODIFIER_FIRST_ROUND=3), upgrade pick lifecycle
  // (UPGRADE_FIRST_ROUND=3, suppressed for the final round). Both
  // fixtures include multiple modifierApplied + upgradePicked events,
  // and seed-0 picks the Ceasefire upgrade — exercising the full
  // ceasefire path (enterBuildSkippingBattle → finalizeBattle).
  // Adding a new modifier or upgrade shifts weighted-selection thresholds
  // and will diverge here — that's the whole point of the gate. Re-record
  // (with a written reason) only when an intentional registry change
  // makes the divergence expected.
  "seed-7-modern.json",
  "seed-0-modern.json",
  // Camera-determinism fixture: same headless run as seed-42-classic but
  // with mobileZoomEnabled=true so CAMERA_TARGET events are emitted at
  // every phase entry / explicit zone command / engageAutoZoom / follow-
  // crosshair trigger. Catches drift in the camera v2 phase-transition
  // and per-phase-memory paths.
  "seed-42-classic-camera.json",
] as const;

for (const fixtureFile of FIXTURES) {
  Deno.test(`determinism: replay ${fixtureFile} matches recorded fixture`, async () => {
    const fixture: Fixture = JSON.parse(
      await Deno.readTextFile(`./test/determinism-fixtures/${fixtureFile}`),
    );

    const sc = await createScenario(fixture.opts);
    const events = recordEvents(sc);
    sc.runGame({ timeoutMs: fixture.timeoutMs });

    // Event count must match exactly. A mismatch usually means the runtime
    // entered a different code path (e.g. an extra grunt spawned, a banner
    // skipped). The diff position below tells you WHERE it diverged.
    if (events.length !== fixture.events.length) {
      const divergence = findFirstDivergence(events, fixture.events);
      throw new Error(
        `event count mismatch: replay produced ${events.length}, fixture has ${fixture.events.length}. ` +
          `First divergence at index ${divergence}: ` +
          `replay=${JSON.stringify(events[divergence])}, ` +
          `fixture=${JSON.stringify(fixture.events[divergence])}`,
      );
    }

    // Per-event deep equality. We compare one at a time so the failure
    // message points at the exact event that drifted.
    for (let i = 0; i < events.length; i++) {
      assertEquals(
        events[i],
        fixture.events[i],
        `event ${i} (${events[i]!.type}) differs from fixture`,
      );
    }
  });
}

/** Return the index of the first event that differs (or the shorter length if
 *  one log is a strict prefix of the other). */
function findFirstDivergence(
  replay: readonly RecordedEvent[],
  fixture: readonly RecordedEvent[],
): number {
  const min = Math.min(replay.length, fixture.length);
  for (let i = 0; i < min; i++) {
    if (JSON.stringify(replay[i]) !== JSON.stringify(fixture[i])) return i;
  }
  return min;
}
