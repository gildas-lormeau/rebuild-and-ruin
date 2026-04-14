/**
 * Debug test for the low_water modifier — asserts that every remaining water
 * tile belongs to at least one 2×2 water block after the modifier fires.
 * Covers multiple seeds to catch diagonal-bend edge cases.
 */

import { assert } from "@std/assert";
import { createScenario, waitForModifier } from "./scenario.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { ModifierId } from "../src/shared/core/game-constants.ts";
import { GRID_COLS, GRID_ROWS, type Tile } from "../src/shared/core/grid.ts";
import { DIRS_4, isWater } from "../src/shared/core/spatial.ts";

type TileGrid = readonly (readonly Tile[])[];

const LOW_WATER: ModifierId = "low_water";

Deno.test("low_water: every water tile in a 2x2 block after modifier", async () => {
  let testedCount = 0;
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    let sc: Awaited<ReturnType<typeof createScenario>> | undefined;
    try {
      sc = await createScenario({ seed, mode: "modern", rounds: 10, renderer: "ascii" });
      const ascii = sc.renderer!;

      let beforeSnapshot = "";
      sc.bus.on(GAME_EVENT.PHASE_START, () => {
        beforeSnapshot = ascii.snapshot("terrain");
      });

      try {
        waitForModifier(sc, LOW_WATER, { timeoutMs: 480_000 });
      } catch {
        continue;
      }

      testedCount++;
      const afterSnapshot = ascii.snapshot("terrain");
      const non2x2 = findNon2x2Water(sc.state.map.tiles);
      const isolated = findIsolatedWater(sc.state.map.tiles);

      if (non2x2.length > 0 || isolated.length > 0) {
        console.log(`\n=== SEED ${seed} — FAILURE ===`);
        console.log("\n--- BEFORE ---");
        console.log(beforeSnapshot);
        console.log("\n--- AFTER ---");
        console.log(afterSnapshot);
        if (isolated.length > 0) {
          console.log(`Isolated water: ${JSON.stringify(isolated)}`);
        }
        if (non2x2.length > 0) {
          console.log(`Not in 2x2: ${JSON.stringify(non2x2)}`);
        }
      }

      assert(
        isolated.length === 0,
        `Seed ${seed}: ${isolated.length} isolated water tile(s)`,
      );
      assert(
        non2x2.length === 0,
        `Seed ${seed}: ${non2x2.length} water tile(s) not in any 2x2 block`,
      );
    } finally {
      sc?.[Symbol.dispose]();
    }
  }
  assert(testedCount > 0, "No seed in [0..10] triggered low_water");
});

/** Find water tiles that don't belong to any 2×2 water block. */
function findNon2x2Water(tiles: TileGrid): { row: number; col: number }[] {
  const bad: { row: number; col: number }[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isWater(tiles, r, c)) continue;
      if (!inWater2x2(tiles, r, c)) bad.push({ row: r, col: c });
    }
  }
  return bad;
}

/** True when (r,c) belongs to at least one 2×2 all-water square. */
function inWater2x2(tiles: TileGrid, r: number, c: number): boolean {
  return (
    (isWater(tiles, r, c + 1) &&
      isWater(tiles, r + 1, c) &&
      isWater(tiles, r + 1, c + 1)) ||
    (isWater(tiles, r, c - 1) &&
      isWater(tiles, r + 1, c) &&
      isWater(tiles, r + 1, c - 1)) ||
    (isWater(tiles, r, c + 1) &&
      isWater(tiles, r - 1, c) &&
      isWater(tiles, r - 1, c + 1)) ||
    (isWater(tiles, r, c - 1) &&
      isWater(tiles, r - 1, c) &&
      isWater(tiles, r - 1, c - 1))
  );
}

/** Find water tiles with 0 cardinal water neighbors (completely isolated). */
function findIsolatedWater(tiles: TileGrid): { row: number; col: number }[] {
  const isolated: { row: number; col: number }[] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!isWater(tiles, r, c)) continue;
      let hasNeighbor = false;
      for (const [dr, dc] of DIRS_4) {
        if (isWater(tiles, r + dr, c + dc)) {
          hasNeighbor = true;
          break;
        }
      }
      if (!hasNeighbor) isolated.push({ row: r, col: c });
    }
  }
  return isolated;
}
