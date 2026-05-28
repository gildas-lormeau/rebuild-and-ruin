/**
 * Phase-test fixture sanity-checker.
 *
 * Usage:
 *   deno run -A scripts/fixture-check.ts <path-to-fixture.json> [more...]
 *
 * For each fixture, the script:
 *   1. Validates the JSON shape (`validateFixture`).
 *   2. Boots a real runtime via `createPhaseScenario` and applies all
 *      overrides (houses, bonus squares, walls).
 *   3. Calls `recomputeFixtureDerivedState` so any wall-derived state
 *      (interior, enclosedTowers, territory) is consistent with the
 *      authored overrides.
 *   4. Advances one frame to confirm the runtime can tick from the loaded
 *      state without `assertInteriorFresh` or other invariants tripping.
 *
 * Exits with non-zero if any fixture fails — agents that author or
 * mutate fixtures should run this before committing.
 */

import {
  createPhaseScenario,
  recomputeFixtureDerivedState,
} from "../test/phase-tests/loader.ts";
import type { FixtureFile } from "../test/phase-tests/types.ts";

interface CheckResult {
  path: string;
  ok: boolean;
  error?: string;
}

await main();

async function main(): Promise<void> {
  const paths = Deno.args;
  if (paths.length === 0) {
    console.error(
      "usage: deno run -A scripts/fixture-check.ts <path-to-fixture.json> [more...]",
    );
    Deno.exit(2);
  }
  let failed = 0;
  for (const path of paths) {
    const result = await checkFixture(path);
    if (result.ok) {
      console.log(`OK    ${result.path}`);
    } else {
      failed++;
      console.error(`FAIL  ${result.path}`);
      console.error(`      ${result.error}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} fixture(s) failed`);
    Deno.exit(1);
  }
}

async function checkFixture(path: string): Promise<CheckResult> {
  let fixture: FixtureFile;
  try {
    const text = await Deno.readTextFile(path);
    fixture = JSON.parse(text) as FixtureFile;
  } catch (err) {
    return {
      path,
      ok: false,
      error: `failed to load: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const sc = await createPhaseScenario(fixture);
    if (fixture.walls && fixture.walls.length > 0) {
      recomputeFixtureDerivedState(sc.state);
    }
    // Single-frame tick — exercises read paths that gate on
    // `assertInteriorFresh` so a missing recompute surfaces here.
    sc.tick(1);
    return { path, ok: true };
  } catch (err) {
    return {
      path,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
