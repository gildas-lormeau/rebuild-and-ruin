/**
 * Assisted host-vs-local sync — same spirit as host-vs-local-sync, but
 * with slot 1 driven by an AiAssistedHumanController instead of a pure AI.
 *
 * Runs the same game twice with the same seed:
 *   - Run A: local mode, slot 1 is assisted.
 *   - Run B: host mode (no-op OnlinePhaseTicks wired), slot 1 is assisted.
 *
 * Asserts byte-identical bus event logs. If they diverge, wiring the host
 * coordination path has altered the human-driven code path — a bug.
 *
 * What this catches (beyond plain host-vs-local-sync):
 *   - Host-mode broadcast hooks that mutate state instead of just emitting
 *     messages, specifically on the human-driven placement path
 *     (tryPlacePieceAndSend / tryPlaceCannonAndSend / fireAndSend).
 *   - Any isHuman-gated branch that fires only in host mode and changes
 *     gameplay.
 *
 * The whole point is that "host mode" should be indistinguishable from
 * "local mode" from the host's perspective — including when a human-shaped
 * controller is producing placements via the intent/send pipeline.
 */

import { assertEquals } from "@std/assert";
import {
  createScenario,
  recordEvents,
  type RecordedEvent,
} from "./scenario.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";

const SEEDS_AND_MODES = [
  { seed: 42, mode: "classic" as const },
  { seed: 7, mode: "modern" as const },
];

for (const { seed, mode } of SEEDS_AND_MODES) {
  Deno.test(
    `assisted host-vs-local sync: seed ${seed} (${mode}) — host mode matches local mode`,
    async () => {
      const local = await createScenario({ seed, mode });
      await local.installAssistedController(1 as ValidPlayerSlot);
      const localEvents = recordEvents(local);
      local.runGame();

      const host = await createScenario({ seed, mode, hostMode: true });
      await host.installAssistedController(1 as ValidPlayerSlot);
      const hostEvents = recordEvents(host);
      host.runGame();

      if (hostEvents.length !== localEvents.length) {
        const idx = findFirstDivergence(hostEvents, localEvents);
        throw new Error(
          `event count mismatch: host=${hostEvents.length}, local=${localEvents.length}. ` +
            `First divergence at index ${idx}: ` +
            `host=${JSON.stringify(hostEvents[idx])}, ` +
            `local=${JSON.stringify(localEvents[idx])}`,
        );
      }

      for (let i = 0; i < hostEvents.length; i++) {
        assertEquals(
          hostEvents[i],
          localEvents[i],
          `event ${i} (${hostEvents[i]!.type}) differs between host and local`,
        );
      }
    },
  );
}

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
