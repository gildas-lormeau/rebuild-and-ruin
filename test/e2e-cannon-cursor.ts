/**
 * E2E test: cannon phantom stability under mouse input.
 *
 * Verifies the phantom does not move while the mouse is inside its footprint,
 * and that the phantom center stays within half a tile of the mouse.
 *
 * Run: deno run -A test/e2e-cannon-cursor.ts
 * Requires: npm run dev (vite on port 5173)
 */

import { E2EGame, E2ETest } from "./e2e-helpers.ts";

const TILE_SIZE = 16;
const HALF_TILE = TILE_SIZE / 2;

/** Poll until the controller reports a cannon cursor (max ~2s). */
async function waitForCursor(
  game: E2EGame,
): Promise<{ row: number; col: number } | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const ctrl = await game.query.controller();
    if (ctrl?.cannonCursor) return ctrl.cannonCursor;
    await game.page.waitForTimeout(100);
  }
  return null;
}

async function run() {
  const test = new E2ETest("cannon cursor e2e");

  const game = await E2EGame.create({
    seed: 42,
    humans: 1,
    headless: true,
  });

  try {
    console.log("Waiting for CANNON_PLACE...");
    await game.advanceTo("CANNON_PLACE");
    console.log("Reached CANNON_PLACE");
    await game.setFastMode(false);

    // --- Test 1: phantom stability inside footprint ---
    console.log("\nTest 1: phantom stable inside footprint");

    await game.mouse.moveToTile(10, 15);
    const cursor = await waitForCursor(game);

    if (!cursor) {
      console.log("  SKIP — no cannon cursor (player may be eliminated)");
    } else {
      const anchor = { ...cursor };
      console.log(`  Established phantom at (${anchor.row},${anchor.col})`);
      const sz = 2;
      const szPx = sz * TILE_SIZE;
      const left = anchor.col * TILE_SIZE;
      const top = anchor.row * TILE_SIZE;
      let violations = 0;

      for (let wy = top + 1; wy < top + szPx - 1; wy += 2) {
        for (let wx = left + 1; wx < left + szPx - 1; wx += 2) {
          await game.mouse.moveToWorld(wx, wy);
          const ctrl = await game.query.controller();
          if (
            ctrl?.cannonCursor &&
            (ctrl.cannonCursor.row !== anchor.row ||
              ctrl.cannonCursor.col !== anchor.col)
          ) {
            if (violations < 5) {
              console.log(
                `  pixel (${wx},${wy}) moved to (${ctrl.cannonCursor.row},${ctrl.cannonCursor.col}) — expected (${anchor.row},${anchor.col})`,
              );
            }
            violations++;
            anchor.row = ctrl.cannonCursor.row;
            anchor.col = ctrl.cannonCursor.col;
          }
        }
      }

      test.check(
        "phantom stable for all pixels inside footprint",
        violations === 0,
        violations > 0 ? `${violations} violations` : undefined,
      );
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
      const rightEdge = (anchor.col + sz) * TILE_SIZE;
      await game.mouse.moveToWorld(rightEdge + 4, (anchor.row + 1) * TILE_SIZE);

      const after = await game.query.controller();
      if (!after?.cannonCursor) {
        console.log("  SKIP — no cannon cursor after move");
      } else {
        const moved =
          after.cannonCursor.row !== anchor.row ||
          after.cannonCursor.col !== anchor.col;
        if (!moved) {
          test.check("phantom moves after exiting right edge", false);
        } else {
          const cx = (after.cannonCursor.col + sz / 2) * TILE_SIZE;
          const cy = (after.cannonCursor.row + sz / 2) * TILE_SIZE;
          const offsetX = Math.abs(rightEdge + 4 - cx);
          const offsetY = Math.abs((anchor.row + 1) * TILE_SIZE - cy);
          test.check(
            "phantom centered after move",
            offsetX <= HALF_TILE + 1 && offsetY <= HALF_TILE + 1,
            `offset=(${offsetX.toFixed(1)},${offsetY.toFixed(1)})`,
          );
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
      const ctrl = await game.query.controller();
      if (!ctrl?.cannonCursor) continue;
      const col = ctrl.cannonCursor.col;
      if (prevCol >= 0 && Math.abs(col - prevCol) > 1) {
        if (jumpCount < 3) {
          console.log(`  wx=${wx} col jumped ${prevCol} → ${col}`);
        }
        jumpCount++;
      }
      prevCol = col;
    }

    test.check(
      "no jumps > 1 tile during horizontal sweep",
      jumpCount === 0,
      jumpCount > 0 ? `${jumpCount} jumps` : undefined,
    );
  } finally {
    await game.close();
  }

  test.done();
}

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
