import { assert, assertEquals, assertGreater } from "@std/assert";
import roundOneDefault from "./fixtures/cannon-place/round1-default.json" with {
  type: "json",
};
import roundOneWithExtraHouses from "./fixtures/cannon-place/round1-with-extra-houses.json" with {
  type: "json",
};
import roundOneWithExtraBonuses from "./fixtures/cannon-place/round1-with-extra-bonuses.json" with {
  type: "json",
};
import roundOneWithWalls from "./fixtures/cannon-place/round1-with-walls.json" with {
  type: "json",
};
import roundTwoThree10x10Castles from "./fixtures/cannon-place/round2-three-10x10-castles.json" with {
  type: "json",
};
import roundTwoWholeZoneMultiTowers from "./fixtures/cannon-place/round2-whole-zone-multi-towers.json" with {
  type: "json",
};
import {
  applyBonusSquareOverrides,
  applyHouseOverrides,
  applyWallOverrides,
  createPhaseScenario,
  recomputeFixtureDerivedState,
} from "./loader.ts";
import { packTile, unpackTile } from "../../src/shared/core/spatial.ts";
import type { TileKey } from "../../src/shared/core/grid.ts";
import { cannonModeDef } from "../../src/shared/core/cannon-mode-defs.ts";
import type { FixtureFile } from "./types.ts";
import { waitForPhase } from "../scenario.ts";
import { Phase } from "../../src/shared/core/game-phase.ts";

Deno.test("phase-test: cannon-place round-1 fixture lands at CANNON_PLACE with castles built", async () => {
  const sc = await createPhaseScenario(roundOneDefault as FixtureFile);

  assertEquals(sc.state.phase, Phase.CANNON_PLACE);
  assertGreater(sc.state.players.length, 0);
  for (const player of sc.state.players) {
    assert(
      player.castleWallTiles.size > 0,
      `Player ${player.id} should have a castle after the AI-driven CASTLE_SELECT`,
    );
  }
});

Deno.test("phase-test: AI places every cannon inside its own enclosed interior", async () => {
  const sc = await createPhaseScenario(roundOneDefault as FixtureFile);
  // Drive the AI through CANNON_PLACE — entering BATTLE is the signal that
  // every active player finished placement.
  waitForPhase(sc, Phase.BATTLE);

  let totalCannons = 0;
  for (const player of sc.state.players) {
    if (player.eliminated) continue;
    for (const cannon of player.cannons) {
      totalCannons++;
      const size = cannonModeDef(cannon.mode).size;
      for (let dr = 0; dr < size; dr++) {
        for (let dc = 0; dc < size; dc++) {
          const key = packTile(cannon.row + dr, cannon.col + dc);
          assert(
            player.interior.has(key),
            `player ${player.id} cannon at (${cannon.row},${cannon.col}) ` +
              `mode=${cannon.mode} has footprint tile (${cannon.row + dr},${cannon.col + dc}) ` +
              `that is NOT inside the player's interior`,
          );
        }
      }
    }
  }
  assertGreater(totalCannons, 0, "expected at least one cannon to be placed");
});

Deno.test("phase-test: cannon-place round-1 fixture progresses to BATTLE under AI", async () => {
  const sc = await createPhaseScenario(roundOneDefault as FixtureFile);

  const ev = waitForPhase(sc, Phase.BATTLE);
  assertEquals(ev.phase, Phase.BATTLE);
  for (const player of sc.state.players) {
    assertGreater(
      player.cannons.length,
      0,
      `Player ${player.id} should have placed at least one cannon`,
    );
  }
});

Deno.test("phase-test: fixture with house overrides appends them to state.map.houses", async () => {
  const baseline = await createPhaseScenario(roundOneDefault as FixtureFile);
  const baselineHouseCount = baseline.state.map.houses.length;
  const baselineVersion = baseline.state.map.mapVersion;

  const sc = await createPhaseScenario(
    roundOneWithExtraHouses as FixtureFile,
  );
  assertEquals(
    sc.state.map.houses.length,
    baselineHouseCount + 2,
    "two extra houses should be appended on top of the seed-generated set",
  );
  assertGreater(
    sc.state.map.mapVersion,
    baselineVersion,
    "mapVersion should bump so the render terrain cache reloads",
  );
  for (const override of roundOneWithExtraHouses.houses) {
    const found = sc.state.map.houses.find(
      (house) => house.row === override.row && house.col === override.col,
    );
    assert(
      found !== undefined,
      `override at (${override.row},${override.col}) should appear in state.map.houses`,
    );
    assertEquals(found!.alive, true);
  }
});

