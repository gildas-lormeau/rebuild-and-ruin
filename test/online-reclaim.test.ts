/**
 * Seat give-back parity test (HIGH-2 step 3c-2) — end-to-end validation of
 * the deferred room-wide resync + reclaim flow:
 *
 *   host + watcher play → the watcher's seat goes AWAY (host AI takeover) →
 *   the host plays on, firing into the deferral window → a freshly-booted
 *   SPECTATOR rejoiner adopts the host's DEFERRED room-wide resync broadcast
 *   (the no-op self-migration) and RECLAIMS the seat → host + rejoiner run to
 *   the end → byte-parity.
 *
 * Why a fresh spectator peer (not the original watcher): a real rejoiner
 * re-boots clean, so every seat is a mirror/pure-AI controller built off the
 * same seed as the host (matching personalities + the shared state.rng AI
 * strategy). It adopts the broadcast via the migration path (kept controllers
 * + paired reprime), so the host's and the rejoiner's AI draw the identical
 * state.rng stream. (The earlier targeted applyMidGameCheckpoint forked here:
 * it rebuilt the AI on a PRIVATE rng stream, so the rejoiner's slot-2 AI
 * stopped consuming state.rng while the host's kept consuming it.)
 *
 * What it pins:
 *  - the DEFERRAL: the host fires slot 0 right before the resync request, so
 *    that fire's applyAt lands in (requestTick, requestTick+SAFETY]. The
 *    rejoiner skips the away backlog, so it can only get that fire from the
 *    snapshot — drained in only because the rebroadcast is deferred.
 *  - the BROADCAST resync: host + rejoiner stay byte-identical through the AI
 *    re-prime (the fork the old targeted path produced).
 *  - the RECLAIM swap: the seat flips back to its owner (idle HumanController
 *    in headless — no input source — matching the host's now-remote seat).
 *
 * `scenario.ts` MUST evaluate before `network-setup.ts` (see the note in
 * network-bidirectional.test.ts); the value import forces it.
 */

import { createScenario, type Scenario } from "./scenario.ts";
import { assert, assertEquals } from "@std/assert";
import { MESSAGE, type ServerMessage } from "../src/protocol/protocol.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import {
  createBidirectionalNetworkedPair,
  createSpectatorRejoiner,
  snapshotPlayers,
} from "./network-setup.ts";

const AWAY_SLOT = 1 as ValidPlayerId;

void createScenario;

