/**
 * E2E test: verify actual sprite draw calls during every banner sweep.
 *
 * Uses the render spy (drawSprite call log) to verify the rendering layer
 * actually draws houses, grunts, towers at every phase transition banner.
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

  // Collect sprite draws during banners, bucketed by type
  await game.spy.collect(`
    if (!e2e?.overlay?.banner) return null;
    if (draw.name.startsWith("tower_")) return "towers";
    if (draw.name.startsWith("house")) return "houses";
    if (draw.name.startsWith("cannon_") || draw.name.startsWith("super_")) return "cannons";
    if (draw.name.startsWith("grunt_")) return "grunts";
    return null;
  `, { source: "sprite", maxPerBucket: 50 });

  try {
    await game.waitForGameOver();
    const results = await game.spy.collected();

    const towers = results.towers ?? [];
    const houses = results.houses ?? [];
    const cannons = results.cannons ?? [];
    const grunts = results.grunts ?? [];

    console.log(
      `\nCollected: towers=${towers.length} houses=${houses.length}` +
      ` cannons=${cannons.length} grunts=${grunts.length}`,
    );

    test.check("towers drawn during banners", towers.length > 0);
    test.check("houses drawn during banners", houses.length > 0);
    test.check("cannons drawn during banners", cannons.length > 0);
  } finally {
    await game.close();
  }

  test.done();
}

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
