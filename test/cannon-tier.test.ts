/**
 * Cannon tier ball-speed scaling.
 *
 * Pure-function test: `cannonTier(player)` derives tier from lives, and
 * `ballSpeedMult(player, isMortar)` composes that with Rapid Fire and
 * Mortar. Constructs minimal Player-shaped literals — no scenario, no
 * state mutation, no bus observation needed. The load-bearing invariants:
 *
 *   • tier = 1 at full lives, 2 after one loss, 3 on the last life
 *   • tier 2 = 1.2×, tier 3 = 1.44× (each tier is +20% over the previous)
 *   • tier multiplier composes on top of Rapid Fire and Mortar
 *   • Rapid Fire × Mortar still cancels to 1.0 BEFORE tier is applied
 */

import { assertEquals } from "@std/assert";
import { ballSpeedMult } from "../src/game/upgrade-system.ts";
import { STARTING_LIVES } from "../src/shared/core/game-constants.ts";
import { cannonTier, type Player } from "../src/shared/core/player-types.ts";
import { UID } from "../src/shared/core/upgrade-defs.ts";

Deno.test("cannonTier: full lives → tier 1", () => {
  assertEquals(cannonTier({ lives: STARTING_LIVES }), 1);
});

Deno.test("cannonTier: one life lost → tier 2", () => {
  assertEquals(cannonTier({ lives: STARTING_LIVES - 1 }), 2);
});

Deno.test("cannonTier: two lives lost → tier 3", () => {
  assertEquals(cannonTier({ lives: STARTING_LIVES - 2 }), 3);
});

Deno.test("cannonTier: clamps to 3 below the normal floor", () => {
  assertEquals(cannonTier({ lives: 0 }), 3);
});

Deno.test("ballSpeedMult: tier 1 baseline = 1.0", () => {
  assertEquals(ballSpeedMult(mockPlayer(STARTING_LIVES), false), 1);
});

Deno.test("ballSpeedMult: tier 2 = 1.2×", () => {
  assertEquals(ballSpeedMult(mockPlayer(STARTING_LIVES - 1), false), 1.2);
});

Deno.test("ballSpeedMult: tier 3 ≈ 1.44×", () => {
  const result = ballSpeedMult(mockPlayer(STARTING_LIVES - 2), false);
  // 1.2 * 1.2 with binary float — assert near-equality.
  assertEquals(Math.round(result * 1000) / 1000, 1.44);
});

Deno.test("ballSpeedMult: Rapid Fire × tier 2 = 1.5 × 1.2 = 1.8", () => {
  const result = ballSpeedMult(mockPlayer(STARTING_LIVES - 1, true), false);
  assertEquals(Math.round(result * 1000) / 1000, 1.8);
});

Deno.test("ballSpeedMult: Rapid Fire × Mortar cancels BEFORE tier scales", () => {
  // Rapid Fire + Mortar => base = 1.0, then tier 3 multiplies to 1.44.
  const result = ballSpeedMult(mockPlayer(STARTING_LIVES - 2, true), true);
  assertEquals(Math.round(result * 1000) / 1000, 1.44);
});

function mockPlayer(lives: number, withRapidFire = false): Player {
  const upgrades = new Map<string, number>();
  if (withRapidFire) upgrades.set(UID.RAPID_FIRE, 1);
  return { lives, upgrades } as unknown as Player;
}
