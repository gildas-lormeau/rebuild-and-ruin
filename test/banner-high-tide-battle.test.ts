/**
 * Reproduction test: battle banner after high_tide shows stale Grass snapshot.
 *
 * After a High Tide modifier banner sweeps (revealing Water), the chained
 * "Prepare for Battle" banner should use the live map (with Water) for its
 * prev-scene terrain. Instead, the renderer falls back to the modifier
 * banner's cached snapshot map (which has Grass).
 *
 * This test captures the map reference passed to `drawTerrain` on the banner
 * canvas during the battle banner that follows a high_tide modifier, and
 * asserts the high-tide tiles are Water — not Grass.
 */

import { assert, assertEquals } from "@std/assert";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { GRID_COLS, Tile } from "../src/shared/core/grid.ts";
import type { GameMap } from "../src/shared/core/geometry-types.ts";
import { createCanvasRecorder } from "./recording-canvas.ts";
import { createScenario } from "./scenario.ts";

const MAX_TICKS = 120_000;

Deno.test("battle banner after high_tide uses post-mutation map (not stale Grass snapshot)", async () => {
  let bannerMapRef: GameMap | null = null;
  let capturingBattle = false;

  const recorder = createCanvasRecorder({ discardCalls: true });

  using sc = await createScenario({
    seed: 1,
    mode: "modern",
    rounds: 10,
    recorder,
    renderObserver: {
      terrainDrawn: (target, mapRef) => {
        if (target === "banner" && capturingBattle) {
          bannerMapRef = mapRef;
        }
      },
    },
  });

  // Phase 1: wait for a high_tide modifier banner to fire and end.
  let highTideChangedTiles: readonly number[] = [];
  let modifierBannerText: string | null = null;
  let modifierBannerEnded = false;

  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (ev.modifierId === "high_tide" && modifierBannerText === null) {
      modifierBannerText = ev.text;
      highTideChangedTiles = ev.changedTiles ?? [];
    }
  });
  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    if (
      modifierBannerText !== null &&
      !modifierBannerEnded &&
      ev.text === modifierBannerText
    ) {
      modifierBannerEnded = true;
    }
  });

  // Phase 2: once the modifier banner ends, the battle banner chains in.
  let battleBannerText: string | null = null;
  let battleBannerEnded = false;

  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (modifierBannerEnded && battleBannerText === null && ev.modifierId === undefined) {
      battleBannerText = ev.text;
      capturingBattle = true;
    }
  });
  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    if (battleBannerText !== null && !battleBannerEnded && ev.text === battleBannerText) {
      capturingBattle = false;
      battleBannerEnded = true;
    }
  });

  sc.runUntil(() => battleBannerEnded, MAX_TICKS);

  // Preconditions.
  assert(modifierBannerEnded, "high_tide modifier banner never fired within 10 rounds");
  assert(battleBannerText !== null, "battle banner after high_tide never started");
  assert(battleBannerEnded, "battle banner never ended");
  assert(highTideChangedTiles.length > 0, "high_tide reported no changedTiles");
  assert(bannerMapRef !== null, "drawTerrain never fired on banner canvas during battle banner");
  const capturedMap: GameMap = bannerMapRef;

  // The bug: the battle banner's prev-scene terrain pass receives the stale
  // modifier snapshot (Grass) instead of the live map (Water).
  for (const key of highTideChangedTiles) {
    const row = Math.floor(key / GRID_COLS);
    const col = key % GRID_COLS;
    const tile = capturedMap.tiles[row]![col]!;
    assertEquals(
      tile,
      Tile.Water,
      `battle banner prev-scene tile at (r=${row},c=${col}) should be Water (post high-tide), got ${tile === Tile.Grass ? "Grass" : String(tile)} — stale snapshot cache?`,
    );
  }
});
