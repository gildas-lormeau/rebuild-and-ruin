/**
 * Render observer test — verifies the high_tide / sinkhole modifier reveal
 * fix end-to-end through the real render pipeline.
 *
 * The bug: when a tile-mutation modifier (high_tide, sinkhole) fired, the
 * banner sweep showed the NEW terrain below the divider line because
 * `drawBannerPrevScene` rendered terrain from the live (post-mutation)
 * `state.map`. Players never saw the OLD terrain reveal — the river just
 * flashed in instead of progressively appearing.
 *
 * The fix: `drawBannerPrevScene` builds a snapshot `GameMap` (via
 * `buildModifierSnapshotMap`) with `changedTiles` reverted to Grass and
 * passes that to `drawTerrain` for the banner canvas only.
 *
 * The invariant we assert: during a tile-mutation modifier banner,
 * drawTerrain fires twice — once for the main scene with the live map,
 * once for the banner prev-scene with the *snapshot* map. The two map
 * references must differ (the snapshot is a fresh
 * `{ ...liveMap, tiles: cloned }` object).
 *
 * If the bug regresses, the banner-side terrainDrawn event would carry the
 * same map reference as the main-side event, and the assertion fails.
 *
 * Both `high_tide` and `sinkhole` go through the same code path; we cover
 * both because each picks a different `changedTiles` selection routine in
 * round-modifiers.ts and we want both branches exercised.
 */

import { assert, assertEquals, assertNotStrictEquals } from "@std/assert";
import type { ModifierId } from "../src/shared/core/game-constants.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import type { GameMap } from "../src/shared/core/geometry-types.ts";
import { GRID_COLS, Tile } from "../src/shared/core/grid.ts";
import { createCanvasRecorder } from "./recording-canvas.ts";
import {
  createScenario,
  waitForModifier,
  waitUntilRound,
} from "./scenario.ts";

interface TerrainEvent {
  target: "main" | "banner";
  mapRef: GameMap;
}

interface ModifierCase {
  modifier: ModifierId;
  seed: number;
  /** Round at which `find-seed --condition <modifier>` reports the
   *  modifier appearing for this seed. Used as the `waitUntilRound`
   *  shortcut so we don't have to scan from round 1. */
  appearsAtRound: number;
}

const CASES: readonly ModifierCase[] = [
  // seed=6 modern → high_tide on round 3 (find-seed --condition highTide)
  { modifier: "high_tide", seed: 6, appearsAtRound: 3 },
  // seed=23 modern → sinkhole on round 3 (find-seed --condition sinkhole)
  { modifier: "sinkhole", seed: 23, appearsAtRound: 3 },
];

/** Read tile value at a packed key (`row * GRID_COLS + col`). */
function tileAtKey(map: GameMap, key: number): number {
  const row = Math.floor(key / GRID_COLS);
  const col = key % GRID_COLS;
  return map.tiles[row]![col]!;
}

for (const { modifier, seed, appearsAtRound } of CASES) {
  Deno.test(
    `${modifier} banner: drawTerrain on banner canvas uses snapshot map`,
    async () => {
      const events: TerrainEvent[] = [];
      const recorder = createCanvasRecorder();
      using sc = await createScenario({
        seed,
        mode: "modern",
        rounds: appearsAtRound + 1,
        recorder,
        renderObserver: {
          terrainDrawn: (target, mapRef) => events.push({ target, mapRef }),
        },
      });

      waitUntilRound(sc, appearsAtRound, 20000);
      waitForModifier(sc, modifier, 5000);

      // Drive frames until drawBannerPrevScene actually runs the terrain pass
      // on the banner canvas (the banner needs a few frames to sweep on-screen
      // before clipY < H gates it through).
      events.length = 0;
      sc.runUntil(() => events.some((ev) => ev.target === "banner"), 300);

      const main = events.findLast((ev) => ev.target === "main");
      const banner = events.findLast((ev) => ev.target === "banner");
      if (!main || !banner) {
        throw new Error(
          `${modifier}: expected both main and banner terrainDrawn events; got ${events.length}: ${events.map((e) => e.target).join(",")}`,
        );
      }

      // The snapshot map is a *new* object built by buildModifierSnapshotMap —
      // reference inequality with the live map is the load-bearing signal that
      // the prev-scene rendered the OLD terrain, not the post-mutation tiles.
      assertNotStrictEquals(
        banner.mapRef,
        main.mapRef,
        `${modifier}: banner prev-scene should render a snapshot map distinct from the live map`,
      );
    },
  );
}

// ─── Sequence: prior modifier mutations stay applied in the snapshot ──────
//
// When a tile-mutation modifier fires after another tile-mutation modifier
// already happened (e.g. sinkhole on round 3, then high_tide on round 5),
// the high_tide banner's snapshot map must:
//   - Revert ONLY the high_tide changedTiles to grass
//   - Leave the sinkhole tiles as Water (because they happened earlier and
//     their banner sweep is long over)
//
// If `buildModifierSnapshotMap` accidentally reverted ALL water tiles (or
// if the bannerCache held a stale snapshot from the sinkhole banner), the
// player would see the sinkhole tiles flash back to grass during the
// high_tide reveal — a visual regression that the single-modifier test
// can't catch.

