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
import { MESSAGE } from "../src/shared/net/protocol.ts";
import { createScenario, waitForPhase } from "./scenario.ts";

Deno.test(
  "network observer: hostMode runtime broadcasts selection + placement messages by the time the first battle starts",
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

    // Selection: each tower the host chose during castle-select fires
    // OPPONENT_TOWER_SELECTED, including the auto-selected first round.
    assertGreater(
      counts.get(MESSAGE.OPPONENT_TOWER_SELECTED) ?? 0,
      0,
      "expected host to broadcast OPPONENT_TOWER_SELECTED during castle selection",
    );

    // Castle walls: the host broadcasts every player's auto-built first-
    // round castle as a CASTLE_WALLS message (one per player).
    assertGreater(
      counts.get(MESSAGE.CASTLE_WALLS) ?? 0,
      0,
      "expected host to broadcast CASTLE_WALLS for the auto-built first round",
    );

    // Cannon placement: every cannon the host (or its AI shims) places
    // during the cannon phase fans out as OPPONENT_CANNON_PLACED.
    assertGreater(
      counts.get(MESSAGE.OPPONENT_CANNON_PLACED) ?? 0,
      0,
      "expected host to broadcast OPPONENT_CANNON_PLACED during the cannon-place phase",
    );
  },
);

Deno.test(
  "network observer: local-play runtime still calls network.send (impl is no-op, but the seam is wired)",
  async () => {
    using sc = await createScenario({ seed: 42, hostMode: false });
    waitForPhase(sc, Phase.BATTLE);

    // Important nuance: even local play wraps every "broadcastable"
    // action (`sendCastleWalls`, `sendTowerSelected`, …) in a
    // `config.network.send` call. The local-play impl is `() => {}`, so
    // peers never see anything, but the observer is wrapping the call
    // *before* the no-op fires, so it still captures every message. The
    // difference between local and host mode is on the *receiver* side
    // (no peers in local) and in the additional `onlinePhaseTicks`
    // checkpoint fan-out (which goes through a separate path, not
    // `network.send`).
    //
    // We assert that the count is non-zero so a future "skip the send
    // entirely in local mode" optimization doesn't silently break the
    // observer's coverage of the action wrappers.
    assertGreater(
      sc.sentMessages.length,
      0,
      "local-play should still hit the send wrappers (the underlying impl no-ops)",
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
