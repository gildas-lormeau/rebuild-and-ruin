/**
 * Behavioral spec for the blocked-cut rescue in the AI enclosure planner:
 * when a tower's min-cut lands on tiles no piece can legally fill (a
 * stationary grunt parks on the only cut tile and the one-step interior
 * plugs are unwallable too), the planner must not abandon the tower — a
 * footprint-tight retry cut that treats grunt tiles as uncuttable finds the
 * legal seal the rect-interior protection was hiding.
 *
 * Probed seed (tmp/trace-806463.log): seed 806463 modern, round 1 closing
 * WALL_BUILD. RED's second tower T3 (2x2 at row 6, col 8) has cut {(7,12)}
 * — grunt-occupied, rejected by canPlacePiece; the sole 8-neighbour plug
 * (6,11) is an alive house. A single 1x1 at (6,10) seals T3 (verified by
 * tmp/verify-seals-806463.ts), but that tile is rect-interior-protected and
 * invisible to the normal cut. Spec: RED ends round 1 with T3 enclosed.
 *
 * Run with: deno test --no-check test/ai-blocked-cut-rescue.test.ts
 */

import { assert } from "@std/assert";
import { Phase } from "../src/shared/core/game-phase.ts";
import { createScenario, waitForPhase } from "./scenario.ts";

Deno.test(
  "AI blocked-cut rescue: encloses a tower whose only cut tile is grunt-occupied",
  async () => {
    using sc = await createScenario({ seed: 806463, mode: "modern", rounds: 1 });

    waitForPhase(sc, Phase.ROUND_END, { timeoutMs: 120_000 });

    const red = sc.state.players[0]!;
    const enclosed = red.enclosedTowers.map((tower) => tower.index);
    assert(
      enclosed.some((idx) => idx === 3),
      `RED must enclose T3 by round 1's end (a 1x1 at (6,10) seals it); ` +
        `enclosed=[${enclosed.join(",")}]`,
    );
  },
);
