/**
 * E2E test: verify AI creates ice trench during frozen river modifier.
 *
 * Uses the e2e bridge to detect frozenTiles count decreasing during battle,
 * which proves an AI deliberately shot at frozen water tiles (ice trench).
 *
 * Run: deno run -A test/e2e-ice-trench.ts
 * Requires: npm run dev (vite on port 5173)
 */

import { E2EGame, E2ETest } from "./e2e-helpers.ts";

async function run() {
  const test = new E2ETest("AI ice trench e2e");

  const game = await E2EGame.create({
    seed: 741052,
    humans: 0,
    headless: true,
    rounds: 10,
    mode: "modern",
  });

  await game.page.evaluate(() => {
    const win = globalThis as unknown as Record<string, unknown>;
    win.__frozenMin = Infinity as number;
    win.__frozenMax = 0 as number;
    const prev = requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      prev((t: number) => {
        cb(t);
        const e2e = win.__e2e as Record<string, unknown> | undefined;
        if (!e2e || e2e.phase !== "BATTLE") return;
        const overlay = e2e.overlay as Record<string, unknown> | undefined;
        const entities = overlay?.entities as Record<string, unknown> | undefined;
        const frozen = entities?.frozenTiles as number[] | undefined;
        if (!frozen || frozen.length === 0) return;
        if (frozen.length > (win.__frozenMax as number)) win.__frozenMax = frozen.length;
        if (frozen.length < (win.__frozenMin as number)) win.__frozenMin = frozen.length;
      })) as typeof requestAnimationFrame;
  });

  try {
    await game.waitForGameOver({ timeout: 120_000 });

    const [min, max] = await game.page.evaluate(() => {
      const win = globalThis as unknown as Record<string, unknown>;
      return [win.__frozenMin as number, win.__frozenMax as number];
    });

    const delta = max - min;
    console.log(`\nFrozen tiles during battle: range ${min}–${max}, delta=${delta}`);

    test.check(
      "AI thaws 5+ frozen tiles during battle (ice trench)",
      delta >= 5,
      `delta=${delta}`,
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
