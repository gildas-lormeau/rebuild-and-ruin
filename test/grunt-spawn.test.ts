/**
 * Grunt spawn verification — subscribes to gruntSpawn bus events and checks
 * every spawn position is on the bank (adjacent to water) or map edge.
 *
 * Run with: deno test --no-check test/grunt-spawn.test.ts
 */

import { assert } from "@std/assert";
import { GRID_COLS, GRID_ROWS } from "../src/shared/grid.ts";
import { isWater } from "../src/shared/spatial.ts";
import { GAME_MODE_MODERN } from "../src/shared/game-constants.ts";
import { GAME_EVENT } from "../src/shared/game-event-bus.ts";
import { setGameMode } from "../src/shared/types.ts";
import { createScenario } from "./scenario-helpers.ts";

function isBank(tiles: readonly (readonly number[])[], row: number, col: number): boolean {
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const nr = row + dr, nc = col + dc;
    if (nr >= 0 && nr < GRID_ROWS && nc >= 0 && nc < GRID_COLS && isWater(tiles, nr, nc)) return true;
  }
  return false;
}

function isEdge(row: number, col: number): boolean {
  return row <= 0 || col <= 0 || row >= GRID_ROWS - 1 || col >= GRID_COLS - 1;
}

async function run(seed: number, modern: boolean): Promise<void> {
  const sc = await createScenario(seed);
  if (modern) setGameMode(sc.state, GAME_MODE_MODERN);

  const bad: string[] = [];

  sc.bus.on(GAME_EVENT.GRUNT_SPAWN, (event) => {
    const { row, col } = event;
    if (!isBank(sc.state.map.tiles, row, col) && !isEdge(row, col)) {
      bad.push(`round ${sc.state.round} (${row},${col}) victim=P${event.victimPlayerId}`);
    }
  });

  sc.runGame();

  assert(bad.length === 0, `Seed ${seed}: ${bad.length} inland grunts:\n  ${bad.join("\n  ")}`);
}

const seeds = [42, 99, 77, 256, 1337, 7, 2024, 555];
for (const seed of seeds) {
  Deno.test(`classic ${seed}`, () => run(seed, false));
  Deno.test(`modern ${seed}`, () => run(seed, true));
}
