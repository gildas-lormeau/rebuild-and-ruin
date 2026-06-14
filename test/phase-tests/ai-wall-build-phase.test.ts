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
import roundOneRedFatWall40 from "./fixtures/wall-build/round1-red-fat-wall-40.json" with {
  type: "json",
};
import roundTwentyFourRedCornerOrphan26796 from "./fixtures/wall-build/round24-red-corner-orphan-26796.json" with {
  type: "json",
};
import roundTwentyEightRedHouses829597 from "./fixtures/wall-build/round28-red-houses-829597.json" with {
  type: "json",
};
import roundPits1 from "./fixtures/wall-build/round-pits-1.json" with {
  type: "json",
};
import roundPits2 from "./fixtures/wall-build/round-pits-2.json" with {
  type: "json",
};
import { GAME_EVENT } from "../../src/shared/core/game-event-bus.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS } from "../../src/shared/core/grid.ts";
import { packTile } from "../../src/shared/core/spatial.ts";
import { createPhaseScenario } from "./loader.ts";
import type { FixtureFile } from "./types.ts";
import { waitForPhase } from "../scenario.ts";

interface DoubledWallRun {
  orientation: "horizontal" | "vertical";
  row: number;
  col: number;
  length: number;
}

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
      player.enclosedTowers.includes(homeTower),
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
      player.enclosedTowers.includes(homeTower),
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
      goldEnd.enclosedTowers.map((t) => t.index as unknown as number),
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

Deno.test(
  "phase-test: AI doesn't build doubled walls when a secondary castle touches an already-enclosed castle (seed 40 RED r1)",
  async () => {
    // Seed 40, modern, round 1. RED's home is T0 @ (11,36); T3 @ (5,39) is
    // an alive secondary in the same zone, three tiles north of T0's natural
    // castleRect. CASTLE_SELECT auto-builds the T0 home castle; during the
    // closing WALL_BUILD the AI builds a second ring around T3 that abuts
    // T0's existing north wall. The shared north/south boundary lands one
    // tile apart, producing a visible 2×4 doubled wall (two parallel
    // horizontal walls 1 tile apart, 4 tiles long) — the "fat wall" the
    // user reported.
    //
    // PASSES since the 2026-05-27 fix: `tileCompletesFatRun` in
    // ai-build-score.ts + `FAT_WALL_RUN_PENALTY = 10_000` in
    // ai-strategy-build.ts hard-reject fat-run placements that don't close
    // gaps and heavily penalize gap-closing ones — enough to drive the
    // doubled-wall runs on this seed below the length-3 threshold the
    // assertion forbids, while preserving the interior (still ≥ 58). The
    // fuller fix is still peer-aware rect placement so T3's natural rect
    // doesn't force gap closures into T0's wall row at all (same direction
    // as the 574812 KNOWN FAILING test above), but it isn't needed for
    // these assertions to pass.
    const sc = await createPhaseScenario(
      roundOneRedFatWall40 as unknown as FixtureFile,
    );
    assertEquals(sc.state.round, 1);
    assertEquals(sc.state.phase, Phase.WALL_BUILD);

    const RED_SLOT = 0;
    let roundEnded = false;
    sc.bus.on(GAME_EVENT.ROUND_END, () => {
      roundEnded = true;
    });
    sc.runUntil(() => roundEnded || sc.state.phase !== Phase.WALL_BUILD, {
      timeoutMs: 60_000,
    });

    const red = sc.state.players[RED_SLOT]!;

    // Precondition: the test premise requires RED to have enclosed both
    // T0 (home) and a secondary tower. If the AI's behavior shifts and it
    // only encloses one tower, the doubled-wall pathology can't appear and
    // this test's assertion would pass for the wrong reason.
    assert(
      red.enclosedTowers.length >= 2,
      `RED should enclose 2+ towers (got ${red.enclosedTowers.length}) — ` +
        `test premise broken, re-record seed`,
    );

    // Load-bearing assertion: no parallel doubled-wall RUN of length ≥3.
    // A single 2×2 wall block is allowed (every wall ring's outer corners
    // form one when a horizontal segment meets a vertical segment). What
    // we forbid is the visible touching-castle pattern — two parallel
    // walls 1 tile apart over 3+ tiles, producing ## stacks (vertical run)
    // or #### / #### bars (horizontal run).
    const runs = findDoubledWallRuns(red.walls);
    assertEquals(
      runs.length,
      0,
      `RED has ${runs.length} parallel doubled-wall run(s): ${
        runs
          .map(
            (run) =>
              `${run.orientation} (${run.row},${run.col}) length=${run.length}`,
          )
          .join("; ")
      } — AI built a secondary ring parallel to the home castle's wall instead of sharing a column/row`,
    );
    // Interior-preservation guard: the fix must not "succeed" by collapsing
    // to a smaller enclosure. Baseline measured pre-fix on this seed was
    // interior=58 (RED enclosing T0 + T3 with the fat-wall geometry).
    // Sharing the boundary should grow the interior (the shifted side
    // absorbs one extra row/col); the assertion guards against a
    // degenerate "shrink the secondary's rect by 1 to leave a 2-tile gap"
    // fix that would lose tiles instead of sharing the wall.
    const BASELINE_INTERIOR = 58;
    assert(
      red.interior.size >= BASELINE_INTERIOR,
      `RED interior=${red.interior.size} shrank below baseline ` +
        `${BASELINE_INTERIOR} — fix must share the wall (grow or preserve ` +
        `interior), not retreat from it`,
    );
  },
);

