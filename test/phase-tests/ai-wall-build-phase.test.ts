import { assert, assertEquals, assertGreater } from "@std/assert";
import roundTwoDefault from "./fixtures/wall-build/round2-default.json" with {
  type: "json",
};
import roundTwoWithEdgeGrunts from "./fixtures/wall-build/round2-with-edge-grunts.json" with {
  type: "json",
};
import roundTwoWholeZoneWithHoles from "./fixtures/wall-build/round2-whole-zone-with-holes-castles.json" with {
  type: "json",
};
import roundTwoWholeZoneMoreHoles from "./fixtures/wall-build/round2-whole-zone-more-holes.json" with {
  type: "json",
};
import roundOneGoldCluster574812 from "./fixtures/wall-build/round1-gold-cluster-574812.json" with {
  type: "json",
};
import { GAME_EVENT } from "../../src/shared/core/game-event-bus.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import { packTile } from "../../src/shared/core/spatial.ts";
import { createPhaseScenario } from "./loader.ts";
import type { FixtureFile } from "./types.ts";
import { waitForPhase } from "../scenario.ts";

Deno.test("phase-test: wall-build round-2 fixture lands at WALL_BUILD", async () => {
  const sc = await createPhaseScenario(roundTwoDefault as unknown as FixtureFile);
  assertEquals(sc.state.round, 2);
  assertEquals(sc.state.phase, Phase.WALL_BUILD);
});

Deno.test("phase-test: 10 fixture-authored edge grunts move during WALL_BUILD", async () => {
  const fixture = roundTwoWithEdgeGrunts as unknown as FixtureFile;
  // Hard-encode the contract: the fixture must declare exactly 10 grunts.
  // If a future re-bake changes the count, this assertion fails loud and
  // the test author updates the expected number deliberately.
  assertEquals(fixture.grunts?.length, 10);

  const sc = await createPhaseScenario(fixture);

  // Track the fixture's authored grunt tiles. Snapshot grunts (already in
  // the captured FullStateMessage) may legitimately "stay put" if adjacent
  // to their target tower or boxed in by walls — they're not the subject
  // of this test.
  const authoredKeys = new Set(
    fixture.grunts!.map(({ row, col }) => packTile(row, col)),
  );

  // Drive through WALL_BUILD round 2 to CANNON_PLACE round 3 (the next
  // observable phase boundary).
  waitForPhase(sc, Phase.CANNON_PLACE);
  assertEquals(sc.state.round, 3);

  // Surviving grunts still on one of the authored tiles = an authored
  // grunt that never moved.
  const stuckAuthored = sc.state.grunts.filter((grunt) =>
    authoredKeys.has(packTile(grunt.row, grunt.col)),
  );
  const vacatedAuthoredTiles = authoredKeys.size - stuckAuthored.length;

  // Every authored grunt either MOVED or was KILLED (enclosed by mid-build
  // territory change, swept by sweepMisplacedGrunts). What we forbid: an
  // alive grunt still sitting on its injection tile after the entire phase.
  assertEquals(
    stuckAuthored.length,
    0,
    `${stuckAuthored.length}/${authoredKeys.size} authored grunts never moved during WALL_BUILD`,
  );
  // Sanity: at least one authored tile got vacated. Otherwise "0 stuck"
  // could mask a regression where authoring stops working.
  assertGreater(vacatedAuthoredTiles, 0, "no authored tile was vacated");
});

