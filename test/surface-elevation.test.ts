/**
 * Surface query — Phase 2 friendly-fire filter.
 *
 * Verifies that `surfaceAltitudeAt` correctly:
 *   1. Returns the top-Y of an entity at the queried tile.
 *   2. Skips the shooter's own walls during flight (shooterId set,
 *      tile != target) so balls arc cleanly over their own ramparts.
 *   3. STILL reports the shooter's own walls at the explicit target
 *      tile so the player can deliberately destroy their own pieces.
 *   4. Always reports enemy walls (no friendly-fire filter for them).
 *
 * Runs against a live scenario state — no state mutation, no scenario
 * progression beyond what `createScenario` does on its own.
 */

import { assert, assertEquals } from "@std/assert";
import { surfaceAltitudeAt } from "../src/game/surface-elevation.ts";
import { WALL_TOP_Y } from "../src/shared/core/elevation-constants.ts";
import { GRID_COLS, TILE_SIZE } from "../src/shared/core/grid.ts";
import type { ValidPlayerSlot } from "../src/shared/core/player-slot.ts";
import { createScenario } from "./scenario.ts";

Deno.test(
  "surface query: returns wall top at a tile owned by anyone",
  async () => {
    const sc = await createScenario({ seed: 42 });
    sc.runUntil(
      () =>
        sc.state.players.some((p) => p.walls.size > 0) ||
        sc.state.phase !== "WALL_BUILD",
      { timeoutMs: 30_000 },
    );
    const player = sc.state.players.find((p) => p.walls.size > 0);
    if (!player) return; // Test scenario didn't produce walls — skip.
    const wall = pickWallTile(player.walls);
    if (!wall) return;
    const { x, y } = tileCenterPx(wall.col, wall.row);
    assertEquals(surfaceAltitudeAt(sc.state, x, y), WALL_TOP_Y);
  },
);

Deno.test(
  "surface query: shooter's own wall is transparent in flight",
  async () => {
    const sc = await createScenario({ seed: 42 });
    sc.runUntil(
      () =>
        sc.state.players.some((p) => p.walls.size > 0) ||
        sc.state.phase !== "WALL_BUILD",
      { timeoutMs: 30_000 },
    );
    const player = sc.state.players.find((p) => p.walls.size > 0);
    if (!player) return;
    const wall = pickWallTile(player.walls);
    if (!wall) return;
    const { x, y } = tileCenterPx(wall.col, wall.row);
    // No target → flight-mode filter applies → own wall is transparent.
    const altWithFilter = surfaceAltitudeAt(sc.state, x, y, {
      shooterId: player.id as ValidPlayerSlot,
    });
    assertEquals(altWithFilter, 0);
  },
);

Deno.test(
  "surface query: shooter's own wall is opaque AT the target tile",
  async () => {
    const sc = await createScenario({ seed: 42 });
    sc.runUntil(
      () =>
        sc.state.players.some((p) => p.walls.size > 0) ||
        sc.state.phase !== "WALL_BUILD",
      { timeoutMs: 30_000 },
    );
    const player = sc.state.players.find((p) => p.walls.size > 0);
    if (!player) return;
    const wall = pickWallTile(player.walls);
    if (!wall) return;
    const { x, y } = tileCenterPx(wall.col, wall.row);
    // Target is the same tile as the wall — the carve-out disables the
    // filter so the player can deliberately destroy their own wall.
    const altAtTarget = surfaceAltitudeAt(sc.state, x, y, {
      shooterId: player.id as ValidPlayerSlot,
      target: { row: wall.row, col: wall.col },
    });
    assertEquals(altAtTarget, WALL_TOP_Y);
  },
);

Deno.test(
  "surface query: enemy wall is always opaque",
  async () => {
    const sc = await createScenario({ seed: 42 });
    sc.runUntil(
      () => sc.state.players.filter((p) => p.walls.size > 0).length >= 2,
      { timeoutMs: 30_000 },
    );
    const owner = sc.state.players.find((p) => p.walls.size > 0);
    const others = sc.state.players.filter(
      (p) => p.walls.size > 0 && p.id !== owner?.id,
    );
    if (!owner || others.length === 0) return;
    const wall = pickWallTile(owner.walls);
    if (!wall) return;
    const { x, y } = tileCenterPx(wall.col, wall.row);
    // A different player's shooter id → owner's wall is enemy → opaque
    // even with no target carve-out.
    const enemyShooter = others[0]!.id as ValidPlayerSlot;
    const alt = surfaceAltitudeAt(sc.state, x, y, { shooterId: enemyShooter });
    assert(alt === WALL_TOP_Y, `expected wall top, got ${alt}`);
  },
);

function tileCenterPx(col: number, row: number): { x: number; y: number } {
  return { x: (col + 0.5) * TILE_SIZE, y: (row + 0.5) * TILE_SIZE };
}

function pickWallTile(
  walls: ReadonlySet<number>,
): { col: number; row: number } | undefined {
  const first = walls.values().next();
  if (first.done) return undefined;
  const key = first.value;
  return { col: key % GRID_COLS, row: Math.floor(key / GRID_COLS) };
}
