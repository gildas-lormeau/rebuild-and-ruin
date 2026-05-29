/**
 * Supply-ship modifier: spawn / reveal / tick / clear lifecycle.
 *
 * Plays the registered `modifier:supply_ship` seed in modern mode and
 * verifies the end-to-end shape of the modifier:
 *   1. MODIFIER_APPLIED fires with modifierId="supply_ship".
 *   2. Three ships spawn into state.modern.supplyShips at battle start.
 *   3. Ships are visible in the overlay during MODIFIER_REVEAL (so the
 *      banner snapshot sees them in-place — this was a real bug before
 *      the projection's phase gate was dropped).
 *   4. Ships clear back to null at battle end.
 *
 * A second assertion gate: if any ship is sunk during battle, the
 * pendingSupplyBonuses queue picks up an entry for the shooter — this
 * exercises the hit-credits-bonus pipeline that the AI now exercises
 * occasionally via the 1/8 ship-target probability in pickTarget.
 *
 * Run with: deno test --no-check test/supply-ship.test.ts
 */

import { assert, assertEquals } from "@std/assert";
import { Phase } from "../src/shared/core/game-phase.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ValidPlayerId } from "../src/shared/core/player-slot.ts";
import { loadSeed } from "./scenario.ts";

const MAX_TIMEOUT_MS = 1_200_000;
const EXPECTED_SHIP_COUNT = 3;

Deno.test("supply_ship: 3 ships spawn at battle start", async () => {
  using sc = await loadSeed("modifier:supply_ship");

  let supplyShipApplied = false;
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "supply_ship") supplyShipApplied = true;
  });

  // Run until the modifier fires + ships are spawned. apply() runs in
  // prepareBattleState (cannon-place-done), BEFORE the phase flips to
  // MODIFIER_REVEAL — so by the time we see MODIFIER_APPLIED, ships
  // exist in state.modern.supplyShips.
  sc.runUntil(
    () => supplyShipApplied && (sc.state.modern?.supplyShips?.length ?? 0) > 0,
    { timeoutMs: MAX_TIMEOUT_MS },
  );

  assert(supplyShipApplied, "supply_ship modifier never fired within budget");
  assertEquals(
    sc.state.modern?.supplyShips?.length,
    EXPECTED_SHIP_COUNT,
    "supply_ship apply() should spawn exactly 3 ships (one per Y-river arm)",
  );

  // Each ship should be alive (hp > 0, not sinking) and on a distinct arm.
  const ships = sc.state.modern!.supplyShips!;
  const armsSeen = new Set<number>();
  for (const ship of ships) {
    assert(ship.hp > 0, `ship ${ship.id} should spawn with hp > 0`);
    assertEquals(
      ship.sinking,
      undefined,
      `ship ${ship.id} should spawn not-sinking`,
    );
    armsSeen.add(ship.spawnArm);
  }
  assertEquals(armsSeen.size, EXPECTED_SHIP_COUNT, "ships should span all 3 arms");
});

Deno.test("supply_ship: ships visible in overlay during MODIFIER_REVEAL", async () => {
  using sc = await loadSeed("modifier:supply_ship");

  let supplyShipApplied = false;
  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "supply_ship") supplyShipApplied = true;
  });

  // Run until the overlay itself carries the ships during MODIFIER_REVEAL.
  // The overlay refresh runs AFTER the tick that fires PHASE_START, so we
  // wait on the projected state directly rather than on state.phase + an
  // extra belt-and-braces tick.
  sc.runUntil(
    () =>
      supplyShipApplied &&
      sc.state.phase === Phase.MODIFIER_REVEAL &&
      (sc.overlay()?.battle?.supplyShips?.length ?? 0) > 0,
    { timeoutMs: MAX_TIMEOUT_MS },
  );

  const ships = sc.overlay()?.battle?.supplyShips;
  assertEquals(
    ships?.length,
    EXPECTED_SHIP_COUNT,
    "all 3 ships should be in the overlay during MODIFIER_REVEAL so the banner snapshot captures them",
  );
});

Deno.test("supply_ship: ships clear at battle end and credit any sinks", async () => {
  using sc = await loadSeed("modifier:supply_ship");

  let supplyShipApplied = false;
  let battleEntered = false;
  const shipsSunkByShooter = new Map<ValidPlayerId, number>();

  sc.bus.on(GAME_EVENT.MODIFIER_APPLIED, (ev) => {
    if (ev.modifierId === "supply_ship") supplyShipApplied = true;
  });
  sc.bus.on(GAME_EVENT.PHASE_START, (ev) => {
    if (supplyShipApplied && ev.phase === Phase.BATTLE) battleEntered = true;
  });
  sc.bus.on(GAME_EVENT.SHIP_SUNK, (ev) => {
    shipsSunkByShooter.set(
      ev.shooterId,
      (shipsSunkByShooter.get(ev.shooterId) ?? 0) + 1,
    );
  });

  // Run past the battle until ships are cleared (clear() runs at battle
  // end via the modifier's clear hook).
  sc.runUntil(
    () => battleEntered && sc.state.modern?.supplyShips === null,
    { timeoutMs: MAX_TIMEOUT_MS },
  );

  assert(battleEntered, "BATTLE phase never entered after supply_ship apply");
  assertEquals(
    sc.state.modern?.supplyShips,
    null,
    "supplyShips should be null after battle end (modifier clear hook)",
  );

  // Cross-check: every SHIP_SUNK should leave a queued bonus for its
  // shooter. The queue persists across the modifier's clear (it's
  // intentionally not drained in clear() — bonuses span round boundaries).
  for (const [shooterId, sunkCount] of shipsSunkByShooter) {
    const queue = sc.state.modern?.pendingSupplyBonuses?.get(shooterId);
    assert(
      queue && queue.length >= 1,
      `shooter ${shooterId} sunk ${sunkCount} ship(s) but has no queued bonus`,
    );
  }
});