Deno.test(
  "phase-test: AI re-encloses re-selected castle when corner gap is bordered by water + cannon (seed 26796 RED r24)",
  async () => {
    // Seed 26796, modern, r24 WALL_BUILD start. RED's castle was just re-
    // selected at (18,23) after r23 life loss. Auto-built ring (cols 21-28,
    // rows 15-22, 28 walls); CANNON_PLACE puts 4 cannons at the interior
    // corners (cannon@1 at (16,22) is the load-bearing one); r24 BATTLE
    // destroys 12 ring walls including a 4-wide top breach at (15,21-24)
    // and 3 wall gaps on each side wall. Entering WALL_BUILD with 16 walls.
    //
    // Pre-fix bug: piece 2 (1×2) chooses (17,21)+(18,21) over the equally-
    // gap-filling (15,21)+(15,22) because cursor proximity favors the
    // vertical placement. After that, cannon@1 at (16,22) + water at row
    // 14 cols 15-25 turn the corner span into structurally orphan tiles —
    // once either (15,21) or (15,22) is filled solo by a later 1×1, the
    // other becomes unfillable by any remaining piece in the bag. RED
    // builds 35 walls in 10 pieces but encloses zero towers, loses its
    // last life, gets eliminated. See `computeDifficultyBonus`.
    const sc = await createPhaseScenario(
      roundTwentyFourRedCornerOrphan26796 as unknown as FixtureFile,
    );
    assertEquals(sc.state.round, 24);
    assertEquals(sc.state.phase, Phase.WALL_BUILD);

    const RED_SLOT = 0;
    const redBefore = sc.state.players[RED_SLOT]!;
    const homeTowerIndex = redBefore.homeTower?.index;
    assert(homeTowerIndex !== undefined, "RED should have a home tower");

    // Wait for ROUND_END (fires at end of WALL_BUILD finalizeRound) rather
    // than the next CANNON_PLACE — at this snapshot RED has 1 life left and
    // BLUE is already eliminated, so if RED's last life is also lost during
    // finalizeRound, the game ends here (no round 25) and waitForPhase
    // would hang on a phase that never arrives.
    let roundEnded = false;
    sc.bus.on(GAME_EVENT.ROUND_END, () => {
      roundEnded = true;
    });
    sc.runUntil(
      () => roundEnded || sc.state.phase !== Phase.WALL_BUILD,
      { timeoutMs: 60_000 },
    );

    const red = sc.state.players[RED_SLOT]!;
    // Eliminated-after-WALL_BUILD = the bug fired: RED failed to enclose
    // the home castle and lost their last life during finalizeRound.
    assert(
      !red.eliminated,
      `RED was eliminated after r24 WALL_BUILD — AI failed to re-enclose ` +
        `the re-selected castle (home tower idx=${homeTowerIndex})`,
    );
    // Direct enclosure check: the home tower must be in enclosedTowers.
    const enclosedTowerIndices = new Set(
      red.enclosedTowers.map((tower) => tower.index as unknown as number),
    );
    assert(
      enclosedTowerIndices.has(homeTowerIndex as unknown as number),
      `RED home tower ${homeTowerIndex} not enclosed after WALL_BUILD ` +
        `(enclosed=${[...enclosedTowerIndices].join(",")})`,
    );
  },
);