Deno.test("phase-test: AI repairs the outer ring with EXTRA holes (4 per player) — KNOWN FAILING", async () => {
  // Variant of the whole-zone fixture with 4 additional perimeter holes per
  // player ring (vs the original 1-2). Mirrors the post-demolition + minor
  // battle damage scenario: the demolition upgrade strips inner walls (only
  // outer shell remains) and battle then punches a handful of holes in that
  // shell. With 3+ unowned-alive towers inside each player's interior, the
  // AI's trySecondaryTower can be tempted to build "small castles inside the
  // existing one" rather than repair the outer perimeter. This test asserts
  // the same invariants as the basic 1-2-hole variant.
  //
  // KNOWN FAILING (2026-05-24): root cause investigation (see memory
  // `project_ai_build_stall_investigation`) confirmed two compounding
  // issues — (a) `findOuterRingHoles` cardinal-pair scan misses diagonal-
  // step corner breaches (single removed corner wall orphans cardinally-
  // distant ring walls), so (9,11) is undetected; (b) attempts to add
  // diagonal-pair detection regressed the survival suite by +22 stalls
  // because the detection fires on isolated diamond patterns + AI-placed
  // wall clusters elsewhere. Phase tests aren't in pre-commit fast-tests
  // so this red state doesn't block work.
  const sc = await createPhaseScenario(
    roundTwoWholeZoneMoreHoles as unknown as FixtureFile,
  );

  const wallsBefore = sc.state.players.map((player) => player.walls.size);
  waitForPhase(sc, Phase.CANNON_PLACE, { timeoutMs: 60_000 });
  assertEquals(sc.state.round, 3);

  for (const player of sc.state.players) {
    if (player.eliminated) continue;
    const homeTower = player.homeTower;
    if (!homeTower) {
      throw new Error(`player ${player.id} should have a home tower`);
    }
    assert(
      player.ownedTowers.includes(homeTower),
      `player ${player.id} home tower should be re-enclosed after WALL_BUILD`,
    );
    assertGreater(
      player.interior.size,
      80,
      `player ${player.id} interior=${player.interior.size} — AI retreated ` +
        `to an inner castle instead of repairing the outer ring (+4 holes variant)`,
    );
    const before = wallsBefore[player.id]!;
    const retained = player.walls.size / before;
    assertGreater(
      retained,
      0.8,
      `player ${player.id} retained ${player.walls.size}/${before} walls — ` +
        `AI abandoned the outer ring and the sweep destroyed it (+4 holes variant)`,
    );
  }
});

Deno.test("phase-test: AI repairs the existing outer ring instead of retreating to an inner castle", async () => {
  // Fixture: each of 3 players has a whole-zone wall ring with 1-2 hand-punched
  // holes (see scripts/fixture-tui.ts `x` key). Repairing the outer ring is
  // worth ~150+ interior tiles; retreating to the ideal small castle around
  // the home tower only encloses ~35 tiles AND triggers the end-of-build
  // territory sweep, which destroys every outer wall tile that no longer
  // bounds an enclosed region. The current AI does the inner-retreat for two
  // of three players, losing ~60% of their existing wall investment.
  const sc = await createPhaseScenario(
    roundTwoWholeZoneWithHoles as unknown as FixtureFile,
  );

  // Snapshot wall counts before WALL_BUILD so we can verify the AI didn't
  // demolish the outer ring by abandoning it.
  const wallsBefore = sc.state.players.map((player) => player.walls.size);

  // Drive to the next CANNON_PLACE — territory finalization + wall sweep
  // both run during the transition out of WALL_BUILD.
  waitForPhase(sc, Phase.CANNON_PLACE, { timeoutMs: 60_000 });
  assertEquals(sc.state.round, 3);

  for (const player of sc.state.players) {
    if (player.eliminated) continue;
    const homeTower = player.homeTower;
    if (!homeTower) {
      throw new Error(`player ${player.id} should have a home tower`);
    }
    assert(
      player.ownedTowers.includes(homeTower),
      `player ${player.id} home tower should be re-enclosed after WALL_BUILD`,
    );
    // Whole-zone fixture: real repair preserves an interior of >100 tiles.
    // Inner-castle retreat collapses to ~36 (the ideal createCastle() rect).
    // Pick 80 as the threshold — well above the inner-castle interior, well
    // below the typical whole-zone interior (150-200).
    assertGreater(
      player.interior.size,
      80,
      `player ${player.id} interior=${player.interior.size} — AI retreated ` +
        `to an inner castle instead of repairing the outer ring`,
    );
    // Repairing the outer ring should ADD walls (filling holes). Inner-retreat
    // strands the outer walls and the territory sweep deletes them. A ≥80%
    // retention threshold catches the catastrophic loss while leaving room
    // for the few outer-ring tiles that may genuinely get pruned (e.g.
    // dead-end spurs).
    const before = wallsBefore[player.id]!;
    const retained = player.walls.size / before;
    assertGreater(
      retained,
      0.8,
      `player ${player.id} retained ${player.walls.size}/${before} walls — ` +
        `AI abandoned the outer ring and the sweep destroyed it`,
    );
  }
});