Deno.test("phase-test: applyHouseOverrides rejects out-of-bounds positions", async () => {
  const sc = await createPhaseScenario(roundOneDefault as FixtureFile);
  let threw = false;
  try {
    applyHouseOverrides(sc.state, [{ row: -1, col: 0 }]);
  } catch (err) {
    threw = true;
    assert(err instanceof Error && err.message.includes("out of bounds"));
  }
  assert(threw, "expected applyHouseOverrides to throw on out-of-bounds row");
});

Deno.test("phase-test: applyHouseOverrides rejects tower-overlapping positions", async () => {
  const sc = await createPhaseScenario(roundOneDefault as FixtureFile);
  const tower = sc.state.map.towers[0]!;
  let threw = false;
  try {
    applyHouseOverrides(sc.state, [{ row: tower.row, col: tower.col }]);
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && err.message.includes("tower"),
      `expected tower-overlap error, got: ${(err as Error).message}`,
    );
  }
  assert(threw, "expected applyHouseOverrides to throw on tower overlap");
});

Deno.test("phase-test: fixture with bonus-square overrides appends them to state.bonusSquares", async () => {
  const baseline = await createPhaseScenario(roundOneDefault as FixtureFile);
  const baselineBonusCount = baseline.state.bonusSquares.length;

  const sc = await createPhaseScenario(
    roundOneWithExtraBonuses as FixtureFile,
  );
  assertEquals(
    sc.state.bonusSquares.length,
    baselineBonusCount + 2,
    "two extra bonus squares should be appended on top of the seed-generated set",
  );
  for (const override of roundOneWithExtraBonuses.bonusSquares) {
    const found = sc.state.bonusSquares.find(
      (bonus) => bonus.row === override.row && bonus.col === override.col,
    );
    assert(
      found !== undefined,
      `override at (${override.row},${override.col}) should appear in state.bonusSquares`,
    );
  }
});

Deno.test("phase-test: applyBonusSquareOverrides rejects duplicate of an existing bonus", async () => {
  const sc = await createPhaseScenario(roundOneDefault as FixtureFile);
  const seedBonus = sc.state.bonusSquares[0]!;
  let threw = false;
  try {
    applyBonusSquareOverrides(sc.state, [
      { row: seedBonus.row, col: seedBonus.col },
    ]);
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && err.message.includes("duplicates"),
      `expected dedupe error, got: ${(err as Error).message}`,
    );
  }
  assert(threw, "expected applyBonusSquareOverrides to throw on duplicate");
});

Deno.test("phase-test: fixture with wall overrides appends them to the owner's player.walls", async () => {
  const sc = await createPhaseScenario(roundOneWithWalls as FixtureFile);

  for (const override of roundOneWithWalls.walls) {
    const player = sc.state.players[override.ownerId]!;
    const key = packTile(override.row, override.col);
    assert(
      player.walls.has(key),
      `wall (${override.row},${override.col}) should be in player ${override.ownerId}'s walls`,
    );
  }
});

Deno.test("phase-test: applyWallOverrides rejects ownerId outside the player range", async () => {
  const sc = await createPhaseScenario(roundOneDefault as FixtureFile);
  let threw = false;
  try {
    applyWallOverrides(sc.state, [
      { row: 0, col: 8, ownerId: sc.state.players.length },
    ]);
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && err.message.includes("invalid ownerId"),
      `expected ownerId error, got: ${(err as Error).message}`,
    );
  }
  assert(threw, "expected applyWallOverrides to reject out-of-range ownerId");
});

Deno.test("phase-test: applyWallOverrides rejects duplicate against any player's existing walls", async () => {
  const sc = await createPhaseScenario(roundOneDefault as FixtureFile);
  applyWallOverrides(sc.state, [{ row: 0, col: 8, ownerId: 0 }]);

  let threw = false;
  try {
    applyWallOverrides(sc.state, [{ row: 0, col: 8, ownerId: 1 }]);
  } catch (err) {
    threw = true;
    assert(
      err instanceof Error && err.message.includes("duplicates"),
      `expected dedupe error, got: ${(err as Error).message}`,
    );
  }
  assert(threw, "expected applyWallOverrides to reject duplicate wall");
});

Deno.test("phase-test: recomputeFixtureDerivedState lets the runtime tick after wall additions", async () => {
  const sc = await createPhaseScenario(roundOneWithWalls as FixtureFile);
  recomputeFixtureDerivedState(sc.state);

  // Advance into BATTLE — without recompute, assertInteriorFresh would fire
  // the first time a battle handler reads any player's interior.
  const ev = waitForPhase(sc, Phase.BATTLE);
  assertEquals(ev.phase, Phase.BATTLE);
});

