/**
 * Classify each determinism fixture as MATCHES / SAFE-RERECORD / BUG, so an
 * agent can re-record with confidence instead of guessing whether a divergence
 * is an intentional behavior change or a non-determinism bug it just introduced.
 *
 * For each fixture, replay it TWICE from current code:
 *   run A == run B == recorded  →  MATCHES        (fixture is current; do nothing)
 *   run A == run B != recorded  →  SAFE-RERECORD  (deterministic, behavior changed)
 *   run A != run B              →  BUG            (runtime is non-deterministic NOW)
 *
 * The two fresh runs agreeing is the proof the runtime is still deterministic —
 * that's the justification test/determinism.test.ts asks for before re-recording.
 *
 * Exit codes (for a future `retune` orchestrator to branch on):
 *   0  all MATCHES (nothing to do)
 *   2  drift, all SAFE-RERECORD → run `npm run record-determinism -- --all`
 *   1  at least one BUG → STOP, do NOT re-record, investigate
 *
 * Usage:
 *   deno run -A scripts/check-determinism.ts [--fixture seed-7-modern.json]
 */

import {
  FIXTURES_DIR,
  type FixtureFile,
  firstDivergence,
  recordFixtureEvents,
} from "./record-determinism.ts";

type Verdict = "MATCHES" | "SAFE-RERECORD" | "BUG";

if (import.meta.main) Deno.exit(await main());

// Wrapped in main() so biome's top-level const hoisting can't reorder the
// summary counts above the loop that fills `results` (see feedback_biome_const_hoist).
async function main(): Promise<number> {
  const onlyIdx = Deno.args.indexOf("--fixture");
  const only = onlyIdx >= 0 ? Deno.args[onlyIdx + 1] : undefined;

  const names = [...Deno.readDirSync(FIXTURES_DIR)]
    .filter(
      (e) => e.isFile && e.name.endsWith(".json") && (!only || e.name === only),
    )
    .map((e) => e.name)
    .sort();

  if (names.length === 0) {
    console.error(
      only ? `No fixture named ${only}` : `No fixtures in ${FIXTURES_DIR}/`,
    );
    return 1;
  }

  console.log(
    `Checking ${names.length} determinism fixture(s) — replaying each twice…\n`,
  );

  const results: { name: string; verdict: Verdict; detail: string }[] = [];
  for (const name of names) {
    const recorded: FixtureFile = JSON.parse(
      Deno.readTextFileSync(`${FIXTURES_DIR}/${name}`),
    );
    const a = await recordFixtureEvents(recorded.opts, recorded.timeoutMs);
    const b = await recordFixtureEvents(recorded.opts, recorded.timeoutMs);

    const ab = firstDivergence(a, b);
    let verdict: Verdict;
    let detail: string;
    if (ab !== -1) {
      verdict = "BUG";
      detail = `run A != run B at event ${ab} (lengths ${a.length}/${b.length}) — runtime is non-deterministic`;
    } else {
      const ar = firstDivergence(a, recorded.events);
      if (ar === -1) {
        verdict = "MATCHES";
        detail = `${a.length} events`;
      } else {
        verdict = "SAFE-RERECORD";
        detail = `deterministic, behavior changed at event ${ar} (now ${a.length}, fixture ${recorded.events.length})`;
      }
    }
    results.push({ name, verdict, detail });
    const tag =
      verdict === "BUG"
        ? "✗ BUG         "
        : verdict === "SAFE-RERECORD"
          ? "~ SAFE-RERECORD"
          : "✓ MATCHES     ";
    console.log(`  ${tag} ${name.padEnd(32)} ${detail}`);
  }

  const bugs = results.filter((r) => r.verdict === "BUG");
  const safe = results.filter((r) => r.verdict === "SAFE-RERECORD");
  const matches = results.filter((r) => r.verdict === "MATCHES");
  console.log(
    `\nSummary: ${matches.length} match, ${safe.length} safe-to-rerecord, ${bugs.length} bug(s)`,
  );

  if (bugs.length > 0) {
    console.log(
      `\n=> NON-DETERMINISM BUG in: ${bugs.map((b) => b.name).join(", ")}`,
    );
    console.log(
      `   Do NOT re-record. Two fresh runs of the same seed disagree — investigate the RNG/iteration-order drift.`,
    );
    return 1;
  }
  if (safe.length > 0) {
    console.log(
      `\n=> Runtime is deterministic; ${safe.length} fixture(s) drifted from an intentional change.`,
    );
    console.log(`   Safe to re-record:  npm run record-determinism -- --all`);
    return 2;
  }
  console.log(`\n=> All fixtures current.`);
  return 0;
}