Deno.test(
  "seat give-back: away → deferred broadcast resync → reclaim keeps parity",
  async () => {
    const opts = {
      seed: 42,
      mode: "classic" as const,
      rounds: 3,
    };
    const pair = await createBidirectionalNetworkedPair({
      ...opts,
      assistedSlotsHost: [0 as ValidPlayerId],
      assistedSlotsWatcher: [AWAY_SLOT],
      wireDelayFrames: 0,
    });
    const { host, watcher, hostSession } = pair;

    const hostToWatcher = makeForwarder(host, watcher);
    const watcherToHost = makeForwarder(watcher, host);
    const pumpPair = async () => {
      await hostToWatcher.pump();
      await watcherToHost.pump();
    };

    const slot0Fires = () =>
      host.sentMessages.filter((msg) => {
        const m = msg as { type: string; playerId?: number };
        return m.type === MESSAGE.CANNON_FIRED && m.playerId === 0;
      }).length;

    // ── Phase 1: host + watcher play in lockstep into the first BATTLE ──
    let guard = 0;
    while (
      host.state.phase !== Phase.BATTLE ||
      watcher.state.phase !== Phase.BATTLE
    ) {
      host.tick(1);
      watcher.tick(1);
      await pumpPair();
      if (++guard > 30_000) throw new Error("never reached BATTLE on both");
    }
    for (let i = 0; i < 15; i++) {
      host.tick(1);
      watcher.tick(1);
      await pumpPair();
    }

    // ── Phase 2: the watcher goes AWAY — the host sees PLAYER_LEFT and takes
    // the seat over (lockstep AI). The watcher is now frozen + discarded. ──
    await host.deliverMessage({
      type: MESSAGE.PLAYER_LEFT,
      playerId: AWAY_SLOT,
    } as ServerMessage);
    for (let i = 0; i < 24; i++) host.tick(1);
    assert(
      !hostSession.remotePlayerSlots.has(AWAY_SLOT),
      "host should have taken the away seat over (AI-held)",
    );

    // ── Phase 3: a freshly-booted SPECTATOR rejoiner (every seat a mirror/AI
    // off the host's seed). Slot 0 is the host's seat → wire-driven here. ──
    const rejoinerBuild = await createSpectatorRejoiner(
      opts,
      new Set<ValidPlayerId>([0 as ValidPlayerId]),
    );
    const rejoiner = rejoinerBuild.scenario;
    const rejoinerSession = rejoinerBuild.session;
    const hostToRejoiner = makeForwarder(host, rejoiner);
    const rejoinerToHost = makeForwarder(rejoiner, host);

    // ── Phase 4: fire slot 0 into the deferral window — tick the host until a
    // FRESH slot-0 fire (its applyAt = fireTick + SAFETY lands in
    // (requestTick, requestTick+SAFETY] when we request the resync next). ──
    const firesBefore = slot0Fires();
    let g2 = 0;
    while (slot0Fires() === firesBefore && host.state.phase === Phase.BATTLE) {
      host.tick(1);
      if (++g2 > 4_000) break;
    }
    assert(
      slot0Fires() > firesBefore,
      "host slot 0 never fired during the away window — deferral not exercised",
    );

    // ── Phase 5: the rejoiner returns. Arm the resync routing, route the
    // request to the host, and skip the away backlog (the rejoiner connected
    // late — it can only get the pre-request fire from the snapshot). ──
    rejoinerSession.awaitingRejoinSeat = AWAY_SLOT;
    rejoinerSession.awaitingRejoinResync = true;
    hostToRejoiner.skipBacklog();
    await host.deliverMessage({
      type: MESSAGE.REQUEST_RESYNC,
      forPlayerId: AWAY_SLOT,
    } as ServerMessage);

    // ── Phase 6: drive the host until the DEFERRED broadcast fires
    // (requestTick + SAFETY), then deliver everything-after-rejoin to the
    // rejoiner: the in-flight fires (applyAt > snapshotTick) schedule, then the
    // FULL_STATE adopts via the migration path + requests the give-back. ──
    const isFullState = (msg: unknown) =>
      (msg as { type: string }).type === MESSAGE.FULL_STATE;
    let g3 = 0;
    while (!host.sentMessages.some(isFullState)) {
      host.tick(1);
      if (++g3 > 200) throw new Error("deferred broadcast resync never fired");
    }
    await hostToRejoiner.pump();
    assert(
      !rejoinerSession.awaitingRejoinResync,
      "rejoiner should have adopted the resync",
    );

    // ── Phase 7: relay the give-back and let it apply. REQUEST_SEAT_RECLAIM →
    // host stamps SEAT_RECLAIM → both schedule + flip at the stamped tick. ──
    await rejoinerToHost.pump();
    assert(
      host.sentMessages.some(
        (m) => (m as { type: string }).type === MESSAGE.SEAT_RECLAIM,
      ),
      "host should have approved + stamped a SEAT_RECLAIM",
    );
    const pumpReclaim = async () => {
      await hostToRejoiner.pump();
      await rejoinerToHost.pump();
    };
    for (let i = 0; i < 16; i++) {
      host.tick(1);
      rejoiner.tick(1);
      await pumpReclaim();
    }
    assert(
      hostSession.remotePlayerSlots.has(AWAY_SLOT),
      "after reclaim the host drives the seat from the wire again",
    );
    assert(
      rejoinerSession.occupiedSlots.has(AWAY_SLOT),
      "after reclaim the owner holds its seat again",
    );
    assertEquals(
      snapshotPlayers(rejoiner),
      snapshotPlayers(host),
      "post-reclaim parity (broadcast resync kept the AI re-prime paired)",
    );

    // ── Phase 8: run host + rejoiner to the end and re-assert byte-parity. ──
    let g4 = 0;
    while (host.mode() !== Mode.STOPPED || rejoiner.mode() !== Mode.STOPPED) {
      host.tick(1);
      rejoiner.tick(1);
      await pumpReclaim();
      if (++g4 > 60_000) {
        throw new Error(
          `reclaim run did not reach STOPPED (host=${host.mode()} ` +
            `rejoiner=${rejoiner.mode()})`,
        );
      }
    }
    assertEquals(
      snapshotPlayers(rejoiner),
      snapshotPlayers(host),
      "end-of-game parity after the full away → resync → reclaim cycle",
    );
  },
);

/** Forward newly-appended messages from `from` to `to`, advancing a cursor. */
function makeForwarder(
  from: Scenario,
  to: Scenario,
): { pump: () => Promise<void>; skipBacklog: () => void } {
  let cursor = 0;
  return {
    pump: async () => {
      while (cursor < from.sentMessages.length) {
        await to.deliverMessage(from.sentMessages[cursor++] as ServerMessage);
      }
    },
    skipBacklog: () => {
      cursor = from.sentMessages.length;
    },
  };
}
