/**
 * Shared "where does the scenario come from" resolver for the observation
 * scripts (watch-game, snapshot). A scenario can originate from either a raw
 * seed (booted at round 1) or a phase-test fixture (resumed at its captured
 * entry phase/round). Both yield the same `Scenario` shape, so callers attach
 * their observers / renderers without caring which path ran.
 *
 * The renderer is orthogonal: pass `{ renderer: "ascii" }` and the ASCII
 * handle is threaded through both the seed path (`createScenario`) and the
 * fixture path (`createPhaseScenario`).
 *
 * Precondition: exactly one of `args.seed` / `args.fixture` is set. Each tool
 * validates that itself (their usage messages differ) before calling here.
 */

import type { Phase } from "../src/shared/core/game-phase.ts";
import { createPhaseScenario } from "../test/phase-tests/loader.ts";
import type { FixtureFile } from "../test/phase-tests/types.ts";
import { createScenario, type Scenario } from "../test/scenario.ts";

/** The seed/fixture-selecting subset of a tool's parsed args. Both tools'
 *  `Args` interfaces structurally satisfy this. */
export interface ScenarioSourceArgs {
  /** Set on the seed path. Mutually exclusive with `fixture`. */
  seed: number | undefined;
  /** Phase-fixture JSON path. Mutually exclusive with `seed`. */
  fixture: string | undefined;
  mode: "classic" | "modern";
  /** Match-length cap (state.maxRounds). 0 = to-the-death. Seed path only —
   *  a fixture's own `rounds` field sets match length. */
  matchRounds: number;
}

export interface ResolvedScenarioSource {
  sc: Scenario;
  /** Round the watch budget counts from: the fixture's entry round, or 1 for
   *  a fresh seed. */
  startRound: number;
  /** Effective seed (from the fixture when one was loaded). */
  seed: number;
  mode: "classic" | "modern";
  /** Provenance string for the banner line (e.g. `match-rounds=∞` or
   *  `fixture=… entry=WALL_BUILD@r2`). */
  sourceLabel: string;
  /** Present only for fixture sources — the phase/round the runtime resumed
   *  at. Lets a tool default its target to the entry moment. */
  fixtureEntry?: { phase: Phase; round: number };
}

export async function resolveScenarioSource(
  args: ScenarioSourceArgs,
  opts?: { renderer?: "ascii" },
): Promise<ResolvedScenarioSource> {
  if (args.fixture !== undefined) {
    const fixture = JSON.parse(
      await Deno.readTextFile(args.fixture),
    ) as FixtureFile;
    const sc = await createPhaseScenario(fixture, { renderer: opts?.renderer });
    return {
      sc,
      startRound: fixture.round,
      seed: fixture.seed,
      mode: fixture.mode,
      sourceLabel: `fixture=${args.fixture} entry=${fixture.entryPhase}@r${fixture.round}`,
      fixtureEntry: { phase: fixture.entryPhase, round: fixture.round },
    };
  }

  // Seed path. --match-rounds caps the match length; 0 → Infinity, so
  // maxRounds-gated RNG (upgrade-system's "skip pick for the final round")
  // never trips and the observed state is identical regardless of how far a
  // tool's watch budget reaches.
  const scenarioRounds =
    args.matchRounds > 0 ? args.matchRounds : Number.POSITIVE_INFINITY;
  const sc = await createScenario({
    seed: args.seed!,
    mode: args.mode,
    rounds: scenarioRounds,
    renderer: opts?.renderer,
  });
  return {
    sc,
    startRound: 1,
    seed: args.seed!,
    mode: args.mode,
    sourceLabel:
      args.matchRounds > 0
        ? `match-rounds=${args.matchRounds}`
        : "match-rounds=∞",
  };
}
