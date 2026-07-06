/**
 * Behavioral proof of the AI grunt-sweep occlusion rule: under the battle tilt
 * a wall one tile to the camera-near (south) side of a grunt hides it, so the
 * aim seam would redirect a shot onto that wall (often the AI's own perimeter
 * or, in a charity sweep, the beneficiary's wall). The grunt-sweep planner
 * (`planGruntSweep`, reused by the charity sweep) therefore filters occluded
 * grunts out of its target list — the only path where the AI aims at a grunt
 * tile directly — so a sweep never spends a cannon on a grunt it can't hit.
 *
 * We watch the fire-decision diag, which carries the `intendedTarget`
 * (pre-occlusion plan tile) and `aimTarget` (post-occlusion `FireIntent`). For
 * every grunt-sweep / charity fire we assert the two agree (no redirect) and
 * that the aim tile is reachable per `aimReachesTile`. Non-vacuity: at least one
 * sweep fired, and at least one grunt was occluded at some observed tick — so
 * the avoidance is a real choice, not an empty board.
 *
 * Run with: deno test --no-check test/ai-occluded-aim.test.ts
 */

import { assert } from "@std/assert";
import { setAiBattleDiagHook } from "../src/ai/ai-battle-diag.ts";
import { aimReachesTile } from "../src/game/index.ts";
import { createScenario } from "./scenario.ts";

// Origins emitted by CHAIN.GRUNT sweeps: self-defence ("grunt_sweep") and the
// charity sweep ("charity") — the two tactics that aim at grunt tiles.
const SWEEP_ORIGINS = new Set(["grunt_sweep", "charity"]);

Deno.test(
  "AI grunt sweep: occluded grunts (hidden behind a camera-near wall) are never targeted",
  async () => {
    // High round cap: seed-10 modern reaches round 12 without a winner, so we
    // observe a fixed span of rounds rather than waiting for one. Grunt
    // counts climb across rounds, so sweeps and wall-occluded grunts both
    // appear. (Was seed 4 until the battle-timer input lockout shifted the
    // AI RNG streams — probe: tmp/probe-occluded-aim-seed.ts.)
    using sc = await createScenario({ seed: 10, mode: "modern", rounds: 30 });

    let sweepFires = 0;
    let redirects = 0;
    let occlusionWasLive = false;

    setAiBattleDiagHook((ev) => {
      // Independent of the fire being observed: confirm the occlusion geometry
      // actually arises on this board (some grunt sits behind a camera-near
      // wall right now), so the planner's avoidance is meaningful.
      if (!occlusionWasLive) {
        occlusionWasLive = sc.state.grunts.some(
          (g) => !aimReachesTile(sc.state, g.row, g.col),
        );
      }

      if (!ev.origin || !SWEEP_ORIGINS.has(ev.origin)) return;
      const intended = ev.intendedTarget;
      const aim = ev.aimTarget;
      if (!intended || !aim) return;
      sweepFires++;
      // The fix: the planned grunt tile is reachable, so the aim seam leaves it
      // untouched — intended and aim agree and the aim tile takes no occluder.
      if (intended.row !== aim.row || intended.col !== aim.col) redirects++;
      assert(
        aimReachesTile(sc.state, aim.row, aim.col),
        `grunt sweep fired at an occluded tile (${aim.row},${aim.col}) — the ` +
          `shot would snap onto the wall hiding it instead of the grunt`,
      );
    });

    try {
      // Play a fixed span of rounds (the game won't end on its own here).
      // seed-10's first grunt sweep lands at round 4; observe through round
      // 12 so plenty of sweeps meet plenty of occluded grunts.
      sc.runUntil(() => sc.state.round >= 12, { timeoutMs: 1_300_000 });
    } finally {
      setAiBattleDiagHook(undefined);
    }

    assert(sweepFires > 0, "expected at least one grunt-sweep / charity fire");
    assert(
      occlusionWasLive,
      "expected at least one grunt to be wall-occluded during the run — the " +
        "test would otherwise be vacuous (no occlusion to avoid)",
    );
    assert(
      redirects === 0,
      `${redirects}/${sweepFires} grunt-sweep fires were occlusion-redirected ` +
        `onto a wall; the planner should have skipped those grunts`,
    );

    console.log(
      `\n  ${sweepFires} grunt-sweep fire(s), 0 redirects; occlusion was live ` +
        `on the board — the sweep correctly skipped grunts hidden by walls`,
    );
  },
);
