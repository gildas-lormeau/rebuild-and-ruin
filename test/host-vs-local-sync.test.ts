/**
 * Host-vs-local sync test — runs the same game twice with the same seed,
 * once in pure local mode and once in "online host" mode (with a no-op
 * `OnlinePhaseTicks` wired through the runtime). Asserts that both runs
 * produce byte-for-byte identical bus event logs.
 *
 * What this catches:
 *   - Any place in the runtime that branches on `isOnline` (or
 *     `onlinePhaseTicks` presence) and produces different state.
 *   - Any host-side broadcast hook that mutates state instead of just
 *     emitting messages.
 *   - Any phase-tick code path that subtly behaves differently when the
 *     online coordination hooks are wired vs. absent.
 *
 * What this does NOT catch:
 *   - Watcher-side bugs (no watcher exists in this test).
 *   - Real serialization round-trip bugs (broadcasts go to /dev/null).
 *   - WebSocket transport issues.
 * Those need a 2-machine loopback test, which is a separate test pattern.
 *
 * The whole point is that "host mode with all-noop hooks" should be
 * indistinguishable from "local mode" from the host's perspective. If it
 * ever diverges, the runtime has acquired a hidden coupling between online
 * mode and game state evolution — which is a bug.
 */

import { assertEquals } from "@std/assert";
import { createScenario, recordEvents, type RecordedEvent } from "./scenario.ts";

const SEEDS_AND_MODES = [
  { seed: 42, mode: "classic" as const },
  { seed: 7, mode: "modern" as const },
];

for (const { seed, mode } of SEEDS_AND_MODES) {
  Deno.test(`host-vs-local sync: seed ${seed} (${mode}) — host mode matches local mode`, async () => {
    // Run 1: pure local mode (no onlinePhaseTicks).
    const local = await createScenario({ seed, mode });
    const localEvents = recordEvents(local);
    local.runGame();

    // Run 2: host mode (no-op onlinePhaseTicks wired). Same seed, same mode.
    const host = await createScenario({ seed, mode, hostMode: true });
    const hostEvents = recordEvents(host);
    host.runGame();

    if (hostEvents.length !== localEvents.length) {
      const divergence = findFirstDivergence(hostEvents, localEvents);
      throw new Error(
        `event count mismatch: host produced ${hostEvents.length}, local produced ${localEvents.length}. ` +
          `First divergence at index ${divergence}: ` +
          `host=${JSON.stringify(hostEvents[divergence])}, ` +
          `local=${JSON.stringify(localEvents[divergence])}`,
      );
    }

    for (let i = 0; i < hostEvents.length; i++) {
      assertEquals(
        hostEvents[i],
        localEvents[i],
        `event ${i} (${hostEvents[i]!.type}) differs between host and local`,
      );
    }
  });
}

/** Return the index of the first event that differs (or the shorter length if
 *  one log is a strict prefix of the other). */
function findFirstDivergence(
  host: readonly RecordedEvent[],
  local: readonly RecordedEvent[],
): number {
  const min = Math.min(host.length, local.length);
  for (let i = 0; i < min; i++) {
    if (JSON.stringify(host[i]) !== JSON.stringify(local[i])) return i;
  }
  return min;
}
