import { assertEquals, assertGreater } from "@std/assert";
import roundTwoDefault from "./fixtures/wall-build/round2-default.json" with {
  type: "json",
};
import { TOWER_SIZE } from "../../src/shared/core/game-constants.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS, Tile } from "../../src/shared/core/grid.ts";
import { packTile } from "../../src/shared/core/spatial.ts";
import type { GameState } from "../../src/shared/core/types.ts";
import { applyGruntOverrides, createPhaseScenario } from "./loader.ts";
import type { FixtureFile } from "./types.ts";
import { waitForPhase } from "../scenario.ts";

Deno.test("phase-test: wall-build round-2 fixture lands at WALL_BUILD", async () => {
  const sc = await createPhaseScenario(roundTwoDefault as FixtureFile);
  assertEquals(sc.state.round, 2);
  assertEquals(sc.state.phase, Phase.WALL_BUILD);
});

Deno.test("phase-test: grunts injected near map edges move during WALL_BUILD", async () => {
  const sc = await createPhaseScenario(roundTwoDefault as FixtureFile);

  // Pick edge positions that are grass + in a valid zone + not in any
  // player's interior. We avoid interiors so grunts aren't swept on the
  // first tick of WALL_BUILD (sweepMisplacedGrunts removes grunts on any
  // player's territory). Grunts that get enclosed *during* the phase
  // (because the AI walls them in) are an expected outcome we account for
  // in the assertion below.
  const positions = pickEdgeGruntPositions(sc.state, 10);
  assertEquals(
    positions.length,
    10,
    "expected to find 10 valid edge positions for grunt injection",
  );

  // Track ONLY the injected grunts by their initial tile keys. Pre-existing
  // grunts from the captured snapshot may legitimately "stay put" (adjacent
  // to their target tower, or boxed in by walls) — they're not the subject
  // of this test.
  const injectedKeys = new Set(
    positions.map(({ row, col }) => packTile(row, col)),
  );
  applyGruntOverrides(sc.state, positions);

  // Drive through WALL_BUILD round 2 to CANNON_PLACE round 3 (the next
  // observable phase boundary).
  waitForPhase(sc, Phase.CANNON_PLACE);
  assertEquals(sc.state.round, 3);

  // Surviving grunts still on one of the injected tiles = an injected
  // grunt that never moved. (A pre-existing grunt happening to share an
  // edge tile is excluded by `pickEdgeGruntPositions`, which dedupes
  // against `state.grunts`.) Grunts not in this set are either (a)
  // injected and moved, or (b) pre-existing grunts at their own tiles —
  // either way, not the subject of the assertion.
  const stuckInjected = sc.state.grunts.filter((grunt) =>
    injectedKeys.has(packTile(grunt.row, grunt.col)),
  );
  const vacatedInjectedTiles = injectedKeys.size - stuckInjected.length;

  // Every injected grunt either moved or got killed (enclosed by mid-build
  // territory change, swept by sweepMisplacedGrunts). What we forbid: an
  // alive grunt still sitting on its injection tile after the entire phase.
  assertEquals(
    stuckInjected.length,
    0,
    `${stuckInjected.length}/${injectedKeys.size} injected grunts never moved during WALL_BUILD`,
  );
  // Sanity: at least one injected tile got vacated. Otherwise "0 stuck"
  // would trivially pass with 0 injected grunts (defense against future
  // refactors silently dropping injection).
  assertGreater(vacatedInjectedTiles, 0, "no injected tile was vacated");
});

/** Scan the outer ring of the map for grass tiles in a valid zone that
 *  aren't already occupied by towers, walls, grunts, or any player's
 *  interior. Returns up to `count` positions. */
function pickEdgeGruntPositions(
  state: GameState,
  count: number,
): { row: number; col: number }[] {
  const occupied = collectOccupiedTiles(state);
  const positions: { row: number; col: number }[] = [];
  // Walk a 4-tile-deep edge band so we have enough candidates even when
  // the corners and immediate edges are water-heavy on a given seed.
  const RING_DEPTH = 4;
  for (let depth = 0; depth < RING_DEPTH && positions.length < count; depth++) {
    for (const { row, col } of perimeterTiles(depth)) {
      if (positions.length >= count) break;
      if (!isEdgeCandidate(state, occupied, row, col)) continue;
      positions.push({ row, col });
      occupied.add(packTile(row, col));
    }
  }
  return positions;
}

function isEdgeCandidate(
  state: GameState,
  occupied: ReadonlySet<number>,
  row: number,
  col: number,
): boolean {
  if (state.map.tiles[row]![col] !== Tile.Grass) return false;
  if (state.map.zones[row]![col] === 0) return false;
  return !occupied.has(packTile(row, col));
}

function collectOccupiedTiles(state: GameState): Set<number> {
  const occupied = new Set<number>();
  for (const tower of state.map.towers) {
    for (let dr = 0; dr < TOWER_SIZE; dr++) {
      for (let dc = 0; dc < TOWER_SIZE; dc++) {
        occupied.add(packTile(tower.row + dr, tower.col + dc));
      }
    }
  }
  for (const player of state.players) {
    for (const key of player.walls) occupied.add(key);
    for (const key of player.interior) occupied.add(key);
  }
  for (const grunt of state.grunts) {
    occupied.add(packTile(grunt.row, grunt.col));
  }
  return occupied;
}

/** Yield every tile at exactly `depth` from any edge of the grid (top,
 *  bottom, left, right). `depth=0` is the outermost ring. */
function* perimeterTiles(
  depth: number,
): Generator<{ row: number; col: number }> {
  const top = depth;
  const bottom = GRID_ROWS - 1 - depth;
  const left = depth;
  const right = GRID_COLS - 1 - depth;
  if (top > bottom || left > right) return;
  for (let col = left; col <= right; col++) yield { row: top, col };
  if (bottom !== top) {
    for (let col = left; col <= right; col++) yield { row: bottom, col };
  }
  for (let row = top + 1; row < bottom; row++) {
    yield { row, col: left };
    if (right !== left) yield { row, col: right };
  }
}