Deno.test(
  "high_tide after sinkhole: snapshot keeps sinkhole tiles as water, only reverts high_tide tiles",
  async () => {
    // Memory-bounded capture: we only need the latest main + banner refs
    // *during* the high_tide banner. Storing every frame's events for the
    // 30k+ frames needed to reach round 5+ blows out the heap.
    let trackingActive = false;
    let latestMain: GameMap | undefined;
    let latestBanner: GameMap | undefined;

    // Snapshot of `state.modern.sinkholeTiles` taken at high_tide banner
    // time (NOT at sinkhole banner time). Why: if a player is eliminated
    // between sinkhole and high_tide, `resetZoneState` reverts that
    // zone's sinkhole tiles back to grass. The test invariant is "tiles
    // currently in modern.sinkholeTiles are preserved across the
    // high_tide snapshot", not "tiles that were once sinkholes are
    // preserved".
    let sinkholeTilesAtHighTide: readonly number[] | undefined;
    let highTideTiles: readonly number[] | undefined;
    let sawSinkhole = false;
    // discardCalls: this test runs ~30k frames; accumulating every 2D-context
    // call into recorder.log would OOM the test runner. We observe the
    // renderer through the `renderObserver` scenario option instead.
    const recorder = createCanvasRecorder({ discardCalls: true });
    using sc = await createScenario({
      // seed=44 modern: sinkhole@r5 → high_tide@r6 (the tightest sequence
      // I found — both modifiers fire as close to each other as possible).
      // Find via: deno run -A scripts/find-seed.ts --expr \
      //   "seq.indexOf('sinkhole') >= 0 \
      //    && seq.indexOf('high_tide') > seq.indexOf('sinkhole')"
      seed: 44,
      mode: "modern",
      rounds: 6,
      recorder,
      renderObserver: {
        terrainDrawn: (target, mapRef) => {
          if (!trackingActive) return;
          if (target === "main") latestMain = mapRef;
          else latestBanner = mapRef;
        },
      },
    });

    sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
      if (ev.modifierId === "sinkhole") {
        sawSinkhole = true;
      } else if (ev.modifierId === "high_tide" && sawSinkhole && !highTideTiles) {
        highTideTiles = ev.changedTiles;
        // Capture the LIVE sinkhole tile set at this exact moment — not
        // the sinkhole banner's changedTiles, which can become stale if
        // a player elimination revert wiped some sinkhole tiles.
        sinkholeTilesAtHighTide = Array.from(
          sc.state.modern?.sinkholeTiles ?? [],
        );
        // Only start collecting terrain events once high_tide is on-screen.
        trackingActive = true;
      }
    });

    // Drive the game until the high_tide banner is on-screen and the
    // banner-side terrain pass has fired at least once. seed=44 modern
    // takes ~6 rounds before sinkhole then high_tide.
    sc.runUntil(
      () => latestMain !== undefined && latestBanner !== undefined,
      30000,
    );

    assert(sawSinkhole, "expected sinkhole banner to fire first");
    assert(highTideTiles !== undefined, "expected high_tide banner to fire");
    assert(highTideTiles.length > 0, "high_tide had no changed tiles");
    assert(
      sinkholeTilesAtHighTide !== undefined &&
        sinkholeTilesAtHighTide.length > 0,
      "expected sinkhole tiles to still exist when high_tide fires",
    );
    assert(latestMain !== undefined, "no main terrainDrawn event");
    assert(latestBanner !== undefined, "no banner terrainDrawn event");

    // Sanity: the snapshot must be a different object than the live map.
    assertNotStrictEquals(latestBanner, latestMain);

    // ── Live (main) map: every CURRENT sinkhole + high_tide tile is Water ──
    for (const key of sinkholeTilesAtHighTide) {
      assertEquals(
        tileAtKey(latestMain, key),
        Tile.Water,
        `live map: sinkhole tile ${key} should be Water (in modern.sinkholeTiles)`,
      );
    }
    for (const key of highTideTiles) {
      assertEquals(
        tileAtKey(latestMain, key),
        Tile.Water,
        `live map: high_tide tile ${key} should be Water (high_tide just fired)`,
      );
    }

    // ── Snapshot (banner) map: sinkhole tiles still Water, high_tide reverted to Grass ──
    for (const key of sinkholeTilesAtHighTide) {
      assertEquals(
        tileAtKey(latestBanner, key),
        Tile.Water,
        `snapshot: sinkhole tile ${key} must remain Water (it's NOT in this banner's changedTiles)`,
      );
    }
    for (const key of highTideTiles) {
      assertEquals(
        tileAtKey(latestBanner, key),
        Tile.Grass,
        `snapshot: high_tide tile ${key} must be reverted to Grass for the prev-scene reveal`,
      );
    }
  },
);
