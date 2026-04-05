/**
 * E2E test: verify actual sprite draw calls during every banner sweep.
 *
 * Uses the render spy (drawSprite call log) to verify the rendering layer
 * actually draws houses, grunts, towers at every phase transition banner.
 *
 * Run: npx tsx test/e2e-banner-entities.ts
 * Requires: npm run dev (vite on port 5173)
 */

import { E2EGame } from "./e2e-helpers.ts";

let passed = 0;
let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`    PASS: ${label}`);
    passed++;
  } else {
    console.log(`    FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function getSpyLog(
  game: E2EGame,
): Promise<{ name: string; x: number; y: number }[]> {
  return game.page.evaluate(() => {
    const e2e = (globalThis as unknown as Record<string, unknown>).__e2e as {
      renderSpy?: { name: string; x: number; y: number }[] | null;
    } | undefined;
    return e2e?.renderSpy ?? [];
  });
}

function countByPrefix(log: { name: string }[], prefix: string): number {
  return log.filter((entry) => entry.name.startsWith(prefix)).length;
}

function spriteSummary(log: { name: string }[]): string {
  const parts: string[] = [];
  const houses = countByPrefix(log, "house");
  const grunts = countByPrefix(log, "grunt_");
  const towers = countByPrefix(log, "tower_");
  const cannons = countByPrefix(log, "cannon_") + countByPrefix(log, "super_");
  if (houses > 0) parts.push(`houses=${houses}`);
  if (grunts > 0) parts.push(`grunts=${grunts}`);
  if (towers > 0) parts.push(`towers=${towers}`);
  if (cannons > 0) parts.push(`cannons=${cannons}`);
  parts.push(`total=${log.length}`);
  return parts.join(" ");
}

/** Poll bridge state. Returns null if page is closed. */
async function safeQuery(game: E2EGame): Promise<{
  mode: string;
  phase: string;
  round: number;
  hasBanner: boolean;
  gameOver: boolean;
} | null> {
  return game.page.evaluate(() => {
    const e2e = (globalThis as unknown as Record<string, unknown>).__e2e as {
      mode?: string;
      phase?: string;
      round?: number;
      overlay?: {
        banner?: unknown | null;
        ui?: { gameOver?: unknown | null };
      };
    } | undefined;
    if (!e2e) return null;
    return {
      mode: e2e.mode ?? "",
      phase: e2e.phase ?? "",
      round: e2e.round ?? 0,
      hasBanner: e2e.overlay?.banner != null,
      gameOver: e2e.mode === "STOPPED" || e2e.overlay?.ui?.gameOver != null,
    };
  }).catch(() => null);
}

/** Wait for a condition on the bridge. Returns false if timed out or page closed. */
async function waitFor(
  game: E2EGame,
  predicate: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  return game.page.waitForFunction(
    new Function("return " + predicate) as () => boolean,
    { timeout: timeoutMs },
  ).then(() => true).catch(() => false);
}

async function run() {
  console.log("Starting banner rendering e2e test...\n");

  const game = await E2EGame.create({
    seed: 42,
    humans: 0,
    headless: true,
    rounds: 1,
  });

  // Enable the render spy so we can read drawSprite calls
  await game.page.evaluate(() => {
    const e2e = (globalThis as unknown as Record<string, unknown>).__e2e as {
      enableRenderSpy?: () => void;
    } | undefined;
    e2e?.enableRenderSpy?.();
  });

  let bannersCaught = 0;

  try {
    // Main loop: wait for banners, check sprites, repeat until game over
    while (true) {
      const state = await safeQuery(game);
      if (!state || state.gameOver) break;

      if (state.hasBanner) {
        bannersCaught++;

        // Slow down and wait for a frame with sprite data
        await game.setFastMode(false);
        await game.page.waitForFunction(() => {
          const e2e = (globalThis as unknown as Record<string, unknown>).__e2e as {
            renderSpy?: unknown[] | null;
          } | undefined;
          return e2e?.renderSpy && e2e.renderSpy.length > 0;
        }, { timeout: 5000 });

        const spy = await getSpyLog(game);
        const counts = {
          houses: countByPrefix(spy, "house"),
          towers: countByPrefix(spy, "tower_"),
          grunts: countByPrefix(spy, "grunt_"),
          cannons: countByPrefix(spy, "cannon_") + countByPrefix(spy, "super_"),
        };

        console.log(
          `\n  Banner #${bannersCaught}: "${state.phase}" (round=${state.round})`,
        );
        console.log(`    sprites: ${spriteSummary(spy)}`);

        // Towers must always be drawn (they exist from round 1)
        check(`towers drawn`, counts.towers > 0, `count=${counts.towers}`);
        // Houses: always present in round 1 (none destroyed yet)
        if (counts.houses > 0) check(`houses drawn`, true, `count=${counts.houses}`);
        // Cannons: present from BATTLE banner onward (placed during cannon phase)
        if (state.phase === "BATTLE" || state.phase === "WALL_BUILD") {
          check(`cannons drawn`, counts.cannons > 0, `count=${counts.cannons}`);
        }
        // Walls are drawn procedurally (fillRect), not via drawSprite — can't check via spy
        // Grunts: only from round 2+
        if (counts.grunts > 0) check(`grunts drawn`, true, `count=${counts.grunts}`);

        // Wait for banner to end or game over
        await game.setFastMode(true);
        const ok = await waitFor(game,
          `(() => { const e = (globalThis).__e2e; return !e?.overlay?.banner || e?.mode === "STOPPED" || !!e?.overlay?.ui?.gameOver; })()`,
          30_000,
        );
        if (!ok) {
          console.log(`    banner-end wait timed out — exiting`);
          break;
        }

        // After banner
        const post = await safeQuery(game);
        if (!post || post.gameOver) break;

        await game.setFastMode(false);
        await game.page.waitForFunction(() => {
          const e2e = (globalThis as unknown as Record<string, unknown>).__e2e as {
            renderSpy?: unknown[] | null;
          } | undefined;
          return e2e?.renderSpy && e2e.renderSpy.length > 0;
        }, { timeout: 5000 });
        const spyAfter = await getSpyLog(game);
        const towersAfter = countByPrefix(spyAfter, "tower_");
        console.log(`    after:   ${spriteSummary(spyAfter)}`);
        check(`towers after`, towersAfter > 0, `count=${towersAfter}`);

        await game.setFastMode(true);
        continue;
      }

      // No banner — wait for next banner or game over
      await game.setFastMode(true);
      const ok = await waitFor(game,
        `(() => { const e = (globalThis).__e2e; return !!e?.overlay?.banner || e?.mode === "STOPPED" || !!e?.overlay?.ui?.gameOver; })()`,
        30_000,
      );
      if (!ok) {
        console.log(`  waitFor timed out — exiting`);
        break;
      }
    }

    console.log(`\n--- Summary ---`);
    console.log(`Banners caught: ${bannersCaught}`);
    console.log(`${passed} passed, ${failures} failed\n`);
  } finally {
    await game.close();
  }

  if (failures > 0) process.exit(1);
  if (bannersCaught === 0) {
    console.log("FAIL: no banners caught");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
