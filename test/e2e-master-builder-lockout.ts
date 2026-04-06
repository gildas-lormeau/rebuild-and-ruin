/**
 * E2E test: Master Builder lockout renders amber pulsing timer.
 *
 * Verifies via the text render spy that during a Master Builder lockout,
 * the phase timer is drawn in amber with a scale > 1 (pulse effect),
 * and that normal timers use white with scale = 1.
 *
 * Run: deno run -A test/e2e-master-builder-lockout.ts
 * Requires: npm run dev (vite on port 5173)
 */

import {
  COLOR_LOCKOUT_AMBER,
  COLOR_TEXT_WHITE,
  E2EGame,
  E2ETest,
} from "./e2e-helpers.ts";

async function run() {
  const test = new E2ETest("Master Builder lockout e2e");

  const game = await E2EGame.create({
    seed: 42,
    humans: 0,
    headless: true,
    rounds: 8,
    mode: "modern",
  });

  // Collect timer text draws per frame, classified into lockout vs normal
  await game.spy.collect(`
    if (!/^\\d+$/.test(draw.text)) return null;
    if (draw.color === "${COLOR_LOCKOUT_AMBER}" && draw.scale > 1) return "lockout";
    if (draw.color === "${COLOR_TEXT_WHITE}" && draw.scale === 1) return "normal";
    return null;
  `, { maxPerBucket: 5 });

  try {
    await game.waitForGameOver();
    const results = await game.spy.collected();

    // Verify lockout frames
    if (results.lockout && results.lockout.length > 0) {
      const draw = results.lockout[0]!;
      console.log(`\nLockout frame: text="${draw.text}" color="${draw.color}" scale=${draw.scale.toFixed(3)}`);
      test.check("timer drawn in amber", draw.color === COLOR_LOCKOUT_AMBER);
      test.check("timer has pulse scale > 1", draw.scale > 1.0);
      test.check("timer has pulse scale <= 1.15", draw.scale <= 1.16);
    } else {
      test.check("saw lockout amber timer", false, "no MB lockout occurred");
    }

    // Verify normal frames
    if (results.normal && results.normal.length > 0) {
      const draw = results.normal[0]!;
      console.log(`\nNormal frame: text="${draw.text}" color="${draw.color}" scale=${draw.scale}`);
      test.check("normal timer is white", draw.color === COLOR_TEXT_WHITE);
      test.check("normal timer scale is 1", draw.scale === 1);
    } else {
      test.check("saw normal white timer", false, "no normal timer captured");
    }

    console.log(`\nCollected: ${results.lockout?.length ?? 0} lockout, ${results.normal?.length ?? 0} normal`);
  } finally {
    await game.close();
  }

  test.done();
}

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
