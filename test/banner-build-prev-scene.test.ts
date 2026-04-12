/**
 * Reproduction test: build banner prev-scene should match last rendered frame.
 *
 * Known bug (confirmed via e2e screenshots): when AI picks Demolition
 * during Choose Upgrade, walls are stripped immediately via demolitionOnPick.
 * The Build banner prev-scene snapshot is captured AFTER demolition applied,
 * showing fewer walls than the last frame the user saw. The visual result
 * is walls disappearing in the banner's "old scene" region.
 *
 * This test currently PASSES because the upgrade:demolition seed produces
 * a game where Demolition finds 0 inner walls to strip (thin shells only).
 * The bug only manifests in later rounds (12+) where AIs have built thick
 * multi-layer walls. The e2e test (e2e-banner-prev-scene.ts) catches it
 * via pixel diff on those rounds.
 *
 * TODO: find or engineer a seed where Demolition actually strips walls,
 * or write a targeted scenario that builds thick walls before picking.
 */

import { assert } from "@std/assert";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import { createCanvasRecorder } from "./recording-canvas.ts";
import { loadSeed } from "./scenario.ts";

const MAX_TICKS = 120_000;

Deno.test("build banner prev-scene walls match last rendered frame", async () => {
  const recorder = createCanvasRecorder({ discardCalls: true });

  let lastRenderedWalls: number[] = [];
  let upgradePhaseActive = false;

  using sc = await loadSeed("upgrade:demolition", {
    recorder,
    renderObserver: {
      terrainDrawn: (target) => {
        if (target === "main" && upgradePhaseActive) {
          try {
            lastRenderedWalls = sc.state.players.map(
              (player) => player.walls.size,
            );
          } catch {
            // state not ready
          }
        }
      },
    },
  });

  let demolitionPicked = false;
  let demolitionPlayerId = -1;
  let buildBannerStarted = false;
  let buildBannerEnded = false;
  let frozenWalls: number[] = [];
  let bannerSnapshotWalls: number[] = [];

  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (ev.text === "Choose Upgrade") {
      upgradePhaseActive = true;
    }
  });

  sc.bus.on(GAME_EVENT.UPGRADE_PICKED, (ev) => {
    if (ev.upgradeId === "demolition" && !demolitionPicked) {
      demolitionPicked = true;
      demolitionPlayerId = ev.playerId;
      frozenWalls = [...lastRenderedWalls];
    }
  });

  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (
      demolitionPicked &&
      !buildBannerStarted &&
      ev.phase === Phase.WALL_BUILD &&
      ev.text.includes("Build")
    ) {
      upgradePhaseActive = false;
      buildBannerStarted = true;

      const banner = sc.banner();
      if (banner.prevCastles) {
        bannerSnapshotWalls = banner.prevCastles.map(
          (castle) => castle.walls.size,
        );
      }
    }
  });

  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    if (buildBannerStarted && !buildBannerEnded && ev.phase === Phase.WALL_BUILD) {
      buildBannerEnded = true;
    }
  });

  sc.runUntil(() => buildBannerEnded, MAX_TICKS);

  assert(demolitionPicked, "Demolition upgrade never picked");
  assert(buildBannerStarted, "Build banner after demolition never started");
  assert(frozenWalls.length > 0, "no renders captured before demolition pick");
  assert(bannerSnapshotWalls.length > 0, "no banner snapshot available");

  const lastRenderCount = frozenWalls[demolitionPlayerId] ?? -1;
  const snapshotCount = bannerSnapshotWalls[demolitionPlayerId] ?? -1;

  assert(
    lastRenderCount >= 0 && snapshotCount >= 0,
    `could not read walls for player ${demolitionPlayerId}`,
  );

  assert(
    snapshotCount === lastRenderCount,
    `build banner prev-scene has ${snapshotCount} walls for player ${demolitionPlayerId} ` +
      `but last rendered frame before demolition had ${lastRenderCount} — ` +
      `${lastRenderCount - snapshotCount} walls stripped without being rendered first`,
  );
});
