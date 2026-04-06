/**
 * Cannon cursor stability test — verifies the phantom does NOT move
 * while the mouse is inside its footprint, and only moves when the
 * mouse exits.
 */

import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../src/shared/grid.ts";
import { CannonMode } from "../src/shared/battle-types.ts";
import { cannonSize } from "../src/shared/spatial.ts";
import { HumanController } from "../src/player/controller-human.ts";
import type { ValidPlayerSlot } from "../src/shared/player-slot.ts";
import { assert } from "@std/assert";

function createHuman(playerId: ValidPlayerSlot): HumanController {
  return new HumanController(playerId, {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    confirm: "n",
    rotate: "b",
  });
}

// ---------------------------------------------------------------------------
// Core invariant: phantom must not move while mouse is inside its footprint
// ---------------------------------------------------------------------------

Deno.test("2x2: phantom stable for every pixel inside its footprint", () => {
  const human = createHuman(0 as ValidPlayerSlot);
  const sz = cannonSize(CannonMode.NORMAL); // 2
  const szPx = sz * TILE_SIZE; // 32

  // Establish phantom at a known position by calling from outside
  const startX = 10 * TILE_SIZE + TILE_SIZE / 2; // center of tile 10
  const startY = 10 * TILE_SIZE + TILE_SIZE / 2;
  human.setCannonCursor(startX, startY);
  const anchorRow = human.cannonCursor.row;
  const anchorCol = human.cannonCursor.col;

  // Now sweep every pixel inside the phantom bbox
  const left = anchorCol * TILE_SIZE;
  const top = anchorRow * TILE_SIZE;
  const violations: string[] = [];

  for (let wy = top; wy < top + szPx; wy++) {
    for (let wx = left; wx < left + szPx; wx++) {
      human.setCannonCursor(wx, wy);
      if (human.cannonCursor.row !== anchorRow || human.cannonCursor.col !== anchorCol) {
        violations.push(`pixel (${wx},${wy}): moved to (${human.cannonCursor.row},${human.cannonCursor.col})`);
        // Reset for next iteration
        human.cannonCursor.row = anchorRow;
        human.cannonCursor.col = anchorCol;
        if (violations.length > 5) break;
      }
    }
    if (violations.length > 5) break;
  }

  assert(violations.length === 0, `Phantom moved while mouse inside:\n${violations.join("\n")}`);
});

Deno.test("2x2: phantom moves when mouse exits right edge", () => {
  const human = createHuman(0 as ValidPlayerSlot);
  const sz = cannonSize(CannonMode.NORMAL);

  // Establish phantom
  human.setCannonCursor(10 * TILE_SIZE + 8, 10 * TILE_SIZE + 8);
  const anchorCol = human.cannonCursor.col;
  const right = (anchorCol + sz) * TILE_SIZE;

  // Move to right edge — should still be inside
  human.setCannonCursor(right - 1, 10 * TILE_SIZE + 8);
  assert(human.cannonCursor.col === anchorCol, "should stay at edge");

  // Move past right edge — should move
  human.setCannonCursor(right, 10 * TILE_SIZE + 8);
  assert(human.cannonCursor.col !== anchorCol, "should move after exiting right");
});

Deno.test("2x2: phantom moves when mouse exits bottom edge", () => {
  const human = createHuman(0 as ValidPlayerSlot);
  const sz = cannonSize(CannonMode.NORMAL);

  human.setCannonCursor(10 * TILE_SIZE + 8, 10 * TILE_SIZE + 8);
  const anchorRow = human.cannonCursor.row;
  const bottom = (anchorRow + sz) * TILE_SIZE;

  human.setCannonCursor(10 * TILE_SIZE + 8, bottom - 1);
  assert(human.cannonCursor.row === anchorRow, "should stay at bottom edge");

  human.setCannonCursor(10 * TILE_SIZE + 8, bottom);
  assert(human.cannonCursor.row !== anchorRow, "should move after exiting bottom");
});

Deno.test("2x2: horizontal sweep — no jumps > 1 tile", () => {
  const human = createHuman(0 as ValidPlayerSlot);
  const fixedY = 10 * TILE_SIZE + 8;
  let prevCol = -1;
  const jumps: string[] = [];

  for (let wx = 0; wx < GRID_COLS * TILE_SIZE; wx++) {
    human.setCannonCursor(wx, fixedY);
    const col = human.cannonCursor.col;
    if (prevCol >= 0 && Math.abs(col - prevCol) > 1) {
      jumps.push(`wx=${wx}: col jumped ${prevCol}→${col}`);
      if (jumps.length > 5) break;
    }
    prevCol = col;
  }

  assert(jumps.length === 0, `Jumps > 1 tile:\n${jumps.join("\n")}`);
});

Deno.test("2x2: vertical sweep — no jumps > 1 tile", () => {
  const human = createHuman(0 as ValidPlayerSlot);
  const fixedX = 20 * TILE_SIZE + 8;
  let prevRow = -1;
  const jumps: string[] = [];

  for (let wy = 0; wy < GRID_ROWS * TILE_SIZE; wy++) {
    human.setCannonCursor(fixedX, wy);
    const row = human.cannonCursor.row;
    if (prevRow >= 0 && Math.abs(row - prevRow) > 1) {
      jumps.push(`wy=${wy}: row jumped ${prevRow}→${row}`);
      if (jumps.length > 5) break;
    }
    prevRow = row;
  }

  assert(jumps.length === 0, `Jumps > 1 tile:\n${jumps.join("\n")}`);
});

Deno.test("3x3: phantom stable for every pixel inside its footprint", () => {
  const human = createHuman(0 as ValidPlayerSlot);
  (human as unknown as { cannonPlaceMode: CannonMode }).cannonPlaceMode = CannonMode.SUPER;
  const sz = cannonSize(CannonMode.SUPER); // 3
  const szPx = sz * TILE_SIZE; // 48

  human.setCannonCursor(10 * TILE_SIZE + 8, 10 * TILE_SIZE + 8);
  const anchorRow = human.cannonCursor.row;
  const anchorCol = human.cannonCursor.col;
  const left = anchorCol * TILE_SIZE;
  const top = anchorRow * TILE_SIZE;
  const violations: string[] = [];

  for (let wy = top; wy < top + szPx; wy++) {
    for (let wx = left; wx < left + szPx; wx++) {
      human.setCannonCursor(wx, wy);
      if (human.cannonCursor.row !== anchorRow || human.cannonCursor.col !== anchorCol) {
        violations.push(`pixel (${wx},${wy}): moved to (${human.cannonCursor.row},${human.cannonCursor.col})`);
        human.cannonCursor.row = anchorRow;
        human.cannonCursor.col = anchorCol;
        if (violations.length > 5) break;
      }
    }
    if (violations.length > 5) break;
  }

  assert(violations.length === 0, `3x3 phantom moved while mouse inside:\n${violations.join("\n")}`);
});
