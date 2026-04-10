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
 * The invariant we assert: during a high_tide modifier banner, drawTerrain
 * fires twice — once for the main scene with the live map, once for the
 * banner prev-scene with the *snapshot* map. The two map references must
 * differ (the snapshot is a fresh `{ ...liveMap, tiles: cloned }` object).
 *
 * If the bug regresses, the banner-side terrainDrawn event would carry the
 * same map reference as the main-side event, and the assertion fails.
 */

import { assertNotStrictEquals } from "@std/assert";
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

Deno.test("high_tide banner: drawTerrain on banner canvas uses snapshot map", async () => {
  const events: TerrainEvent[] = [];
  setRenderObserver({
    terrainDrawn: (target, mapRef) => events.push({ target, mapRef }),
  });
  try {
    const recorder = createCanvasRecorder();
    const sc = await createScenario({
      seed: 6,
      mode: "modern",
      rounds: 4,
      recorder,
    });

    // seed=6 modern produces high_tide on round 3 — skip there cheaply.
    waitUntilRound(sc, 3, 20000);
    waitForModifier(sc, "high_tide", 5000);

    // Drive frames until drawBannerPrevScene actually runs the terrain pass
    // on the banner canvas (the banner needs a few frames to sweep on-screen
    // before clipY < H gates it through).
    events.length = 0;
    sc.runUntil(() => events.some((ev) => ev.target === "banner"), 300);

    const main = events.findLast((ev) => ev.target === "main");
    const banner = events.findLast((ev) => ev.target === "banner");
    if (!main || !banner) {
      throw new Error(
        `expected both main and banner terrainDrawn events; got ${events.length}: ${events.map((e) => e.target).join(",")}`,
      );
    }

    // The snapshot map is a *new* object built by buildModifierSnapshotMap —
    // reference inequality with the live map is the load-bearing signal that
    // the prev-scene rendered the OLD terrain, not the post-mutation tiles.
    assertNotStrictEquals(
      banner.mapRef,
      main.mapRef,
      "banner prev-scene should render a snapshot map distinct from the live map",
    );
  } finally {
    setRenderObserver(undefined);
  }
});
