/**
 * Fresh-castle protection helpers for modifier targeting.
 *
 * Verifies that a freshly-reselected castle's tiles land in
 * getProtectedCastleTiles (tower + castle walls), that seated-player zone
 * enumeration excludes eliminated players, and that applyFireScar asserts
 * against protected tiles.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { applyFireScar } from "../src/game/modifiers/fire-helpers.ts";
import {
  getActiveZones,
  getProtectedCastleTiles,
} from "../src/game/modifiers/modifier-eligibility.ts";
import { TOWER_SIZE } from "../src/shared/core/game-constants.ts";
import { packTile } from "../src/shared/core/spatial.ts";
import { createScenario } from "./scenario.ts";

Deno.test("protected-tiles: empty when no player has freshCastle", async () => {
  const sc = await createScenario({ seed: 42 });
  for (const player of sc.state.players) {
    assertEquals(player.freshCastle, false);
  }
  assertEquals(getProtectedCastleTiles(sc.state).size, 0);
});

Deno.test("protected-tiles: freshCastle contributes tower + castle walls", async () => {
  const sc = await createScenario({ seed: 42 });
  const target = sc.state.players.find((p) => !!p.homeTower && !p.eliminated);
  assert(target, "need at least one seated player");
  target.freshCastle = true;
  target.castleWallTiles = new Set(target.walls);
  const tower = target.homeTower!;

  const protectedTiles = getProtectedCastleTiles(sc.state);
  for (let dr = 0; dr < TOWER_SIZE; dr++) {
    for (let dc = 0; dc < TOWER_SIZE; dc++) {
      assert(protectedTiles.has(packTile(tower.row + dr, tower.col + dc)));
    }
  }
  for (const key of target.castleWallTiles) {
    assert(protectedTiles.has(key));
  }
});

Deno.test("active-zones: eliminated players are excluded", async () => {
  const sc = await createScenario({ seed: 42 });
  const target = sc.state.players.find((p) => !!p.homeTower && !p.eliminated);
  assert(target, "need at least one seated player");
  const targetZone = target.homeTower!.zone;

  assert(getActiveZones(sc.state).includes(targetZone));
  target.eliminated = true;
  assert(!getActiveZones(sc.state).includes(targetZone));
});

Deno.test("applyFireScar throws if scar touches a protected tile", async () => {
  const sc = await createScenario({ seed: 42 });
  const target = sc.state.players.find((p) => !!p.homeTower && !p.eliminated);
  assert(target, "need at least one seated player");
  target.freshCastle = true;
  const tower = target.homeTower!;
  const scar = new Set<number>([packTile(tower.row, tower.col)]);
  assertThrows(
    () => applyFireScar(sc.state, scar),
    Error,
    "fresh-castle tile",
  );
});
