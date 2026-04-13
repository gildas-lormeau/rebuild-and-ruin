/**
 * E2E test: frame-rate determinism.
 *
 * Runs the same seed (25129, modern, 3 AI, 0 humans) through both the
 * browser runtime (E2EGame) and the headless test runtime, then compares
 * the bus event logs event-by-event. Any divergence proves the simulation
 * is dt-sensitive — and the first mismatch shows exactly where.
 *
 * Run: deno run -A test/e2e-dt-divergence.ts
 * Requires: npm run dev (vite on port 5173)
 */

import type { E2EBusEntry } from "../src/runtime/runtime-e2e-bridge.ts";
import { E2EGame, E2ETest } from "./e2e-helpers.ts";
import { createScenario } from "./scenario.ts";

const SEED = 25129;
const ROUNDS = 7;
/** Determinism-relevant event types. Rendering / animation events are
 *  excluded because they are inherently frame-rate dependent and don't
 *  affect game state. */
const DETERMINISTIC_TYPES = new Set([
  "gameStart",
  "roundStart",
  "roundEnd",
  "gameEnd",
  "phaseStart",
  "phaseEnd",
  "bannerStart",
  "bannerEnd",
  "modifierApplied",
  "upgradePicked",
  "wallPlaced",
  "cannonPlaced",
  "playerEliminated",
  "lifeLost",
  "gruntSpawn",
  "gruntSpawnBlocked",
]);

run();

async function run() {
  const test = new E2ETest("dt-divergence (seed 25129)");

  // ── 1. Browser path ──────────────────────────────────────────────
  console.log("Launching browser game...");
  const game = await E2EGame.create({
    seed: SEED,
    humans: 0,
    headless: true,
    rounds: ROUNDS,
    mode: "modern",
  });

  try {
    // Set 16× speed to match the user's repro scenario.
    await game.page.evaluate(() => {
      const win = globalThis as unknown as Record<string, unknown>;
      const dev = win.__dev as { speed?: (n: number) => void } | undefined;
      dev?.speed?.(16);
    });

    console.log("Waiting for game over...");
    await game.waitForGameOver({ timeout: 120_000 });

    const browserAll = await game.bus.events();
    const browserDet = browserAll.filter((ev) =>
      DETERMINISTIC_TYPES.has(ev.type),
    );

    // ── 2. Headless path ───────────────────────────────────────────
    console.log("Running headless scenario...");
    const sc = await createScenario({
      seed: SEED,
      mode: "modern",
      rounds: ROUNDS,
    });
    const headlessDet: E2EBusEntry[] = [];
    sc.bus.onAny((type, event) => {
      if (DETERMINISTIC_TYPES.has(type)) {
        headlessDet.push({
          ...(event as Record<string, unknown>),
          type,
          _seq: headlessDet.length,
        });
      }
    });
    sc.runUntil(() => sc.state.round > ROUNDS - 1, 80000);

    // ── 3. Compare event-by-event ──────────────────────────────────
    console.log("\n--- Event-by-event comparison ---\n");

    const maxLen = Math.max(browserDet.length, headlessDet.length);
    let firstDivergence = -1;
    let contextStart = 0;
    for (let idx = 0; idx < maxLen; idx++) {
      const bFp =
        idx < browserDet.length ? fingerprint(browserDet[idx]!) : "(end)";
      const hFp =
        idx < headlessDet.length ? fingerprint(headlessDet[idx]!) : "(end)";
      if (bFp !== hFp && firstDivergence === -1) {
        firstDivergence = idx;
        contextStart = Math.max(0, idx - 3);
      }
    }

    // Print full log up to divergence + some context after
    const printEnd =
      firstDivergence >= 0
        ? Math.min(maxLen, firstDivergence + 20)
        : maxLen;
    for (let idx = contextStart; idx < printEnd; idx++) {
      const bFp =
        idx < browserDet.length ? fingerprint(browserDet[idx]!) : "(end)";
      const hFp =
        idx < headlessDet.length ? fingerprint(headlessDet[idx]!) : "(end)";
      const match = bFp === hFp;
      const marker = !match ? " <<< DIVERGE" : "";
      const prefix = match ? "  " : ">>";
      console.log(
        `${prefix} [${String(idx).padStart(3)}]  browser: ${bFp.padEnd(55)} headless: ${hFp}${marker}`,
      );
    }

    if (firstDivergence === -1) {
      console.log(
        `\nAll ${maxLen} deterministic events match between browser and headless.`,
      );
    } else {
      console.log(
        `\nFirst divergence at event index ${firstDivergence} of ${maxLen}`,
      );
      console.log(`Browser total: ${browserDet.length} events`);
      console.log(`Headless total: ${headlessDet.length} events`);

      // Show per-round event counts for quick summary
      console.log("\n--- Per-round event counts ---");
      const roundCounts = (
        events: E2EBusEntry[],
      ): Map<string, Map<string, number>> => {
        const result = new Map<string, Map<string, number>>();
        let currentRound = "?";
        for (const ev of events) {
          if (ev.round !== undefined) currentRound = String(ev.round);
          const roundKey = `r${currentRound}`;
          if (!result.has(roundKey)) result.set(roundKey, new Map());
          const types = result.get(roundKey)!;
          types.set(ev.type, (types.get(ev.type) ?? 0) + 1);
        }
        return result;
      };
      const bCounts = roundCounts(browserDet);
      const hCounts = roundCounts(headlessDet);
      const allRounds = new Set([...bCounts.keys(), ...hCounts.keys()]);
      for (const round of [...allRounds].sort()) {
        const bTypes = bCounts.get(round) ?? new Map();
        const hTypes = hCounts.get(round) ?? new Map();
        const allTypes = new Set([...bTypes.keys(), ...hTypes.keys()]);
        const diffs: string[] = [];
        for (const type of allTypes) {
          const bc = bTypes.get(type) ?? 0;
          const hc = hTypes.get(type) ?? 0;
          if (bc !== hc) diffs.push(`${type}: ${bc} vs ${hc}`);
        }
        if (diffs.length > 0) {
          console.log(`  ${round}: ${diffs.join(", ")}`);
        }
      }
    }

    test.check(
      "deterministic event streams match",
      firstDivergence === -1,
      firstDivergence >= 0
        ? `first divergence at event[${firstDivergence}]`
        : undefined,
    );
  } finally {
    await game.close();
  }

  test.done();
}

/** Compact fingerprint: type + round + key payload fields. Enough to
 *  compare two event streams without noise from frame-specific data. */
function fingerprint(ev: { type: string; [k: string]: unknown }): string {
  const parts = [ev.type];
  if (ev.round !== undefined) parts.push(`r${ev.round}`);
  if (ev.phase !== undefined) parts.push(`p${ev.phase}`);
  if (ev.modifierId !== undefined) parts.push(String(ev.modifierId));
  if (ev.upgradeId !== undefined) parts.push(String(ev.upgradeId));
  if (ev.playerId !== undefined) parts.push(`pid${ev.playerId}`);
  if (ev.text !== undefined) parts.push(`"${ev.text}"`);
  return parts.join("|");
}