Deno.test("phase-test: AI cannon placement prefers tower side over wall side in 3-tile-gap castles", async () => {
  // Double-cast: the checkpoint's `homeTowerIdx` field is a branded TowerIdx
  // in the type but lands as a bare number from JSON.
  const sc = await createPhaseScenario(
    roundTwoThree10x10Castles as unknown as FixtureFile,
  );
  waitForPhase(sc, Phase.BATTLE);

  let wallSide = 0;
  let towerSide = 0;
  let neutral = 0;
  const perPlayer: { id: number; wall: number; tower: number; eq: number }[] =
    [];

  for (const player of sc.state.players) {
    if (player.eliminated) continue;
    const towerTiles = new Set<TileKey>();
    for (const tower of player.enclosedTowers) {
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          towerTiles.add(packTile(tower.row + dr, tower.col + dc));
        }
      }
    }

    let pWall = 0;
    let pTower = 0;
    let pEq = 0;
    for (const cannon of player.cannons) {
      const size = cannonModeDef(cannon.mode).size;
      let minWall = Infinity;
      let minTower = Infinity;
      for (let dr = 0; dr < size; dr++) {
        for (let dc = 0; dc < size; dc++) {
          const cr = cannon.row + dr;
          const cc = cannon.col + dc;
          for (const wallKey of player.walls) {
            const { row, col } = unpackTile(wallKey);
            const distance = Math.abs(cr - row) + Math.abs(cc - col);
            if (distance < minWall) minWall = distance;
          }
          for (const towerKey of towerTiles) {
            const { row, col } = unpackTile(towerKey);
            const distance = Math.abs(cr - row) + Math.abs(cc - col);
            if (distance < minTower) minTower = distance;
          }
        }
      }
      if (minWall < minTower) {
        wallSide++;
        pWall++;
      } else if (minTower < minWall) {
        towerSide++;
        pTower++;
      } else {
        neutral++;
        pEq++;
      }
    }
    perPlayer.push({ id: player.id, wall: pWall, tower: pTower, eq: pEq });
  }

  // The AI should not systematically prefer wall-adjacent placements when
  // an equally legal tower-adjacent placement exists. A balanced or
  // tower-leaning distribution is the desired behavior.
  assert(
    towerSide >= wallSide,
    `AI prefers wall side: ${wallSide} cannons closer to wall, ` +
      `${towerSide} closer to tower, ${neutral} equidistant. ` +
      `Per-player: ${JSON.stringify(perPlayer)}`,
  );
});

Deno.test("phase-test: AI clusters cannons near owned towers in a multi-tower whole-zone enclosure", async () => {
  // Fixture: player 0 has a single enclosure spanning the whole zone, with
  // 4 owned towers spread across it. cannonLimits[0] is bumped so the AI
  // fills the interior. Without a sufficient pull toward towers, the AI
  // drifts placements toward the geometric center of the enclosure instead
  // of clustering around the towers — which leaves towers under-defended
  // and clogs the middle.
  const sc = await createPhaseScenario(
    roundTwoWholeZoneMultiTowers as unknown as FixtureFile,
  );
  waitForPhase(sc, Phase.BATTLE);

  const player = sc.state.players[0]!;
  assertEquals(
    player.cannons.length,
    20,
    `expected AI to place all 20 cannons (cannonLimits=20)`,
  );
  assertGreater(
    player.enclosedTowers.length,
    1,
    `fixture should give player 0 multiple owned towers, got ${player.enclosedTowers.length}`,
  );

  const towerCenters = player.enclosedTowers.map((tower) => ({
    row: tower.row + 1,
    col: tower.col + 1,
  }));

  const distances: number[] = [];
  for (const cannon of player.cannons) {
    const cRow = cannon.row + 1;
    const cCol = cannon.col + 1;
    let nearest = Infinity;
    for (const tc of towerCenters) {
      const distance = Math.abs(cRow - tc.row) + Math.abs(cCol - tc.col);
      if (distance < nearest) nearest = distance;
    }
    distances.push(nearest);
  }
  distances.sort((a, b) => a - b);
  const totalDistance = distances.reduce((sum, distance) => sum + distance, 0);
  const avg = totalDistance / distances.length;
  const max = distances[distances.length - 1]!;

  // No cannon should be more than 5 Manhattan tiles from its nearest owned
  // tower's center. With TOWER_DISTANCE_MULTIPLIER too low the AI drifts
  // cannons into the geometric middle of the enclosure, producing outliers
  // at distance 6+.
  assert(
    max <= 5,
    `AI drifts a cannon away from any tower: max=${max} avg=${avg.toFixed(2)} ` +
      `sorted=[${distances.join(",")}]`,
  );
  // Tighter signal: average distance must stay below the broken-baseline
  // (~3.40 at multiplier=2/8). The fixed behavior settles around 3.1.
  assert(
    avg <= 3.3,
    `AI cannons drift away from towers on average: avg=${avg.toFixed(2)} ` +
      `max=${max} sorted=[${distances.join(",")}]`,
  );
});

