/**
 * Behavioral proof that the AI's standard (non-sweep) fire targeting wastes
 * shots on occluded towers — the sibling case to `ai-occluded-aim.test.ts`.
 *
 * The grunt-sweep planner filters occluded grunts (that test). The standard
 * `pickTarget` wall/enclosure path does NOT: it can pick an enemy wall that is
 * hidden behind a camera-near tower under the battle tilt, the `aim()` seam
 * then redirects the shot onto that tower, and the ball is wasted — towers are
 * cannonball-invulnerable, so a tower-redirected shot can NEVER do anything.
 * The AI keeps re-picking the same unreachable wall, dumping a whole battle's
 * fire into an invulnerable tower (observed at scale on seed 857808 r63; this
 * seed reproduces the identical pattern by round 4).
 *
 * We watch the fire-decision diag, which carries `intendedTarget` (pre-occlusion
 * plan tile) and `aimTarget` (post-occlusion `FireIntent`). A fire is wasted-on-
 * tower when the two differ (occlusion redirected) and the aim tile sits on a
 * tower. SPEC: that count is zero — the planner should skip a target whose only
 * reachable aim is an invulnerable tower. Non-vacuity: standard fires actually
 * happened (the pick path ran), so a passing run is not an empty board.
 *
 * Run with: deno test --no-check test/ai-occluded-tower-fire.test.ts
 */

import { assert } from "@std/assert";
import { setAiBattleDiagHook } from "../src/ai/ai-battle-diag.ts";
import { hasTowerAt } from "../src/shared/sim/occupancy-queries.ts";
import { createScenario } from "./scenario.ts";

interface WastedFire {
  round: number;
  origin: string;
  intended: { row: number; col: number };
  tower: { row: number; col: number };
}

// The standard (non-chain) pick path — the one that lacks an occlusion filter.
const STANDARD_ORIGINS = new Set(["default", "focus_fire"]);

Deno.test(
  "AI standard fire: a target reachable only by redirecting onto an invulnerable tower is never fired",
  async () => {
    // To-the-death (match never caps), so round-4 behaviour matches watch-game /
    // the seed scan exactly. The runUntil predicate bounds the run.
    using sc = await createScenario({
      seed: 8,
      mode: "modern",
      rounds: Number.POSITIVE_INFINITY,
    });

    let standardFires = 0;
    const wasted: WastedFire[] = [];

    setAiBattleDiagHook((ev) => {
      const intended = ev.intendedTarget;
      const aim = ev.aimTarget;
      if (!intended || !aim) return;
      if (ev.origin && STANDARD_ORIGINS.has(ev.origin)) standardFires++;
      // Occlusion redirected the shot (aim != plan) AND it landed on a tower:
      // an unconditionally wasted cannonball.
      const redirected = intended.row !== aim.row || intended.col !== aim.col;
      if (!redirected) return;
      if (!hasTowerAt(sc.state, aim.row, aim.col)) return;
      wasted.push({
        round: sc.state.round,
        origin: ev.origin ?? "?",
        intended: { row: intended.row, col: intended.col },
        tower: { row: aim.row, col: aim.col },
      });
    });

    try {
      // Reaching round 5 means round 4's battle (the decisive one) is complete.
      sc.runUntil(() => sc.state.round >= 5, { timeoutMs: 600_000 });
    } finally {
      setAiBattleDiagHook(undefined);
    }

    assert(
      standardFires > 0,
      "expected at least one standard (default/focus_fire) fire — the pick " +
        "path under test never ran (vacuous)",
    );

    if (wasted.length > 0) {
      const sample = wasted
        .slice(0, 6)
        .map(
          (w) =>
            `r${w.round} ${w.origin} intended(${w.intended.row},${w.intended.col})` +
            ` -> tower(${w.tower.row},${w.tower.col})`,
        )
        .join("\n    ");
      assert(
        false,
        `${wasted.length} standard fire(s) were occlusion-redirected onto an ` +
          `invulnerable tower (wasted shots); the planner should have skipped ` +
          `those targets:\n    ${sample}`,
      );
    }

    console.log(
      `\n  ${standardFires} standard fire(s), 0 wasted on occluded towers — ` +
        `the planner correctly skipped tower-occluded targets`,
    );
  },
);
