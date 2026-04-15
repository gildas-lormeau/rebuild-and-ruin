/**
 * Stale-interior crash on receive side — asserts that delivering wire
 * messages through a full run never hits the "walls epoch > interior
 * epoch" invariant check in `getInterior()`.
 *
 * Reproducer for a hard throw on the receiver:
 *
 *   Error: Stale interior for player 1: walls epoch N > interior epoch N-1.
 *   Call recheckTerritory() after wall mutations before reading interior.
 *     at canPlaceCannon (src/game/cannon-system.ts)
 *     at handleCannonPlaced (src/online/online-server-events.ts)
 *
 * Some OPPONENT_PIECE_PLACED → OPPONENT_CANNON_PLACED sequence on the
 * receiver mutates walls (advancing walls-epoch) without a follow-up
 * recheckTerritory, so the next `canPlaceCannon` sees a stale interior
 * and the invariant check throws.
 *
 * Currently FAILING — kept as a reproducer for the open bug.
 *
 * Seed chosen (13, classic, rounds 8) because it reliably triggers the
 * throw during play. The assertion is just "no throw through the whole
 * run"; once the missing recheckTerritory is added, this test passes
 * without needing an end-of-game state comparison.
 */

import { createScenario } from "./scenario.ts";
import { createOnlineScenario } from "./online-headless.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import type { ServerMessage } from "../src/protocol/protocol.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";

Deno.test(
  "assisted receive sync (stale interior): seed 13 classic — no interior-epoch throw during delivery",
  async () => {
    const slot = 1 as ValidPlayerSlot;
    const seed = 13;

    const host = await createScenario({ seed, mode: "classic", rounds: 8 });
    await host.installAssistedController(slot);

    const receiver = await createOnlineScenario({
      seed,
      mode: "classic",
      rounds: 8,
      remotePlayerSlots: new Set<ValidPlayerSlot>([slot]),
    });

    let forwarded = 0;
    const MAX_STEPS = 240_000;
    for (let step = 0; step < MAX_STEPS; step++) {
      host.tick(1);
      const newMsgs = host.sentMessages.slice(forwarded);
      forwarded = host.sentMessages.length;
      for (const msg of newMsgs) {
        await receiver.deliverMessage(msg as ServerMessage);
      }
      receiver.tick(1);
      if (host.mode() === Mode.STOPPED && receiver.mode() === Mode.STOPPED)
        break;
    }
    // No assertions needed — the test passes iff delivery never threw.
  },
);
