/**
 * E2E test: cannon phantom stability under mouse input.
 *
 * Verifies the phantom does not move while the mouse is inside its footprint,
 * and that the phantom center stays within half a tile of the mouse.
 *
 * Run: deno run -A test/e2e-cannon-cursor.ts
 * Requires: npm run dev (vite on port 5173)
 */

import { E2EGame } from "./e2e-helpers.ts";

const TILE_SIZE = 16;
const HALF_TILE = TILE_SIZE / 2;

/** Wait for the controller to report a cannon cursor. */
async function waitForCursor(game: E2EGame): Promise<{
  row: number;
  col: number;
} | null> {
  // Poll until controller has a cursor (max ~2s)
  for (let attempt = 0; attempt < 20; attempt++) {
    const ctrl = await game.query.controller();
    if (ctrl?.cannonCursor) return ctrl.cannonCursor;
    await game.page.waitForFunction(
      () =>
        (
          (globalThis as unknown as Record<string, unknown>).__e2e as {
            controller?: { cannonCursor?: unknown };
          }
        )?.controller?.cannonCursor != null,
      { timeout: 500 },
    ).catch(() => {});
  }
  return null;
}

async function run() {
  console.log("Starting cannon cursor e2e test...\n");

  const game = await E2EGame.create({
    seed: 42,
    humans: 1,
    headless: true,
  });

  try {
    // --- Advance to CANNON_PLACE ---
    console.log("Waiting for CANNON_PLACE...");
    await game.advanceTo("CANNON_PLACE");
    console.log("Reached CANNON_PLACE");

    // Disable fast mode for precise mouse interaction
    await game.setFastMode(false);

    // --- Test 1: phantom stability inside footprint ---
    console.log("\nTest 1: phantom stable inside footprint");

    // Move mouse to establish a phantom
    await game.mouse.moveToTile(10, 15);
    const cursor = await waitForCursor(game);

    if (!cursor) {
      console.log("  SKIP — no cannon cursor (player may be eliminated)");
    } else {
      const anchor = { ...cursor };
      console.log(
        `  Established phantom at (${anchor.row},${anchor.col})`,
      );
      const sz = 2;
      const szPx = sz * TILE_SIZE;
      const left = anchor.col * TILE_SIZE;
      const top = anchor.row * TILE_SIZE;
      let violations = 0;

      // Sweep every 2px inside the phantom footprint (1px margin for coord round-trip)
      for (let wy = top + 1; wy < top + szPx - 1; wy += 2) {
        for (let wx = left + 1; wx < left + szPx - 1; wx += 2) {
          await game.mouse.moveToWorld(wx, wy);
          const state = await game.query.controller();
          if (
            state?.cannonCursor &&
            (state.cannonCursor.row !== anchor.row ||
              state.cannonCursor.col !== anchor.col)
          ) {
            if (violations < 5) {
              console.log(
                `  FAIL: pixel (${wx},${wy}) moved to (${state.cannonCursor.row},${state.cannonCursor.col}) — expected (${anchor.row},${anchor.col})`,
              );
            }
            violations++;
            anchor.row = state.cannonCursor.row;
            anchor.col = state.cannonCursor.col;
          }
        }
      }

      if (violations === 0) {
        console.log(
          "  PASS — phantom stable for all pixels inside footprint",
        );
      } else {
        console.log(`  FAIL — ${violations} violations`);
      }
    }

    // --- Test 2: phantom moves on exit, offset within half tile ---
    console.log("\nTest 2: centering on exit");

    await game.mouse.moveToTile(12, 20);
    const cursor2 = await waitForCursor(game);

    if (!cursor2) {
      console.log("  SKIP — no cannon cursor");
    } else {
      const sz = 2;
      const anchor = { ...cursor2 };

      // Move past the right edge
      const rightEdge = (anchor.col + sz) * TILE_SIZE;
      await game.mouse.moveToWorld(
        rightEdge + 4,
        (anchor.row + 1) * TILE_SIZE,
      );

      const after = await game.query.controller();
      if (!after?.cannonCursor) {
        console.log("  SKIP — no cannon cursor after move");
      } else {
        const moved =
          after.cannonCursor.row !== anchor.row ||
          after.cannonCursor.col !== anchor.col;
        if (!moved) {
          console.log(
            "  FAIL — phantom did not move after exiting right edge",
          );
        } else {
          const cx = (after.cannonCursor.col + sz / 2) * TILE_SIZE;
          const cy = (after.cannonCursor.row + sz / 2) * TILE_SIZE;
          const mouseWx = rightEdge + 4;
          const mouseWy = (anchor.row + 1) * TILE_SIZE;
          const offsetX = Math.abs(mouseWx - cx);
          const offsetY = Math.abs(mouseWy - cy);
          if (offsetX <= HALF_TILE + 1 && offsetY <= HALF_TILE + 1) {
            console.log(
              `  PASS — moved and centered (offset=${offsetX.toFixed(1)},${offsetY.toFixed(1)})`,
            );
          } else {
            console.log(
              `  FAIL — offset too large (${offsetX.toFixed(1)},${offsetY.toFixed(1)})`,
            );
          }
        }
      }
    }

    // --- Test 3: horizontal sweep — no jumps > 1 tile ---
    console.log("\nTest 3: horizontal sweep — no jumps");

    const fixedY = 10 * TILE_SIZE + HALF_TILE;
    let prevCol = -1;
    let jumpCount = 0;

    for (let wx = 5 * TILE_SIZE; wx < 15 * TILE_SIZE; wx += 2) {
      await game.mouse.moveToWorld(wx, fixedY);
      const state = await game.query.controller();
      if (!state?.cannonCursor) continue;
      const col = state.cannonCursor.col;
      if (prevCol >= 0 && Math.abs(col - prevCol) > 1) {
        if (jumpCount < 3) {
          console.log(`  FAIL: wx=${wx} col jumped ${prevCol} → ${col}`);
        }
        jumpCount++;
      }
      prevCol = col;
    }

    if (jumpCount === 0) {
      console.log("  PASS — no jumps > 1 tile");
    } else {
      console.log(`  FAIL — ${jumpCount} jumps`);
    }

    console.log("\nDone.");
  } finally {
    await game.close();
  }
}

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
