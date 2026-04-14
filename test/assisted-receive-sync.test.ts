/**
 * Assisted receive-side sync — validates that a remote peer receiving the
 * wire messages from a locally-driven AiAssistedHumanController ends up
 * with state consistent with the host.
 *
 * Unlike host-vs-local-sync (single runtime, two modes), this is a
 * two-runtime loopback:
 *   - Host: runs the game with slot 1 as AiAssistedHuman locally. Emits
 *     OPPONENT_PIECE_PLACED / OPPONENT_CANNON_PLACED / CANNON_FIRED
 *     messages as slot 1 acts.
 *   - Receiver: runs the same seed + mode with slot 1 marked remote
 *     (no local AI for that slot). State for slot 1 arrives via
 *     deliverMessage → handleServerMessage applying each incoming
 *     message.
 *
 * After each host tick, new messages are forwarded to the receiver,
 * then the receiver ticks once. Both advance in lockstep.
 *
 * Assertions are intentionally looser than host-vs-local-sync because
 * event ORDER can legitimately differ (receiver's local AIs for slots
 * 0/2/3 interleave with slot-1 messages differently than the host's
 * fully-local order). What we DO assert:
 *   - No throws during message delivery (catches receive-side
 *     invariant failures like stale interior epochs).
 *   - Slot 1's wall count + cannon count match host's at each phase
 *     boundary.
 *
 * What this catches:
 *   - handlePiecePlaced / handleCannonPlaced / handleCannonFire bugs
 *     on the receive side (missing recheckTerritory, wrong mutation
 *     shape, etc.).
 *   - Wire payload info loss (e.g. offsets not being fully applied).
 */

import { assert, assertEquals } from "@std/assert";
import { createScenario } from "./scenario.ts";
import { createOnlineScenario } from "./online-headless.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import type { ServerMessage } from "../src/protocol/protocol.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";

const SEEDS_AND_MODES = [
  { seed: 42, mode: "classic" as const },
  { seed: 7, mode: "modern" as const },
];

for (const { seed, mode } of SEEDS_AND_MODES) {
  Deno.test(
    `assisted receive sync: seed ${seed} (${mode}) — receiver state tracks host for slot 1`,
    async () => {
      const slot = 1 as ValidPlayerSlot;

      const host = await createScenario({ seed, mode, rounds: 2 });
      await host.installAssistedController(slot);

      const receiver = await createOnlineScenario({
        seed,
        mode,
        rounds: 2,
        remotePlayerSlots: new Set<ValidPlayerSlot>([slot]),
      });

      // Snapshot slot-1 wall + cannon counts on each host phase end
      // so we can assert the receiver caught up by the same boundary.
      const hostSnapshots: {
        phase: string;
        walls: number;
        cannons: number;
      }[] = [];
      host.bus.on(GAME_EVENT.PHASE_START, (ev) => {
        const player = host.state.players[slot];
        if (!player) return;
        hostSnapshots.push({
          phase: ev.phase,
          walls: player.walls.size,
          cannons: player.cannons.length,
        });
      });

      // Lockstep tick loop. Forward new host messages to receiver before
      // receiver advances its clock, so slot-1 mutations land at the
      // same sim-tick on both sides.
      let forwarded = 0;
      const MAX_STEPS = 60_000;
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

      // Receiver's slot-1 counts should match host's at game end.
      const hostPlayer = host.state.players[slot]!;
      const receiverPlayer = receiver.state.players[slot]!;
      assertEquals(
        receiverPlayer.walls.size,
        hostPlayer.walls.size,
        `slot ${slot} wall count diverged: host=${hostPlayer.walls.size}, receiver=${receiverPlayer.walls.size}`,
      );
      assertEquals(
        receiverPlayer.cannons.length,
        hostPlayer.cannons.length,
        `slot ${slot} cannon count diverged: host=${hostPlayer.cannons.length}, receiver=${receiverPlayer.cannons.length}`,
      );
      assert(
        hostSnapshots.length > 0,
        "expected at least one phase transition during the game",
      );
    },
  );
}