Deno.test(
  "phase-test: BLUE seals its home ring ABOVE a burning-pit column (round-pits-1)",
  async () => {
    // A burning-pit column runs from a few tiles below BLUE's home tower down
    // to the map's bottom edge. The home IS enclosable — by a ring that seals
    // on the grass ABOVE the pit. Before the fix the AI expanded the ring DOWN
    // into the pit column (capped, leaving an unwallable pit on the ring) and
    // never closed; `clampRectOffPits` now seals above it.
    const sc = await createPhaseScenario(roundPits1 as unknown as FixtureFile);
    const blue = sc.state.players[1]!;
    const homeTower = blue.homeTower;
    if (!homeTower) throw new Error("BLUE should have a home tower");

    waitForPhase(sc, Phase.CANNON_PLACE, { timeoutMs: 60_000 });
    assertEquals(sc.state.round, 3);

    assertEquals(
      sc.state.players[1]!.lives,
      3,
      "BLUE should keep all 3 lives — it can enclose its home above the pit",
    );
    assert(
      sc.state.players[1]!.enclosedTowers.includes(homeTower),
      "BLUE home tower should be enclosed (ring sealed above the pit column)",
    );
  },
);

Deno.test(
  "phase-test: BLUE abandons an unenclosable home for a secondary tower (round-pits-2)",
  async () => {
    // Here the pit column is cardinally adjacent to BLUE's home tower AND
    // reaches the map edge, so NO ring can enclose the home. The AI must detect
    // this (`isTowerEnclosable` gate) and ring an enclosable secondary tower
    // instead — reusing the existing home wall as a shared boundary so the
    // secondary actually closes within the phase.
    const sc = await createPhaseScenario(roundPits2 as unknown as FixtureFile);
    const blue = sc.state.players[1]!;
    const homeTower = blue.homeTower;
    if (!homeTower) throw new Error("BLUE should have a home tower");

    waitForPhase(sc, Phase.CANNON_PLACE, { timeoutMs: 60_000 });
    assertEquals(sc.state.round, 3);

    assertEquals(
      sc.state.players[1]!.lives,
      3,
      "BLUE should keep all 3 lives by enclosing a secondary tower",
    );
    assertGreater(
      sc.state.players[1]!.enclosedTowers.length,
      0,
      "BLUE should enclose at least one (secondary) tower",
    );
    assert(
      !sc.state.players[1]!.enclosedTowers.includes(homeTower),
      "BLUE home tower is unenclosable here — survival must come from a secondary",
    );
  },
);

