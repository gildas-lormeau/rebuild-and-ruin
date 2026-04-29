/**
 * Seed 546418 — drive the game until the sinkhole modifier fires, then
 * wait for the red player to wall in their zone's sinkhole cluster
 * during the WALL_BUILD phase that follows.
 *
 * Enclosure check: every sinkhole tile inside red's zone is present in
 * `red.interior`. `recomputeInterior` flood-fills outside-ness through
 * non-wall tiles — water tiles (sinkholes) sealed off by walls are
 * neither outside nor walls, so they land in `interior`.
 */

import { assert } from "@std/assert";
import { unpackTile } from "../src/shared/core/spatial.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { createScenario, waitForModifier, waitForPhase } from "./scenario.ts";

const RED_SLOT = 0;

Deno.test("seed 546418: red encloses its sinkhole during the next build phase", async () => {
  using sc = await createScenario({
    seed: 546418,
    mode: "modern",
    rounds: 100,
  });

  const sinkholeEvent = waitForModifier(sc, "sinkhole", { timeoutMs: 1_500_000 });
  waitForPhase(sc, Phase.WALL_BUILD, { timeoutMs: 1_500_000 });

  const red = sc.state.players[RED_SLOT]!;
  assert(red.homeTower, "red must be seated");
  const redZone = red.homeTower.zone;
  const sinkholeTiles = sc.state.modern?.sinkholeTiles;
  assert(
    sinkholeTiles !== null && sinkholeTiles !== undefined && sinkholeTiles.size > 0,
    "expected sinkhole tiles on the map",
  );
  const redSinkholeTiles = [...sinkholeTiles].filter((key) => {
    const { r, c } = unpackTile(key);
    return sc.state.map.zones[r]?.[c] === redZone;
  });
  assert(
    redSinkholeTiles.length > 0,
    `expected sinkhole tiles in red's zone (${redZone})`,
  );

  sc.runUntil(
    () => redSinkholeTiles.every((key) => red.interior.has(key)),
    { timeoutMs: 1_500_000 },
  );

  dumpSinkholeState(sc, redZone, sinkholeEvent.round);

  // Battle-scoped modifier state must be null/empty by the time WALL_BUILD
  // runs — finalizeBattle clears frozen tiles, high tide / low water
  // reverts, and frostbite chip at battle-done so the post-battle phases
  // see neutral terrain. Permanent mutations (sinkhole tiles) persist.
  const modern = sc.state.modern!;
  assert(
    modern.frozenTiles === null,
    `expected frozenTiles=null in WALL_BUILD, got size=${modern.frozenTiles?.size}`,
  );
  assert(
    modern.highTideTiles === null,
    `expected highTideTiles=null in WALL_BUILD, got size=${modern.highTideTiles?.size}`,
  );
  assert(
    modern.lowWaterTiles === null,
    `expected lowWaterTiles=null in WALL_BUILD, got size=${modern.lowWaterTiles?.size}`,
  );
});

function dumpSinkholeState(
  sc: Awaited<ReturnType<typeof createScenario>>,
  redZone: number,
  sinkholeRound: number,
): void {
  const state = sc.state;
  const modern = state.modern!;
  const red = state.players[RED_SLOT]!;
  const sinkholeTiles = [...(modern.sinkholeTiles ?? [])];

  console.log("=== ROUND ===");
  console.log(`sinkhole rolled in round=${sinkholeRound}; enclosed in round=${state.round}`);
  console.log(`phase=${state.phase} timer=${state.timer.toFixed(1)} mapVersion=${state.map.mapVersion}`);

  console.log("=== ModernState (sinkhole-related) ===");
  console.log(`activeModifier=${modern.activeModifier}`);
  console.log(`lastModifierId=${modern.lastModifierId}`);
  console.log(`activeModifierChangedTiles=${modern.activeModifierChangedTiles.length} tile(s)`);
  console.log(`sinkholeTiles=${modern.sinkholeTiles?.size ?? 0} tile(s) cumulative`);
  console.log(`highTideTiles=${modern.highTideTiles?.size ?? 0}`);
  console.log(`frozenTiles=${modern.frozenTiles?.size ?? 0}`);
  console.log(`lowWaterTiles=${modern.lowWaterTiles?.size ?? 0}`);

  console.log("=== Sinkhole tiles (per-tile inspection) ===");
  for (const key of sinkholeTiles) {
    const { r, c } = unpackTile(key);
    const inspection = sc.tileAt(r, c);
    const zone = state.map.zones[r]?.[c] ?? null;
    const ownersStr = inspection.interior.length > 0
      ? `interior of player(s) [${inspection.interior.join(",")}]`
      : "no interior owner";
    const wallStr = inspection.wall ? `WALL:p${inspection.wall.playerId}` : "no wall";
    const grunt = inspection.grunt ? `grunt(victim p${inspection.grunt.playerId})` : "";
    const cannon = inspection.cannon
      ? `cannon(p${inspection.cannon.playerId} hp=${inspection.cannon.hp} mode=${inspection.cannon.mode})`
      : "";
    const extras = [grunt, cannon].filter(Boolean).join(" ");
    console.log(
      `  (${r},${c}) key=${key} zone=${zone} terrain=${inspection.terrain} ${wallStr} ${ownersStr}${extras ? " " + extras : ""}`,
    );
  }

  console.log("=== Red player ===");
  console.log(
    `id=${red.id} lives=${red.lives} score=${red.score} eliminated=${red.eliminated} freshCastle=${red.freshCastle}`,
  );
  console.log(
    `homeTower=(${red.homeTower!.row},${red.homeTower!.col}) idx=${red.homeTower!.index} zone=${redZone}`,
  );
  console.log(
    `walls=${red.walls.size} interior=${red.interior.size} castleWallTiles=${red.castleWallTiles.size} ownedTowers=${red.ownedTowers.length}`,
  );
  const redSinkholeInInterior = sinkholeTiles.filter((key) => {
    const { r, c } = unpackTile(key);
    return state.map.zones[r]?.[c] === redZone && red.interior.has(key);
  });
  console.log(
    `sinkhole tiles in red's zone: ${sinkholeTiles.filter((k) => {
      const { r, c } = unpackTile(k);
      return state.map.zones[r]?.[c] === redZone;
    }).length} | enclosed by red: ${redSinkholeInInterior.length}`,
  );
  console.log(
    `damagedWalls=${red.damagedWalls.size} upgrades=${[...red.upgrades.entries()].map(([id, n]) => `${id}x${n}`).join(",") || "none"}`,
  );
}
