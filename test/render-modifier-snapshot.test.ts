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

import { assertNotStrictEquals } from "@std/assert";
import type { ModifierId } from "../src/shared/game-constants.ts";
import type { GameMap } from "../src/shared/geometry-types.ts";
import { setRenderObserver } from "../src/render/render-map.ts";
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

for (const { modifier, seed, appearsAtRound } of CASES) {
  Deno.test(
    `${modifier} banner: drawTerrain on banner canvas uses snapshot map`,
    async () => {
      const events: TerrainEvent[] = [];
      setRenderObserver({
        terrainDrawn: (target, mapRef) => events.push({ target, mapRef }),
      });
      const recorder = createCanvasRecorder();
      using sc = await createScenario({
        seed,
        mode: "modern",
        rounds: appearsAtRound + 1,
        recorder,
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
