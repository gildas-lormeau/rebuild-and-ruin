/**
 * Life-lost receive-side sync — asserts that when a tower dies during
 * battle, host and receiver agree on which players lost a life and on
 * the resulting life counts.
 *
 * Exposes a latent asymmetry on the human-driven-slot path: the
 * life-lost dialog's `needsLocalInput` wiring (in runtime-life-lost.ts)
 * still keys on `isHuman(ctrl)`, so an AssistedHuman slot (kind:"human"
 * but AI-driven) falls into the wait-for-UI-input branch on host — the
 * entry doesn't auto-resolve, no LIFE_LOST_CHOICE broadcast goes out,
 * and the receiver ends up making its own (different) choice for that
 * slot. This is the same shape as the upgrade-pick asymmetry that was
 * fixed in a prior commit.
 *
 * Currently FAILING — kept as a reproducer for the open bug.
 *
 * Seed chosen (1, classic, rounds 8) because it reliably kills at least
 * one home tower during the run, which is what triggers the life-lost
 * dialog. Shorter runs on this seed may not reach the state; the test
 * just runs the whole game to STOPPED on both sides.
 */

import { assertEquals } from "@std/assert";
import { createScenario } from "./scenario.ts";
import { createOnlineScenario } from "./online-headless.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import type { ServerMessage } from "../src/protocol/protocol.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";

Deno.test(
  "assisted receive sync (life lost): seed 1 classic — life counts match after tower kills",
  async () => {
    const slot = 1 as ValidPlayerSlot;
    const seed = 1;

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

    const hostLives = host.state.players.map((p) => p!.lives);
    const receiverLives = receiver.state.players.map((p) => p!.lives);
    assertEquals(
      receiverLives,
      hostLives,
      `life counts diverged: host=[${hostLives.join(",")}] receiver=[${receiverLives.join(",")}]`,
    );
  },
);
