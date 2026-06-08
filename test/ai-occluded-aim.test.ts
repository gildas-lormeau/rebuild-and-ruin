/**
 * Behavioral proof of the AI aim-occlusion rule: when a grunt sits just north
 * of a wall, the wall is on the camera-near (south) side under the battle tilt
 * and visually hides the grunt — so the AI's aim is redirected onto the wall
 * (it can't target a tile a human's pointer couldn't reach either).
 *
 * We observe it through the fire-decision diag, which now carries the
 * `intendedTarget` (pre-occlusion, the tile the planner wanted) alongside the
 * `aimTarget` (post-occlusion `FireIntent`). The impact tile is joined from the
 * `CANNON_FIRED` bus event, which fires synchronously just before the diag in
 * the same sim tick. A redirect is: intended ≠ aim, the intended tile held a
 * grunt, and the aim landed on a wall — i.e. the AI tried for the grunt and hit
 * the wall in front of it instead.
 *
 * Run with: deno test --no-check test/ai-occluded-aim.test.ts
 */

import { assert } from "@std/assert";
import { setAiBattleDiagHook } from "../src/ai/ai-battle-diag.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { TilePos } from "../src/shared/core/geometry-types.ts";
import { packTile } from "../src/shared/core/spatial.ts";
import { createScenario } from "./scenario.ts";

interface Redirect {
  round: number;
  intended: TilePos;
  aim: TilePos;
  impact: TilePos | undefined;
}

Deno.test(
  "AI aim-occlusion: a grunt hidden by a camera-near wall redirects the AI's aim onto the wall",
  async () => {
    using sc = await createScenario({ seed: 4, mode: "modern", rounds: 6 });

    const redirects: Redirect[] = [];
    let lastImpact: TilePos | undefined;

    // CANNON_FIRED fires synchronously right before the fire-decision diag in
    // the same tick, so the most recent one is this shot's landing tile.
    sc.bus.on(GAME_EVENT.CANNON_FIRED, (ev) => {
      lastImpact = { row: ev.impactRow, col: ev.impactCol };
    });

    setAiBattleDiagHook((ev) => {
      const intended = ev.intendedTarget;
      const aim = ev.aimTarget;
      if (!intended || !aim) return;
      if (intended.row === aim.row && intended.col === aim.col) return;
      // The intended tile must have held a grunt (the AI's real target) …
      const intendedGrunt = sc.state.grunts.some(
        (g) => g.row === intended.row && g.col === intended.col,
      );
      // … and the aim must have snapped onto a wall (the occluder in front).
      const aimIsWall = sc.state.players.some((player) =>
        player.walls.has(packTile(aim.row, aim.col)),
      );
      if (!intendedGrunt || !aimIsWall) return;
      redirects.push({ round: sc.state.round, intended, aim, impact: lastImpact });
    });

    try {
      sc.runGame({ timeoutMs: 450_000 });
    } finally {
      setAiBattleDiagHook(undefined);
    }

    assert(
      redirects.length > 0,
      "expected at least one occlusion redirect: the AI aimed at a grunt hidden " +
        "by a camera-near wall and its shot snapped onto the wall instead",
    );

    // The occluding wall sits exactly one tile camera-near (south, row+1) of the
    // grunt, in the same column (pitch is X-only) — the wall-height geometry.
    for (const r of redirects) {
      assert(
        r.aim.row === r.intended.row + 1 && r.aim.col === r.intended.col,
        `occluder should be one tile south of the grunt in the same column: ` +
          `grunt ${JSON.stringify(r.intended)} → aim ${JSON.stringify(r.aim)}`,
      );
    }

    const first = redirects[0]!;
    console.log(
      `\n  ${redirects.length} occlusion redirect(s). First: r${first.round} ` +
        `grunt(${first.intended.row},${first.intended.col}) → ` +
        `aim wall(${first.aim.row},${first.aim.col}); ball landed at ` +
        `(${first.impact?.row},${first.impact?.col})`,
    );
  },
);
