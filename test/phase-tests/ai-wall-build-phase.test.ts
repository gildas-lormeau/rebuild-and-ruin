import { assertEquals, assertGreater } from "@std/assert";
import roundTwoDefault from "./fixtures/wall-build/round2-default.json" with {
  type: "json",
};
import roundTwoWithEdgeGrunts from "./fixtures/wall-build/round2-with-edge-grunts.json" with {
  type: "json",
};
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
