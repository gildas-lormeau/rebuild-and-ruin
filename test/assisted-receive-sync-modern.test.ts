/**
 * Modern-mode assisted receive-side sync — extension of
 * assisted-receive-sync that exercises modifier + upgrade state across
 * the wire for a human-driven slot.
 *
 * Why a separate test: the base assisted-receive-sync only asserts wall
 * and cannon counts. Modern mode adds a large block of state
 * (`state.modern.*` + per-player `upgrades` + `damagedWalls`) generated
 * from synced RNG and mutated by the upgrade-pick / modifier pipelines.
 * None of that surface is touched by the base test's count assertions.
 *
 * Runs `rounds: 4` so the game crosses into the upgrade-pick era
 * (UPGRADE_FIRST_ROUND = 3) and gives at least two modifier rolls a
 * chance to trip divergence.
 *
 * What we assert (at game end):
 *   - slot 1's walls + cannons match (the base guarantees)
 *   - `state.modern.activeModifier` matches
 *   - `state.modern.lastModifierId` matches
 *   - `state.modern.frozenTiles` cardinality matches
 *   - every player's `upgrades` map (ids + counts) matches
 *   - every player's `damagedWalls` cardinality matches
 *
 * A per-player upgrade divergence here means the upgrade-pick broadcast
 * for a human-driven slot dropped a pick, OR the offer-generation RNG
 * got out of sync between host and receiver, OR an upgrade effect
 * mutated state differently on the two sides.
 */

import { assert, assertEquals } from "@std/assert";
import { createScenario } from "./scenario.ts";
import { createOnlineScenario } from "./online-headless.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import type { ServerMessage } from "../src/protocol/protocol.ts";
import { Mode } from "../src/shared/ui/ui-mode.ts";

Deno.test(
  "assisted receive sync (modern): modifier + upgrade state converges for slot 1",
  async () => {
    const slot = 1 as ValidPlayerSlot;
    const seed = 7;

    const host = await createScenario({ seed, mode: "modern", rounds: 4 });
    await host.installAssistedController(slot);

    const receiver = await createOnlineScenario({
      seed,
      mode: "modern",
      rounds: 4,
      remotePlayerSlots: new Set<ValidPlayerSlot>([slot]),
    });

    let phaseTransitions = 0;
    host.bus.on(GAME_EVENT.PHASE_START, () => phaseTransitions++);

    let forwarded = 0;
    const MAX_STEPS = 120_000;
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

    const hostState = host.state;
    const receiverState = receiver.state;

    // Base guarantees (same as non-modern test, kept as smoke check).
    const hostSlot1 = hostState.players[slot]!;
    const receiverSlot1 = receiverState.players[slot]!;
    assertEquals(
      receiverSlot1.walls.size,
      hostSlot1.walls.size,
      `slot ${slot} wall count diverged`,
    );
    assertEquals(
      receiverSlot1.cannons.length,
      hostSlot1.cannons.length,
      `slot ${slot} cannon count diverged`,
    );

    // Modern-specific: modifier state.
    assert(hostState.modern, "host modern state must be present");
    assert(receiverState.modern, "receiver modern state must be present");
    assertEquals(
      receiverState.modern.activeModifier,
      hostState.modern.activeModifier,
      `activeModifier diverged: host=${hostState.modern.activeModifier}, receiver=${receiverState.modern.activeModifier}`,
    );
    assertEquals(
      receiverState.modern.lastModifierId,
      hostState.modern.lastModifierId,
      `lastModifierId diverged: host=${hostState.modern.lastModifierId}, receiver=${receiverState.modern.lastModifierId}`,
    );
    assertEquals(
      receiverState.modern.frozenTiles?.size ?? 0,
      hostState.modern.frozenTiles?.size ?? 0,
      "frozenTiles cardinality diverged",
    );

    // Modern-specific: per-player upgrade + damagedWalls state.
    for (let pid = 0; pid < hostState.players.length; pid++) {
      const hostPlayer = hostState.players[pid]!;
      const receiverPlayer = receiverState.players[pid]!;
      const hostUpgrades = [...hostPlayer.upgrades.entries()].sort();
      const receiverUpgrades = [...receiverPlayer.upgrades.entries()].sort();
      assertEquals(
        receiverUpgrades,
        hostUpgrades,
        `slot ${pid} upgrades diverged`,
      );
      assertEquals(
        receiverPlayer.damagedWalls.size,
        hostPlayer.damagedWalls.size,
        `slot ${pid} damagedWalls cardinality diverged`,
      );
    }

    assert(
      phaseTransitions >= 4,
      `expected at least 4 phase transitions; got ${phaseTransitions} — did the game actually run?`,
    );
  },
);
