/**
 * E2E regression: keyboard aim under the battle tilt.
 *
 * The 30° battle camera draws a wall's top surface ~1 tile NORTH of its
 * ground footprint. The MOUSE aim path occludes for this (screen tap →
 * ray-walk to the wall), but the KEYBOARD path moved the crosshair in raw
 * world space and fired `pxToTile(crosshair.y)` directly — so aiming the
 * *visual* top of a wall put the crosshair a full tile north (the grass row)
 * and the ball missed to the north. This reproduces that exact case (seed
 * 865451: Red fires across into Gold's north wall at row 2) and asserts the
 * ball lands ON the wall.
 *
 * Requires: npm run dev (vite on 5173). Runs non-fast (real-time) so the
 * closed-loop crosshair driving stays precise — fast-mode jumps the sim too
 * far between cross-boundary reads to hit a tile reliably.
 *
 * Run: deno test --no-check -A test/e2e/keyboard-aim-wall-occlusion.ts
 */

import { assert, assertEquals } from "@std/assert";
import { createE2EScenario, type E2EScenario, GAME_EVENT } from "./scenario.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import { TILE_SIZE } from "../../src/shared/core/grid.ts";

// Seed 865451 home towers (verified via generateMap): Red (19,10),
// Blue (3,39), Gold (5,20). Gold's auto-built castle puts its north wall at
// row 2, cols 15-22 — a horizontal wall 2 tiles from the top edge, the
// original bug report's exact geometry.
const SEED = 865451;
const GOLD_NORTH_WALL_ROW = 2;
const GOLD_WALL_AIM_COL = 18;
// The wall renders lifted ~14.9px north under the tilt, so the CENTER of its
// top surface — what a player visually aims at — sits at the ground-tile
// center minus that lift. That world-Y is in the GRASS row (row 1): the whole
// point of the bug.
const WALL_LIFT_PX = 14.87;

Deno.test(
  "e2e: keyboard aim at a wall's tilted top hits the wall, not the grass north of it",
  async () => {
    await using sc = await createE2EScenario({
      seed: SEED,
      mode: "classic",
      humans: 3,
      rounds: 1,
      headless: true,
      fastMode: false,
    });

    await confirmCenterCastles(sc);
    await reachTiltedBattle(sc);

    // Aim Red's crosshair at the visual center of Gold's north-wall top.
    const aimX = GOLD_WALL_AIM_COL * TILE_SIZE + TILE_SIZE / 2; // col 18 center
    const aimY =
      GOLD_NORTH_WALL_ROW * TILE_SIZE + TILE_SIZE / 2 - WALL_LIFT_PX; // ~25
    await moveCrosshair(sc, "x", aimX, 3, "ArrowRight", "ArrowLeft");
    await moveCrosshair(sc, "y", aimY, 3, "ArrowDown", "ArrowUp");

    const ch = await readCrosshair(sc);
    assert(ch, "expected Red's crosshair");
    // Sanity: the crosshair's raw world-Y is in the grass row NORTH of the
    // wall — this is what "visually on the wall" means under the tilt.
    assertEquals(
      Math.floor(ch.y / TILE_SIZE),
      GOLD_NORTH_WALL_ROW - 1,
      "crosshair should sit on the grass row north of the wall (visual top)",
    );

    const fired = await fireAndCapture(sc);
    assert(fired, "expected Red to fire a cannonball");

    // The fix: firing occludes the raw crosshair onto the wall drawn over it.
    assertEquals(
      fired.impactRow,
      GOLD_NORTH_WALL_ROW,
      `ball must land on the wall (row ${GOLD_NORTH_WALL_ROW}), not the grass ` +
        `north of it (got row ${fired.impactRow})`,
    );
    assertEquals(fired.impactCol, GOLD_WALL_AIM_COL, "impact column");
    assert(
      fired.impactAltitude > 0,
      `ball must land on the elevated wall top, not flat grass ` +
        `(altitude ${fired.impactAltitude})`,
    );
  },
);

/** Confirm each of the 3 humans' center (home) castle towers. The default
 *  highlight is the home tower, so a bare confirm key locks it in; retry
 *  across the "Select your castle" announcement gate until the phase leaves
 *  CASTLE_SELECT. Confirm keys: Red `n`, Blue `f`, Gold `h`. */
