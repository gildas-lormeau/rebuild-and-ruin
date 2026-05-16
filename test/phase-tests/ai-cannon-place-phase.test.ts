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
    for (const tower of player.ownedTowers) {
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
            const { r, c } = unpackTile(wallKey);
            const distance = Math.abs(cr - r) + Math.abs(cc - c);
            if (distance < minWall) minWall = distance;
          }
          for (const towerKey of towerTiles) {
            const { r, c } = unpackTile(towerKey);
            const distance = Math.abs(cr - r) + Math.abs(cc - c);
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