Deno.test(
  "phase-test: AI merges cluster (T8+T10+T11) without internal divider walls (seed 574812 GOLD r1) — KNOWN FAILING",
  async () => {
    // Seed 574812, modern, round 1. GOLD's zone has three alive towers close
    // together south-east of home: T8 (21,13) = home, T11 (19,19), T10 (23,23).
    // T11 and T10's natural castleRects overlap by 2×2 at rows 22 col 21–22,
    // but neither rect's wall ring aligns with the other's. The current AI
    // builds T11 first (east wall at col 23), then commits to T10 (west wall
    // at col 20) — the col-20 walls become a stranded interior divider, and
    // cols 22–23 + 25–26 end up as doubled walls. 21 placements, ~6 wasted.
    //
    // KNOWN FAILING (2026-05-24): two fixes attempted and both reverted.
    // (a) castleRect pass-through for unenclosed-same-zone towers — didn't
    // trigger because T10 sits diagonally to T11, not on any of T11's per-
    // side expansion axes (`maxMarginForSide` samples self's rows/cols).
    // (b) cluster-merging in `trySecondaryTower` (bounding union of
    // overlapping natural rects, water-aware clamp) — committed to a merged
    // ring of ~36 cells that the AI couldn't close in one build phase,
    // regressing from 3 towers enclosed to 1. Phase tests aren't in
    // pre-commit fast-tests so this red state doesn't block work.
    //
    // Future fix direction: align T11's east wall and T10's west wall to
    // share a column (somewhere between 20 and 23) so two adjacent rings
    // share a real wall instead of producing parallel walls. This requires
    // peer-aware rect-side shifting, not full merging — and the change must
    // gate on wall-budget feasibility so we don't regress survival.
    const sc = await createPhaseScenario(
      roundOneGoldCluster574812 as unknown as FixtureFile,
    );
    assertEquals(sc.state.round, 1);
    assertEquals(sc.state.phase, Phase.WALL_BUILD);

    const GOLD_SLOT = 2;
    const gold = sc.state.players[GOLD_SLOT]!;
    const wallsBefore = gold.walls.size;

    // The three alive towers we expect GOLD to enclose by end of WALL_BUILD.
    const ALIVE_GOLD_TOWERS = [8, 10, 11] as const;

    // Drive to round end. With rounds: 1 the game doesn't transition out of
    // WALL_BUILD — ROUND_END fires once the sweep + score finalization run.
    let roundEnded = false;
    sc.bus.on(GAME_EVENT.ROUND_END, () => {
      roundEnded = true;
    });
    sc.runUntil(
      () => roundEnded || sc.state.phase !== Phase.WALL_BUILD,
      { timeoutMs: 60_000 },
    );

    const goldEnd = sc.state.players[GOLD_SLOT]!;
    const ownedTowerIndices = new Set<number>(
      goldEnd.ownedTowers.map((t) => t.index as unknown as number),
    );
    for (const idx of ALIVE_GOLD_TOWERS) {
      assert(
        ownedTowerIndices.has(idx),
        `GOLD should enclose tower ${idx} by end of WALL_BUILD ` +
          `(owned=${[...ownedTowerIndices].join(",")})`,
      );
    }

    // Pre-fix produces walls at (21,20)..(26,20) — the stranded internal
    // divider between T11's tentative east-wall and T10's later west-wall.
    // A merged rect puts col 20 well inside the interior, so there should
    // be NO GOLD wall at any of these tiles. This is the load-bearing
    // behavioral assertion — it FAILS pre-fix, PASSES post-fix.
    const DIVIDER_TILES = [
      [21, 20],
      [22, 20],
      [23, 20],
      [24, 20],
      [25, 20],
      [26, 20],
    ] as const;
    const goldWalls = goldEnd.walls;
    const stranded = DIVIDER_TILES.filter(([r, c]) =>
      goldWalls.has(packTile(r, c)),
    );
    assertEquals(
      stranded.length,
      0,
      `GOLD placed stranded divider walls at ${stranded
        .map(([r, c]) => `(${r},${c})`)
        .join(", ")} — AI built two adjacent rings instead of one merged rect`,
    );

    // Sanity: the merged rect should use FEWER walls than the pre-fix
    // double-ring layout (21 placed pre-fix). Bound it loosely at 18 to
    // catch a regression where the fix collapses to a tiny inner castle
    // (which would also reduce wall count).
    const wallsPlaced = goldEnd.walls.size - wallsBefore;
    assert(
      wallsPlaced <= 18,
      `GOLD placed ${wallsPlaced} walls (pre-fix baseline 21) — merged ` +
        `rect should need fewer pieces; check whether AI fell back to inner castle`,
    );
  },
);