Deno.test("phase-test: AI leaves a buildable divider seam between adjacent towers in one enclosure", async () => {
  // Same whole-zone multi-tower fixture as the clustering test. Clustering
  // cannons tightly around towers (the test above) is correct for DEFENSE,
  // but if the cannon clusters of two adjacent towers MERGE they form a solid
  // "cannon wall" spanning the interior (TT CCCC..CCCC TT). That seals off
  // compartmentalization: when the big enclosure is later breached, the AI
  // can't build an internal divider to split it into two per-tower castles
  // because cannons occupy every tile of every candidate divider lane.
  //
  // Invariant: between the two CLOSEST enclosed towers there must remain at
  // least one buildable divider lane — a straight interior column or row,
  // strictly between them, spanning the enclosure with no cannon (or tower)
  // tile on it, so a future wall could split the castle there. Pre-fix this
  // FAILS: the merged clusters block every lane.
  const sc = await createPhaseScenario(
    roundTwoWholeZoneMultiTowers as unknown as FixtureFile,
  );
  waitForPhase(sc, Phase.BATTLE);

  const player = sc.state.players[0]!;
  const towers = player.enclosedTowers;
  assertGreater(towers.length, 1, "fixture should enclose multiple towers");

  // Closest enclosed tower pair (Manhattan, top-left corners).
  let a = towers[0]!;
  let b = towers[1]!;
  let bestDist = Infinity;
  for (let i = 0; i < towers.length; i++) {
    for (let j = i + 1; j < towers.length; j++) {
      const d =
        Math.abs(towers[i]!.row - towers[j]!.row) +
        Math.abs(towers[i]!.col - towers[j]!.col);
      if (d < bestDist) {
        bestDist = d;
        a = towers[i]!;
        b = towers[j]!;
      }
    }
  }

  assert(
    hasBuildableDividerLane(player, a, b),
    `no buildable divider seam survives between adjacent towers ` +
      `(${a.row},${a.col}) & (${b.row},${b.col}) (dist=${bestDist}) — cannon ` +
      `clusters merged into a wall, blocking compartmentalization`,
  );
});

/** True if at least one straight interior lane (a full column or row), strictly
 *  between towers A and B, is free of cannon and tower tiles across the whole
 *  enclosure span — i.e. a future divider wall could be built there to split
 *  the enclosure. Existing walls on the lane are fine (already wall). */
function hasBuildableDividerLane(
  player: { cannons: readonly { row: number; col: number }[]; enclosedTowers: readonly { row: number; col: number }[]; interior: ReadonlySet<TileKey>; walls: ReadonlySet<TileKey> },
  a: { row: number; col: number },
  b: { row: number; col: number },
): boolean {
  const blocked = new Set<TileKey>();
  for (const c of player.cannons) {
    for (let dr = 0; dr < 2; dr++)
      for (let dc = 0; dc < 2; dc++) blocked.add(packTile(c.row + dr, c.col + dc));
  }
  for (const t of player.enclosedTowers) {
    for (let dr = 0; dr < 2; dr++)
      for (let dc = 0; dc < 2; dc++) blocked.add(packTile(t.row + dr, t.col + dc));
  }
  let minR = Infinity;
  let maxR = -Infinity;
  let minC = Infinity;
  let maxC = -Infinity;
  for (const key of player.interior) {
    const { row, col } = unpackTile(key);
    minR = Math.min(minR, row);
    maxR = Math.max(maxR, row);
    minC = Math.min(minC, col);
    maxC = Math.max(maxC, col);
  }
  // Vertical divider columns strictly between the towers (cols clear of the
  // 2-wide tower footprints): every interior tile in the column must be free.
  for (let col = Math.min(a.col, b.col) + 2; col <= Math.max(a.col, b.col) - 1; col++) {
    let clear = true;
    for (let row = minR; row <= maxR; row++) {
      const key = packTile(row, col);
      if (player.interior.has(key) && blocked.has(key)) {
        clear = false;
        break;
      }
    }
    if (clear) return true;
  }
  // Horizontal divider rows strictly between the towers.
  for (let row = Math.min(a.row, b.row) + 2; row <= Math.max(a.row, b.row) - 1; row++) {
    let clear = true;
    for (let col = minC; col <= maxC; col++) {
      const key = packTile(row, col);
      if (player.interior.has(key) && blocked.has(key)) {
        clear = false;
        break;
      }
    }
    if (clear) return true;
  }
  return false;
}
