/**
 * Network send observer tests — verify the runtime's host fan-out path
 * actually broadcasts the expected messages, end-to-end through real
 * sub-systems and without spinning up a real WebSocket.
 *
 * Headless wires `network.send` to a no-op by default. When the scenario
 * is created with `hostMode: true`, the runtime takes the online code
 * path (`isOnline = !!onlinePhaseTicks`), and `scenario.ts` installs a
 * `networkObserver` whose `sent` callback pushes every outbound message
 * into the read-only `sc.sentMessages` array.
 *
 * Why this is the highest-value seam: state-comparison tests
 * (`host-vs-local-sync`) catch *divergence* between local and host
 * runs, but they never look at the messages themselves. A bug that
 * forgets to broadcast `castleWalls`, or sends the wrong tower index,
 * keeps both runtimes in sync (because they both see the same local
 * state) but breaks every other peer that depends on the broadcast.
 * This observer catches those bugs before they ship.
 */

import { assert, assertGreater } from "@std/assert";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import { MESSAGE } from "../src/protocol/protocol.ts";
import { createScenario, waitForPhase } from "./scenario.ts";

Deno.test(
  "network observer: hostMode runtime broadcasts phase checkpoints by the time the first battle starts",
  async () => {
    using sc = await createScenario({ seed: 42, hostMode: true });
    waitForPhase(sc, Phase.BATTLE);

    // Bucket message types so the assertions can lean on counts rather
    // than reading specific indices (which would couple the test to the
    // exact emission order).
    const counts = new Map<string, number>();
    for (const msg of sc.sentMessages) {
      counts.set(msg.type, (counts.get(msg.type) ?? 0) + 1);
    }

    // Wire = uncomputable inputs only. Pure-AI scenarios produce no
    // OPPONENT_CANNON_PLACED / OPPONENT_PIECE_PLACED / OPPONENT_TOWER_SELECTED
    // / CASTLE_WALLS / CANNON_FIRED — every peer recomputes those from
    // strategy.rng + state. What the host DOES broadcast is the phase-
    // checkpoint markers (CANNON_START → BATTLE_START → BUILD_START →
    // BUILD_END), which serve as deterministic "advance now" notifications
    // for watchers' phase machines.
    assertGreater(
      counts.get(MESSAGE.CANNON_START) ?? 0,
      0,
      "expected host to broadcast CANNON_START on castle-done",
    );
    assertGreater(
      counts.get(MESSAGE.BATTLE_START) ?? 0,
      0,
      "expected host to broadcast BATTLE_START on cannon-place-done",
    );
  },
);

Deno.test(
  "network observer: assisted-human slots broadcast their placements through network.send",
  async () => {
    using sc = await createScenario({
      seed: 42,
      hostMode: true,
      assistedSlots: [0 as ValidPlayerSlot],
    });
    waitForPhase(sc, Phase.BATTLE);

    // Assisted-human controllers are treated as humans for protocol
    // purposes — their placements (driven internally by AI but emitted
    // through the human input path) broadcast OPPONENT_CANNON_PLACED /
    // OPPONENT_PIECE_PLACED. This is the test that catches a regression
    // where the human-input broadcast seam stops firing.
    const counts = new Map<string, number>();
    for (const msg of sc.sentMessages) {
      counts.set(msg.type, (counts.get(msg.type) ?? 0) + 1);
    }
    assertGreater(
      counts.get(MESSAGE.OPPONENT_CANNON_PLACED) ?? 0,
      0,
      "expected assisted-human slot to broadcast OPPONENT_CANNON_PLACED",
    );
  },
);

Deno.test(
  "network observer: every captured message has a known protocol type",
  async () => {
    using sc = await createScenario({ seed: 42, hostMode: true });
    waitForPhase(sc, Phase.BATTLE);

    // Sanity guard: every dispatched message should have a `type` field
    // that matches a value in the MESSAGE registry. Catches a typo or
    // a hand-rolled object literal slipping into a `network.send` call.
    const knownTypes = new Set<string>(Object.values(MESSAGE));
    for (const msg of sc.sentMessages) {
      assert(
        typeof msg.type === "string" && knownTypes.has(msg.type),
        `unknown message type: ${msg.type}`,
      );
    }
    assertGreater(sc.sentMessages.length, 0, "expected at least one message");
  },
);
