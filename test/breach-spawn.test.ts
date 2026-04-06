/**
 * Breach-based staggered grunt spawning — grunts file through wall gaps
 * one-by-one during build phase instead of appearing all at once.
 */

import { assert } from "@std/assert";
import { tickGrunts } from "../src/game/grunt-movement.ts";
import {
  queueInterbattleGrunts,
  tickBreachSpawnQueue,
} from "../src/game/grunt-system.ts";
import { GRID_COLS } from "../src/shared/grid.ts";
import { Rng } from "../src/shared/rng.ts";
import { packTile } from "../src/shared/spatial.ts";
import type { ValidPlayerSlot } from "../src/shared/player-slot.ts";
import type { GameState } from "../src/shared/types.ts";
import { parseBoard } from "./test-helpers.ts";

/** Render the board region as ASCII for visual inspection.
 *  #=wall  T=tower  G=grunt  ~=water  .=grass */
function renderBoard(
  state: GameState,
  offsetR: number,
  offsetC: number,
  rows: number,
  cols: number,
): string {
  const player = state.players[0]!;
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let col = 0; col < cols; col++) {
      const gr = offsetR + row;
      const gc = offsetC + col;
      const key = gr * GRID_COLS + gc;
      const tile = state.map.tiles[gr]?.[gc];

      if (state.grunts.some((grunt) => grunt.row === gr && grunt.col === gc)) {
        line += "G";
      } else if (
        state.map.towers.some(
          (tw) =>
            gr >= tw.row && gr < tw.row + 2 && gc >= tw.col && gc < tw.col + 2,
        )
      ) {
        line += "T";
      } else if (player.walls.has(key)) {
        line += "#";
      } else if (tile === 1) {
        line += "~";
      } else {
        line += ".";
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

Deno.test("breach spawn: grunts file through wall gap in single-file", () => {
  // Wall enclosure with a 1-tile gap on the right side of row 4.
  // Grunts spawn OUTSIDE the gap (col 8) and walk through it toward the tower.
  const { state, offsetR, offsetC } = parseBoard(`
########
#      #
# TT   #
# TT   #
#
########`);

  // Render area: 6 rows x 10 cols (walls + 2 cols of outside space)
  const rows = 6;
  const cols = 10;

  // Queue 4 grunts at the outside of the breach (col 8, one past the gap)
  const spawnRow = offsetR + 4;
  const spawnCol = offsetC + 8;
  for (let idx = 0; idx < 4; idx++) {
    state.gruntSpawnQueue.push({
      row: spawnRow,
      col: spawnCol,
      victimPlayerId: 0 as ValidPlayerSlot,
    });
  }

  const frames: string[] = [];
  frames.push(renderBoard(state, offsetR, offsetC, rows, cols));

  for (let tick = 1; tick <= 8; tick++) {
    tickBreachSpawnQueue(state);
    tickGrunts(state);
    frames.push(renderBoard(state, offsetR, offsetC, rows, cols));
  }

  // Print all frames for visual inspection
  for (let idx = 0; idx < frames.length; idx++) {
    console.log(`\n=== Tick ${idx}: ${idx === 0 ? "4 queued, 0 on map" : `${state.grunts.length} on map`} ===`);
    console.log(frames[idx]);
  }

  // Tick 0: empty board
  assert(
    frames[0] ===
`########..
#......#..
#.TT...#..
#.TT...#..
#.........
########..`,
    "tick 0: board should be empty",
  );

  // Tick 1: first grunt appears outside the gap
  assert(
    frames[1]!.includes("G"),
    "tick 1: first grunt should appear on the map",
  );

  // After all ticks: queue drained, 4 grunts on map at distinct positions
  const finalQueue = state.gruntSpawnQueue.length;
  const finalGrunts = state.grunts.length;
  assert(finalQueue === 0, `queue should be fully drained, got ${finalQueue}`);
  assert(finalGrunts === 4, `expected 4 grunts, got ${finalGrunts}`);

  const positions = state.grunts.map((grunt) => `${grunt.row},${grunt.col}`);
  const unique = new Set(positions);
  assert(
    unique.size === positions.length,
    `grunts should be at different tiles (single-file), got: ${positions.join(" | ")}`,
  );
});

Deno.test("breach spawn: wall next to water detects gap", () => {
  // Water on the left, wall with a gap between two wall segments.
  // Gap at row 3 col 5: wall left (#), wall right (#), so horizontally flanked.
  //   ~#####.
  //   ~#...#.
  //   ~#TT.#.
  //   ~#TT. #   <-- gap at col 5 between the two # segments
  //   ~#...#.
  //   ~#####.
  const { state } = parseBoard(`
~#####
~#   #
~#TT #
~#TT  #
~#   #
~#####`);

  state.rng = new Rng(7);
  state.round = 3;

  queueInterbattleGrunts(state);

  // Should detect the gap and queue grunts outside the wall line
  assert(
    state.gruntSpawnQueue.length > 0,
    "wall gap next to water should produce queued grunts",
  );
});

Deno.test("breach spawn: no walls falls back to instant spawn", () => {
  const { state } = parseBoard(`
  TT
  TT`);

  (state.players[0]!.walls as Set<number>).clear();
  state.rng = new Rng(99);
  state.round = 3;

  queueInterbattleGrunts(state);

  assert(state.gruntSpawnQueue.length === 0, "no walls = no breach queue");
});

Deno.test("breach spawn: sealed breach drops queued grunt", () => {
  const { state, offsetR, offsetC } = parseBoard(`
########
#      #
# TT   #
# TT   #
#
########`);

  // Queue at the outside spawn position (col 8)
  const spawnRow = offsetR + 4;
  const spawnCol = offsetC + 8;
  state.gruntSpawnQueue.push({
    row: spawnRow,
    col: spawnCol,
    victimPlayerId: 0 as ValidPlayerSlot,
  });

  // Seal the breach by walling the outside spawn tile
  (state.players[0]!.walls as Set<number>).add(packTile(spawnRow, spawnCol));

  const gruntsBefore = state.grunts.length;
  tickBreachSpawnQueue(state);
  assert(state.grunts.length === gruntsBefore, "sealed breach should not spawn grunt");
  assert(state.gruntSpawnQueue.length === 0, "sealed entry should be removed");
});