async function confirmCenterCastles(sc: E2EScenario): Promise<void> {
  for (let i = 0; i < 40 && (await sc.phase()) !== Phase.CASTLE_SELECT; i++) {
    await sc.page.waitForTimeout(100);
  }
  for (let i = 0; i < 40 && (await sc.phase()) === Phase.CASTLE_SELECT; i++) {
    await sc.input.pressKey("n");
    await sc.input.pressKey("f");
    await sc.input.pressKey("h");
    await sc.page.waitForTimeout(150);
  }
}

/** Humans idle through CANNON_PLACE (round-1 safety net auto-places cannons),
 *  then wait for the build→battle tilt to ease in and settle to ~30°. */
async function reachTiltedBattle(sc: E2EScenario): Promise<void> {
  for (let i = 0; i < 400 && (await sc.phase()) !== Phase.BATTLE; i++) {
    await sc.page.waitForTimeout(100);
  }
  assertEquals(await sc.phase(), Phase.BATTLE, "reached BATTLE");
  for (let i = 0; i < 100; i++) {
    const cam = await sc.camera.state();
    if (cam.pitchState === "tilted" && cam.pitch > 0) return;
    await sc.page.waitForTimeout(100);
  }
  throw new Error("battle tilt never settled");
}

/** Adaptive closed-loop mover: sprint-hold (`b`) while far for speed, short
 *  pulses when close for precision. Re-reads the settled crosshair each
 *  iteration so it converges from either side without open-loop overshoot
 *  (cross-boundary reads lag the live crosshair, so a plain hold overshoots). */
async function moveCrosshair(
  sc: E2EScenario,
  axis: "x" | "y",
  target: number,
  tol: number,
  posKey: string,
  negKey: string,
): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const ch = await readCrosshair(sc);
    if (!ch) break;
    const err = ch[axis] - target;
    if (Math.abs(err) <= tol) return;
    const key = err > 0 ? negKey : posKey;
    if (Math.abs(err) > 40) {
      await sc.input.keyDown("b");
      await sc.input.keyDown(key);
      await sc.page.waitForTimeout(Math.min(400, Math.abs(err) * 2));
      await sc.input.keyUp(key);
      await sc.input.keyUp("b");
      await sc.page.waitForTimeout(50);
    } else {
      await sc.input.keyDown(key);
      await sc.page.waitForTimeout(20);
      await sc.input.keyUp(key);
      await sc.page.waitForTimeout(60);
    }
  }
}

/** Red is the pointer player (first alive human, keyboard-joined), so its
 *  crosshair is the bridge's `controller.crosshair`. */
async function readCrosshair(
  sc: E2EScenario,
): Promise<{ x: number; y: number } | null> {
  const s = await sc.state();
  return s.controller?.crosshair ?? null;
}

/** Wait for the fire gate (countdown clear, timer alive), press Red's fire
 *  key (`n`), and return the captured `CANNON_FIRED` trajectory. */
async function fireAndCapture(
  sc: E2EScenario,
): Promise<
  { impactRow: number; impactCol: number; impactAltitude: number } | null
> {
  let fired:
    | { impactRow: number; impactCol: number; impactAltitude: number }
    | null = null;
  sc.bus.on(GAME_EVENT.CANNON_FIRED, (ev) => {
    if (fired === null && ev.playerId === 0) {
      fired = {
        impactRow: ev.impactRow,
        impactCol: ev.impactCol,
        impactAltitude: ev.impactAltitude,
      };
    }
  });
  await sc.runUntil(
    async () => {
      const g = (await sc.gameState()) as Record<string, unknown> | null;
      return (
        !!g && (g.battleCountdown as number) <= 0 && (g.timer as number) > 0
      );
    },
    { timeoutMs: 20_000 },
  );
  for (let i = 0; i < 5 && fired === null; i++) {
    await sc.input.pressKey("n");
    await sc.runUntil(() => fired !== null, { timeoutMs: 1500 }).catch(() => {});
  }
  return fired;
}
