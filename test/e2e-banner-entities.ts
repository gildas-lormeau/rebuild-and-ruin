/**
 * E2E test: verify entities are present in the bridge during every banner sweep.
 *
 * Uses the bridge state snapshot (overlay.entities, overlay.banner) to verify
 * the rendering layer has entity data (houses, grunts, towers) during phase
 * transition banners.
 *
 * Run: deno run -A test/e2e-banner-entities.ts
 * Requires: npm run dev (vite on port 5173)
 */

import { E2EGame, E2ETest } from "./e2e-helpers.ts";

async function run() {
  const test = new E2ETest("banner rendering e2e");

  const game = await E2EGame.create({
    seed: 42,
    humans: 0,
    headless: true,
    rounds: 1,
  });

  // Install a per-frame collector that records entity presence during banners
  await game.page.evaluate(() => {
    const win = globalThis as unknown as Record<string, unknown>;
    const buckets: Record<string, number> = {};
    win.__bannerCollector = buckets;

    const prevRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
      prevRAF((time: number) => {
        cb(time);
        const e2e = win.__e2e as Record<string, unknown> | undefined;
        const overlay = e2e?.overlay as Record<string, unknown> | undefined;
        if (!overlay?.banner) return;
        const entities = overlay.entities as Record<string, unknown> | null;
        if (!entities) return;
        const towerAlive = entities.towerAlive as boolean[] | undefined;
        if (towerAlive?.some(Boolean)) buckets.towers = (buckets.towers ?? 0) + 1;
        const houses = entities.houses as unknown[] | undefined;
        if (houses && houses.length > 0) buckets.houses = (buckets.houses ?? 0) + 1;
        const grunts = entities.grunts as unknown[] | undefined;
        if (grunts && grunts.length > 0) buckets.grunts = (buckets.grunts ?? 0) + 1;
        // Cannons are tracked per-player in the bridge
        const players = e2e?.players as { cannons: number }[] | undefined;
        if (players?.some((p) => p.cannons > 0)) buckets.cannons = (buckets.cannons ?? 0) + 1;
      });
  });

  try {
    await game.waitForGameOver();

    const results = await game.page.evaluate(() => {
      const win = globalThis as unknown as Record<string, unknown>;
      return (win.__bannerCollector ?? {}) as Record<string, number>;
    });

    console.log(
      `\nBanner frames with: towers=${results.towers ?? 0} houses=${results.houses ?? 0}` +
      ` cannons=${results.cannons ?? 0} grunts=${results.grunts ?? 0}`,
    );

    test.check("towers present during banners", (results.towers ?? 0) > 0);
    test.check("houses present during banners", (results.houses ?? 0) > 0);
    test.check("cannons present during banners", (results.cannons ?? 0) > 0);
  } finally {
    await game.close();
  }

  test.done();
}

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
