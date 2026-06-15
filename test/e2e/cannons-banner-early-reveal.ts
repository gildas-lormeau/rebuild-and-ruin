/**
 * E2E regression guard for the cannons-banner scene reveal.
 *
 * The two probe tiles are derived from the map, not hardcoded: the
 * bottom-most house (the sweep reaches it last) and the top-most house.
 * Two halves of the same animation, both probed with `sc.tileImage`:
 *
 *  1. NO EARLY REVEAL (the regression). The instant the "Place Cannons"
 *     banner is displayed, the sweep has not yet reached the BOTTOM-most
 *     house, so that tile must still show the PREVIOUS scene — not the brown
 *     house. The regression painted the next snapshot too early, so the tile
 *     read as the house before the sweep got there.
 *
 *  2. FULL REVEAL AT SWEEP END. When the banner sweep animation completes
 *     (`bannerSweepEnd`, progress=1), the next scene is fully shown, so the
 *     TOP-most house MUST be visible (brown). Guards against an
 *     over-correction that never reveals the scene.
 *
 * Pixel check: the captured PNG is decoded in-browser (Image → 2D canvas →
 * getImageData) — the rendered scene lives on the WebGL canvas, so only a
 * real screenshot sees it. Grass is green-dominant (red < green); the house
 * roof/walls are brown (red ≥ green), so the two separate cleanly.
 *
 * Runs with fast mode OFF: at 100x the sweep advances unpredictably between
 * the banner event and the screenshot, making both captures flaky.
 *
 * Run: npm run dev  (in another shell)
 *      deno run -A test/e2e/cannons-banner-early-reveal.ts [--visible]
 */

import { mkdirSync } from "node:fs";
import { BANNER_PLACE_CANNONS } from "../../src/runtime/banner-messages.ts";
import {
  createE2EScenario,
  E2ETest,
  GAME_EVENT,
  waitForBanner,
  waitForEvent,
} from "./scenario.ts";

interface HousePos {
  row: number;
  col: number;
  alive: boolean;
}

const SEED = 355529;
/** Above this fraction of red≥green pixels the tile shows the brown house;
 *  grass is green-dominant and sits near zero. */
const HOUSE_BROWN_THRESHOLD = 0.25;
const OUT = "tmp/screenshots/cannons-banner-early-reveal";

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

async function main(): Promise<void> {
  const test = new E2ETest("cannons-banner scene reveal (no early reveal + full reveal at sweep end)");
  mkdirSync(OUT, { recursive: true });

  const sc = await createE2EScenario({
    seed: SEED,
    humans: 0,
    rounds: 3,
    mode: "modern",
    headless: !Deno.args.includes("--visible"),
    // Real-time clock: at 100x the banner sweep advances unpredictably
    // between the banner event and the screenshot, so the captured sweep
    // progress (and thus the result) is flaky.
    fastMode: false,
  });

  try {
    // --- Banner displayed → sweep begins. ---
    await waitForBanner(sc, (ev) => ev.text === BANNER_PLACE_CANNONS, {
      timeoutMs: 60_000,
    });

    // Derive the probe tiles from the map: the bottom-most house (the sweep
    // reaches it last → must still be the prev scene at banner start) and the
    // top-most house (fully revealed by sweep end). Tie-break by column so the
    // pick is deterministic.
    const game = await sc.gameState();
    const houses = ((game?.map?.houses ?? []) as HousePos[]).filter(
      (h) => h.alive,
    );
    test.check("map has houses", houses.length > 0, `${houses.length} alive`);
    if (houses.length === 0) return;
    const bottomHouse = [...houses].sort(
      (a, b) => b.row - a.row || a.col - b.col,
    )[0];
    const topHouse = [...houses].sort(
      (a, b) => a.row - b.row || a.col - b.col,
    )[0];
    console.log(
      `  bottom house (early probe) = (${bottomHouse.row},${bottomHouse.col}), ` +
        `top house (end probe) = (${topHouse.row},${topHouse.col})`,
    );

    // The bottom house must NOT yet be the brown house — the next scene must
    // not be painted before the sweep reaches it.
    const earlyFrac = await houseColourFraction(
      sc,
      bottomHouse.row,
      bottomHouse.col,
    );
    await sc.page.screenshot({ path: `${OUT}/at-banner-start.png` });
    await sc.tileImage(bottomHouse.row, bottomHouse.col, {
      path: `${OUT}/early-tile.png`,
    });
    console.log(
      `  early (${bottomHouse.row},${bottomHouse.col}) brownFrac=${earlyFrac.toFixed(3)} ` +
        `(want < ${HOUSE_BROWN_THRESHOLD})`,
    );
    test.check(
      `next scene not revealed early: bottom house (${bottomHouse.row},${bottomHouse.col}) is NOT brown yet`,
      earlyFrac < HOUSE_BROWN_THRESHOLD,
      `brownFrac=${earlyFrac.toFixed(3)} — house revealed before the banner sweep`,
    );

    // --- Sweep animation completes → the full next scene is on screen. The
    //     top house must now be visible. ---
    await waitForEvent(
      sc,
      GAME_EVENT.BANNER_SWEEP_END,
      (ev) => ev.text === BANNER_PLACE_CANNONS,
      { timeoutMs: 30_000 },
    );
    const endFrac = await houseColourFraction(sc, topHouse.row, topHouse.col);
    await sc.page.screenshot({ path: `${OUT}/at-sweep-end.png` });
    await sc.tileImage(topHouse.row, topHouse.col, {
      path: `${OUT}/end-tile.png`,
    });
    console.log(
      `  end   (${topHouse.row},${topHouse.col}) brownFrac=${endFrac.toFixed(3)} ` +
        `(want > ${HOUSE_BROWN_THRESHOLD})`,
    );
    test.check(
      `full reveal at sweep end: top house (${topHouse.row},${topHouse.col}) is visible`,
      endFrac > HOUSE_BROWN_THRESHOLD,
      `brownFrac=${endFrac.toFixed(3)} — house not visible after the sweep completed`,
    );
  } finally {
    await sc.close();
  }

  test.done();
}

/** Fraction of pixels in the captured tile where red ≥ green — the brown/tan
 *  of the house vs the green-dominant grass. Decodes the PNG in-browser. */
async function houseColourFraction(
  sc: Awaited<ReturnType<typeof createE2EScenario>>,
  row: number,
  col: number,
): Promise<number> {
  const png = await sc.tileImage(row, col);
  let binary = "";
  for (const byte of png) binary += String.fromCharCode(byte);
  const dataUrl = `data:image/png;base64,${btoa(binary)}`;
  return await sc.page.evaluate(async (url: string) => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode failed"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let brown = 0;
    let total = 0;
    for (let idx = 0; idx < data.length; idx += 4) {
      total++;
      if (data[idx] >= data[idx + 1]) brown++;
    }
    return total === 0 ? 0 : brown / total;
  }, dataUrl);
}
