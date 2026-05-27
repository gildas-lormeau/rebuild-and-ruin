/**
 * Compare two AI-intelligence JSON snapshots — typically baseline (before a
 * fix) vs candidate (after). Designed to answer the practical question
 * "should I land this change?" by reporting per-metric win rates and absolute
 * shifts across matched (seed, slot) tuples.
 *
 * Workflow:
 *   1. Run baseline:   deno run -A scripts/ai-intelligence.ts --json --master-seed 1 > /tmp/before.json
 *   2. Apply the fix.
 *   3. Run candidate:  deno run -A scripts/ai-intelligence.ts --json --master-seed 1 > /tmp/after.json
 *   4. Compare:        deno run -A scripts/ai-compare.ts /tmp/before.json /tmp/after.json
 *
 * The same --master-seed in both runs draws the same seed set, so each
 * (seed, slot) appears in both snapshots and the comparison is paired.
 *
 * For multi-master-seed aggregation (recommended for noisy per-game metrics
 * like finalLives), see `ai-compare-multi.ts`.
 */

import {
  classifyVerdict,
  computeDeltas,
  fmt,
  fmtDelta,
  loadSnapshot,
  type MetricDelta,
  matchTuples,
} from "./ai-compare-lib.ts";

await main();

async function main(): Promise<void> {
  const [baselinePath, candidatePath] = Deno.args;
  if (!baselinePath || !candidatePath) {
    console.error(
      "Usage: deno run -A scripts/ai-compare.ts <baseline.json> <candidate.json>",
    );
    Deno.exit(1);
  }

  const baseline = loadSnapshot(baselinePath);
  const candidate = loadSnapshot(candidatePath);

  if (baseline.mode !== candidate.mode) {
    console.error(
      `mode mismatch: baseline=${baseline.mode} candidate=${candidate.mode}`,
    );
    Deno.exit(1);
  }
  if (baseline.rounds !== candidate.rounds) {
    console.warn(
      `Warning: round count differs (baseline=${baseline.rounds} candidate=${candidate.rounds})`,
    );
  }

  const matched = matchTuples(baseline, candidate);
  if (matched.length === 0) {
    console.error(
      "No matched (seed, slot) tuples between snapshots. Did you use the same --master-seed?",
    );
    Deno.exit(1);
  }

  console.log(`Comparing ${baselinePath} → ${candidatePath}`);
  console.log(
    `Mode: ${baseline.mode} | Rounds: ${baseline.rounds} | Matched tuples: ${matched.length}`,
  );
  console.log();

  const deltas = computeDeltas(matched);
  printTable(deltas);
}

function printTable(deltas: readonly MetricDelta[]): void {
  const n = deltas[0] ? deltas[0].better + deltas[0].worse + deltas[0].tied : 0;
  console.log(
    `${"metric".padEnd(15)} ${"baseline".padStart(11)} ${"candidate".padStart(11)} ${"meanΔ".padStart(11)} ${"%Δ".padStart(8)} ${"win%".padStart(8)} ${"tally".padStart(14)} verdict`,
  );
  console.log("─".repeat(95));
  for (const d of deltas) {
    const winPct =
      d.better + d.worse > 0 ? (100 * d.better) / (d.better + d.worse) : 0;
    const decided = d.better + d.worse;
    const winStr = decided > 0 ? `${winPct.toFixed(0)}%` : "—";
    const pctDelta =
      d.baselineMean !== 0 ? (d.meanDelta / d.baselineMean) * 100 : 0;
    const verdict = classifyVerdict(winPct, decided, n);
    console.log(
      `${d.name.padEnd(15)} ${fmt(d.baselineMean).padStart(11)} ${fmt(d.candidateMean).padStart(11)} ${fmtDelta(d.meanDelta).padStart(11)} ${(pctDelta >= 0 ? "+" : "") + pctDelta.toFixed(1) + "%"}`.padEnd(
        64,
      ) +
        ` ${winStr.padStart(7)} ${`${d.better}/${d.worse}/${d.tied}`.padStart(13)} ${verdict}`,
    );
  }
  console.log("─".repeat(95));
  console.log(
    `tally = better/worse/tied. win% = better / (better + worse). 50% ≈ noise; >55% with positive Δ = real shift.`,
  );
}
