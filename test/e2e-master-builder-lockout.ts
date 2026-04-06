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

import { E2EGame } from "./e2e-helpers.ts";

const LOCKOUT_AMBER = "rgba(255,180,50,1)";
const TEXT_WHITE = "#fff";

let passed = 0;
let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function run() {
  console.log("Starting Master Builder lockout e2e test...\n");

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
    if (draw.color === "${LOCKOUT_AMBER}" && draw.scale > 1) return "lockout";
    if (draw.color === "${TEXT_WHITE}" && draw.scale === 1) return "normal";
    return null;
  `, { maxPerBucket: 5 });

  // Wait for game to finish
  await game.page.waitForFunction(
    () => {
      const e2e = (globalThis as unknown as Record<string, unknown>).__e2e as {
        mode?: string;
      } | undefined;
      return e2e?.mode === "STOPPED";
    },
    { timeout: 60_000 },
  ).catch(() => {});

  const results = await game.spy.collected();

  try {
    // Verify lockout frames
    if (results.lockout && results.lockout.length > 0) {
      const draw = results.lockout[0]!;
      console.log(`\nLockout frame: text="${draw.text}" color="${draw.color}" scale=${draw.scale.toFixed(3)}`);
      check("timer drawn in amber", draw.color === LOCKOUT_AMBER);
      check("timer has pulse scale > 1", draw.scale > 1.0);
      check("timer has pulse scale <= 1.15", draw.scale <= 1.16);
    } else {
      check("saw lockout amber timer", false, "no MB lockout occurred");
    }

    // Verify normal frames
    if (results.normal && results.normal.length > 0) {
      const draw = results.normal[0]!;
      console.log(`\nNormal frame: text="${draw.text}" color="${draw.color}" scale=${draw.scale}`);
      check("normal timer is white", draw.color === TEXT_WHITE);
      check("normal timer scale is 1", draw.scale === 1);
    } else {
      check("saw normal white timer", false, "no normal timer captured");
    }

    console.log(`\nCollected: ${results.lockout?.length ?? 0} lockout, ${results.normal?.length ?? 0} normal`);
    console.log(`\n--- Summary ---`);
    console.log(`${passed} passed, ${failures} failed\n`);
  } finally {
    await game.close();
  }

  if (failures > 0) Deno.exit(1);
}

run().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