Deno.test(
  "phase-test: RED captures houses/grunts in the idle window once its castle is enclosed",
  async () => {
    // Seed 829597 r28: RED has all its zone towers enclosed early in the build
    // with un-enclosed houses, bonus squares, and pacing grunts just outside
    // its territory. Pre-fix, RED spent the whole idle window on aimless
    // uniform expansion (tryExpandTerritory) and captured NOTHING. The value-
    // ranked capture phase should wall a small pocket around the richest static
    // anchor (house / bonus square) and seal it, scooping up any grunts inside.
    // House/grunt enclosure is silent (house.alive flips / grunt removed), so
    // we count alive→dead house transitions minus the placed-ON-house path
    // (HOUSE_CRUSHED) plus GRUNTS_ENCLOSED events to measure genuine captures.
    const RED = 0;
    const sc = await createPhaseScenario(
      roundTwentyEightRedHouses829597 as unknown as FixtureFile,
    );
    assertEquals(sc.state.round, 28);
    assertEquals(sc.state.phase, Phase.WALL_BUILD);

    const aliveHouseKeysAtStart = sc.state.map.houses
      .filter((house) => house.alive)
      .map((house) => packTile(house.row, house.col));

    let placedOnHouse = 0;
    let gruntsEnclosed = 0;
    sc.bus.on(GAME_EVENT.HOUSE_CRUSHED, (ev) => {
      if (ev.playerId === RED) placedOnHouse++;
    });
    sc.bus.on(GAME_EVENT.GRUNTS_ENCLOSED, (ev) => {
      if (ev.playerId === RED) gruntsEnclosed += ev.count;
    });

    waitForPhase(sc, Phase.CANNON_PLACE, { timeoutMs: 120_000 });
    assertEquals(sc.state.round, 29);

    const houseStillAlive = new Set(
      sc.state.map.houses
        .filter((house) => house.alive)
        .map((house) => packTile(house.row, house.col)),
    );
    const housesDestroyed = aliveHouseKeysAtStart.filter(
      (key) => !houseStillAlive.has(key),
    ).length;
    const housesEnclosed = housesDestroyed - placedOnHouse;

    // Robust to how the value-rank splits between houses and grunt-rich pockets
    // (it may prefer a 1-house-3-grunt pocket over a 2-house pocket): assert the
    // COMBINED capture is non-zero. On unfixed HEAD this build captures nothing.
    assertGreater(
      housesEnclosed + gruntsEnclosed,
      0,
      `RED captured 0 (housesEnclosed=${housesEnclosed}, ` +
        `gruntsEnclosed=${gruntsEnclosed}, placed-on=${placedOnHouse}) — the ` +
        `idle-window capture phase sealed nothing; RED reverted to expansion`,
    );
  },
);

/** Find maximal axis-aligned 2×N or N×2 all-wall runs (N ≥ 3) in a single
 *  player's walls. Each run represents the visible "fat wall" pattern:
 *  two parallel walls 1 tile apart over 3+ consecutive tiles. Excludes the
 *  incidental 2×2 blocks that form at every wall-ring corner (those have
 *  N = 2 and are not flagged here). */
function findDoubledWallRuns(
  walls: ReadonlySet<number>,
): readonly DoubledWallRun[] {
  const runs: DoubledWallRun[] = [];
  for (let row = 0; row + 1 < GRID_ROWS; row++) {
    let start = -1;
    for (let col = 0; col <= GRID_COLS; col++) {
      const doubled =
        col < GRID_COLS &&
        walls.has(packTile(row, col)) &&
        walls.has(packTile(row + 1, col));
      if (doubled) {
        if (start < 0) start = col;
      } else if (start >= 0) {
        const length = col - start;
        if (length >= 3) {
          runs.push({ orientation: "horizontal", row, col: start, length });
        }
        start = -1;
      }
    }
  }
  for (let col = 0; col + 1 < GRID_COLS; col++) {
    let start = -1;
    for (let row = 0; row <= GRID_ROWS; row++) {
      const doubled =
        row < GRID_ROWS &&
        walls.has(packTile(row, col)) &&
        walls.has(packTile(row, col + 1));
      if (doubled) {
        if (start < 0) start = row;
      } else if (start >= 0) {
        const length = row - start;
        if (length >= 3) {
          runs.push({ orientation: "vertical", row: start, col, length });
        }
        start = -1;
      }
    }
  }
  return runs;
}
