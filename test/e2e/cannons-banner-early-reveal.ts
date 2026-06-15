/**
 * E2E REGRESSION REPRO — currently FAILING by design.
 *
 * Reproduces a recently-introduced regression where the banner's "next"
 * scene snapshot is revealed too early: while the "Place Cannons" banner is
 * still sweeping, the post-banner scene is already painted in regions the
 * sweep hasn't reached.
 *
 * Probe: the tile at (23,3) holds a house. Captured at the exact moment the
 * "Place Cannons" banner is displayed (seed 355529, modern, round 1 — the
 * same moment as the reference full-screen snapshot), the house must NOT be
 * visible yet: until the sweep reveals it, that tile should still show the
 * previous scene. Today the next scene leaks through, so the tile reads as
 * the brown house — and the assertion below fails.
 *
 * Expected lifecycle:
 *   - NOW (regression present): FAILS — (23,3) is brownish (house revealed early).
 *   - AFTER the fix:            PASSES — (23,3) shows the prev scene (not brown).
 *
 * This uses the `sc.tileImage` API as a pixel-precise probe. The PNG is
 * decoded in-browser (Image → 2D canvas → getImageData) because the rendered
 * scene lives on the WebGL canvas, so only a real screenshot sees it.
 *
 * Run: npm run dev  (in another shell)
 *      deno run -A test/e2e/cannons-banner-early-reveal.ts [--visible]
 */

import { mkdirSync } from "node:fs";
import { BANNER_PLACE_CANNONS } from "../../src/runtime/banner-messages.ts";
import { createE2EScenario, E2ETest, waitForBanner } from "./scenario.ts";

const SEED = 355529;
const HOUSE_ROW = 23;
const HOUSE_COL = 3;
/** Above this fraction of red≥green pixels the tile is showing the brown
 *  house; grass is green-dominant and sits near zero. */
const HOUSE_BROWN_THRESHOLD = 0.25;
const OUT = "tmp/screenshots/cannons-banner-early-reveal";

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});

async function main(): Promise<void> {
  const test = new E2ETest(
    "cannons-banner early next-scene reveal (regression repro)",
  );
  mkdirSync(OUT, { recursive: true });

  const sc = await createE2EScenario({
    seed: SEED,
    humans: 0,
    rounds: 3,
    mode: "modern",
    headless: !Deno.args.includes("--visible"),
    // Real-time clock: at 100× the banner sweep advances unpredictably
    // between `waitForBanner` and the screenshot, so the captured sweep
    // progress (and thus the result) is flaky. Real time keeps the capture
    // reliably early in the sweep, when (23,3) has not yet been reached.
    fastMode: false,
  });

  try {
    // Trigger at the exact moment the cannons banner is displayed.
    await waitForBanner(sc, (ev) => ev.text === BANNER_PLACE_CANNONS, {
      timeoutMs: 60_000,
    });

    // Ground truth: (23,3) is a house — so the "next" scene there is brown.
    const game = await sc.gameState();
    const houses = (game?.map?.houses ?? []) as { row: number; col: number }[];
    const isHouse = houses.some(
      (h) => h.row === HOUSE_ROW && h.col === HOUSE_COL,
    );
    test.check(`map has a house at (${HOUSE_ROW},${HOUSE_COL})`, isHouse);

    // Debug artifacts (gitignored) so a failing run is inspectable.
    await sc.page.screenshot({ path: `${OUT}/fullscreen.png` });
    await sc.tileImage(HOUSE_ROW, HOUSE_COL, { path: `${OUT}/tile-23-3.png` });

    const brownFrac = await houseColourFraction(sc, HOUSE_ROW, HOUSE_COL);
    console.log(
      `  (${HOUSE_ROW},${HOUSE_COL}) brownFrac=${brownFrac.toFixed(3)} ` +
        `(threshold ${HOUSE_BROWN_THRESHOLD})`,
    );

    // The spec: until the banner sweep reaches this tile, the next scene
    // (the house) must NOT be painted. FAILS today — the regression leaks
    // the next snapshot, so the tile is already brown.
    test.check(
      `next scene not revealed early: (${HOUSE_ROW},${HOUSE_COL}) is NOT the brown house yet`,
      brownFrac < HOUSE_BROWN_THRESHOLD,
      `brownFrac=${brownFrac.toFixed(3)} — house revealed before the banner sweep`,
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
