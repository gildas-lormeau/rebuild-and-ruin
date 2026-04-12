/**
 * End-to-end banner rendering test — drives the real renderer and verifies
 * that phase/modifier banners progressively reveal the new scene.
 *
 * See `docs/banner-rendering.md` for the mechanism this test protects.
 *
 * Observability: this test can only check what's observable through the test
 * seams (`sc.banner()` for progress/active, `renderObserver.terrainDrawn`
 * for the map references passed to `drawTerrain`). It doesn't read pixels
 * back from the canvas — the rendering-vs-state distinction is preserved by
 * asserting on the *exact `GameMap` object* the renderer fed to `drawTerrain`:
 *
 *   1. If the renderer drew the wrong mapRef, the old-terrain reveal would
 *      be visually wrong in the browser (this is the fix
 *      `render-modifier-snapshot.test.ts` already pinned down).
 *   2. If `banner.progress` doesn't advance from 0→1 monotonically, the
 *      sweep doesn't happen on screen.
 *   3. If the modifier snapshot doesn't revert tiles, the new terrain flashes
 *      in instead of progressively appearing.
 *
 * Each modifier gets its own test case, driven by a `loadSeed`-registered
 * fixture (see `test/seed-conditions.ts`). Upgrade banners aren't a distinct
 * class — the upgrade-pick dialog is an overlay drawn on top of a normal
 * phase banner, so the classic-mode phase banner case covers the banner
 * machinery that upgrades ride on.
 */

import { assert, assertEquals, assertNotStrictEquals } from "@std/assert";
import type { ModifierId } from "../src/shared/core/game-constants.ts";
import { GAME_EVENT } from "../src/shared/core/game-event-bus.ts";
import { Phase } from "../src/shared/core/game-phase.ts";
import type { GameMap } from "../src/shared/core/geometry-types.ts";
import { GRID_COLS, MAP_PX_H, TILE_SIZE, Tile } from "../src/shared/core/grid.ts";
import { createCanvasRecorder } from "./recording-canvas.ts";
import { createScenario, loadSeed } from "./scenario.ts";

interface TerrainEvent {
  readonly target: "main" | "banner";
  readonly mapRef: GameMap;
}

interface ComposeFrame {
  readonly clipY: number;
  readonly H: number;
  readonly bannerH: number;
  /** The mapRef passed to `drawTerrain` on the main canvas *at the time
   *  this compose frame fired*. We capture it alongside `clipY` so the
   *  reconstruction uses the exact live map the renderer used. */
  readonly liveMap: GameMap;
  /** Likewise for the banner canvas. Only meaningful when a snapshot was
   *  actually built (tile-mutation modifier); otherwise equals `liveMap`. */
  readonly snapshotMap: GameMap;
}

/** Modifiers that actually mutate `state.map.tiles`. For these, the banner
 *  snapshot map must revert the changed tiles back to Grass so the OLD
 *  terrain paints below the sweep line. All other modifiers leave terrain
 *  alone — their `changedTiles` set drives the pulse highlight only. */
const TILE_MUTATION_MODIFIERS: ReadonlySet<ModifierId> = new Set([
  "sinkhole",
  "high_tide",
]);
const ALL_MODIFIERS: readonly ModifierId[] = [
  "wildfire",
  "crumbling_walls",
  "grunt_surge",
  "frozen_river",
  "sinkhole",
  "high_tide",
  "dust_storm",
  "rubble_clearing",
];
const MAX_TICKS = 60000;
/** At 3s banner duration and 16ms per tick the sweep takes ~187 frames; we
 *  set a floor well below that to tolerate cache-warmup ticks where the
 *  predicate hasn't started sampling yet. */
const MIN_SWEEP_SAMPLES = 3;
const SCREENSHOT_CASES: readonly ModifierId[] = ["sinkhole", "high_tide"];

for (const modifierId of ALL_MODIFIERS) {
  Deno.test(
    `banner progressive render: ${modifierId} modifier reveal`,
    async () => {
      const terrainEvents: TerrainEvent[] = [];
      const recorder = createCanvasRecorder({ discardCalls: true });

      using sc = await loadSeed(`modifier:${modifierId}`, {
        recorder,
        renderObserver: {
          terrainDrawn: (target, mapRef) =>
            terrainEvents.push({ target, mapRef }),
        },
      });

      // Latch the first BANNER_START carrying this modifier, then the
      // matching BANNER_END. Modifier banners chain into a phase banner via
      // `banner.callback`, which fires from inside `tickBanner` *after*
      // `BANNER_END` emits but *before* the `runUntil` predicate runs. So
      // by the time the predicate wakes up on the end-tick, the runtime
      // already has a new (progress=0) banner installed — we must capture
      // the end-state from inside the `BANNER_END` handler itself, where
      // `sc.banner().progress` still reads 1.
      let startText: string | null = null;
      let startChangedTiles: readonly number[] = [];
      let ended = false;
      let finalProgress = Number.NaN;
      let finalActive = true;
      let finalPrevCastlesCleared = false;
      let finalPrevTerritoryCleared = false;
      let finalModifierDiffCleared = false;
      sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
        if (ev.modifierId === modifierId && startText === null) {
          startText = ev.text;
          startChangedTiles = ev.changedTiles ?? [];
        }
      });
      sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
        if (startText !== null && !ended && ev.text === startText) {
          const banner = sc.banner();
          finalProgress = banner.progress;
          finalActive = banner.active;
          finalPrevCastlesCleared = banner.prevCastles === undefined;
          finalPrevTerritoryCleared = banner.prevTerritory === undefined;
          finalModifierDiffCleared = banner.modifierDiff === undefined;
          ended = true;
        }
      });

      // Sample banner.progress and banner.active at every frame *during*
      // the sweep window. Skip the push on the end-tick — its banner state
      // belongs to the chained successor banner, not the one we're testing.
      const progressSamples: number[] = [];
      const activeSamples: boolean[] = [];
      sc.runUntil(() => {
        if (startText === null) return false;
        if (ended) return true;
        const banner = sc.banner();
        progressSamples.push(banner.progress);
        activeSamples.push(banner.active);
        return false;
      }, MAX_TICKS);

      assert(
        startText !== null,
        `${modifierId}: BANNER_START never fired within ${MAX_TICKS} ticks`,
      );
      assert(ended, `${modifierId}: BANNER_END never fired for "${startText}"`);

      // ── Progressive reveal invariants ──────────────────────────────────

      assert(
        progressSamples.length >= MIN_SWEEP_SAMPLES,
        `${modifierId}: expected ≥${MIN_SWEEP_SAMPLES} sampled frames, got ${progressSamples.length}`,
      );

      for (let index = 1; index < progressSamples.length; index++) {
        const prev = progressSamples[index - 1]!;
        const cur = progressSamples[index]!;
        assert(
          cur >= prev,
          `${modifierId}: banner progress went backward at frame ${index} (${prev} → ${cur})`,
        );
      }

      // First sample is the first post-showBanner tick, so progress should
      // be just above 0 but well below 1.
      const first = progressSamples[0]!;
      assert(
        first >= 0 && first < 0.5,
        `${modifierId}: expected first sampled progress in [0, 0.5), got ${first}`,
      );
      const last = progressSamples[progressSamples.length - 1]!;
      assert(
        last > 0.9,
        `${modifierId}: expected last in-sweep sample > 0.9, got ${last}`,
      );
      // The end-tick progress (captured inside the BANNER_END handler,
      // before the chained callback runs) must be exactly 1.
      assertEquals(
        finalProgress,
        1,
        `${modifierId}: finalProgress captured from BANNER_END should be 1`,
      );
      assertEquals(
        finalActive,
        false,
        `${modifierId}: banner.active should already be false by the time BANNER_END fires`,
      );

      // banner.active must have been true for every in-sweep sample.
      for (let index = 0; index < activeSamples.length; index++) {
        assertEquals(
          activeSamples[index],
          true,
          `${modifierId}: banner.active should be true at frame ${index}`,
        );
      }

      // ── Terrain pass invariants ────────────────────────────────────────
      //
      // The banner canvas's terrain pass is cached — it fires once per
      // banner (on cache miss) rather than every frame. But it MUST fire
      // at least once during the sweep, otherwise the old-scene reveal
      // never happens.

      const mainEvents = terrainEvents.filter((ev) => ev.target === "main");
      const bannerEvents = terrainEvents.filter((ev) => ev.target === "banner");

      assert(mainEvents.length > 0, `${modifierId}: no main terrain draws`);
      assert(
        bannerEvents.length > 0,
        `${modifierId}: drawBannerPrevScene never ran the terrain pass — old scene was never composited`,
      );

      // ── Tile-level invariants on the maps actually drawn ──────────────

      const lastMain = mainEvents[mainEvents.length - 1]!.mapRef;
      const lastBanner = bannerEvents[bannerEvents.length - 1]!.mapRef;

      if (TILE_MUTATION_MODIFIERS.has(modifierId)) {
        assertNotStrictEquals(
          lastBanner,
          lastMain,
          `${modifierId}: banner snapshot must be a distinct object — it has to revert mutated tiles`,
        );
        assert(
          startChangedTiles.length > 0,
          `${modifierId}: tile-mutation modifier must carry non-empty changedTiles`,
        );
        for (const key of startChangedTiles) {
          assertEquals(
            tileAt(lastMain, key),
            Tile.Water,
            `${modifierId}: live map tile ${key} should be Water after the modifier applied`,
          );
          assertEquals(
            tileAt(lastBanner, key),
            Tile.Grass,
            `${modifierId}: banner snapshot tile ${key} should be reverted to Grass for the prev-scene reveal`,
          );
        }
      } else if (startChangedTiles.length > 0) {
        // Non-mutation modifiers with a highlight set (wildfire,
        // crumbling_walls, frozen_river, rubble_clearing). `buildModifierSnapshotMap`
        // still runs (it's gated on `modifierTiles?.length > 0`), so the
        // snapshot is a fresh object — but since the underlying modifier
        // didn't touch `map.tiles`, the reverted tiles must equal the live
        // tiles.
        assertNotStrictEquals(
          lastBanner,
          lastMain,
          `${modifierId}: snapshot map should be a fresh object (buildModifierSnapshotMap always clones when changedTiles is non-empty)`,
        );
        for (const key of startChangedTiles) {
          assertEquals(
            tileAt(lastBanner, key),
            tileAt(lastMain, key),
            `${modifierId}: tile ${key} differs between snapshot and live — the modifier is not supposed to mutate terrain`,
          );
        }
      } else {
        // Empty changedTiles (grunt_surge, dust_storm). `drawBannerPrevScene`
        // takes the "live map straight through" branch, so the banner mapRef
        // is identical to the live mapRef.
        assertEquals(
          lastBanner,
          lastMain,
          `${modifierId}: empty-changedTiles modifier should render the banner from the live map reference`,
        );
      }

      // ── Post-end cleanup (captured inside BANNER_END handler) ─────────
      // These flags are sampled from the handler, before the chained
      // successor banner runs and re-populates the fields. Reading
      // `sc.banner()` here wouldn't work because by now the phase banner
      // that chains after the modifier has already taken over.
      assert(
        finalPrevCastlesCleared,
        `${modifierId}: prevCastles should be cleared at BANNER_END time`,
      );
      assert(
        finalPrevTerritoryCleared,
        `${modifierId}: prevTerritory should be cleared at BANNER_END time`,
      );
      assert(
        finalModifierDiffCleared,
        `${modifierId}: modifierDiff should be cleared at BANNER_END time`,
      );
    },
  );
}

Deno.test(
  "banner progressive render: classic-mode phase banner sweeps 0→1",
  async () => {
    const terrainEvents: TerrainEvent[] = [];
    const recorder = createCanvasRecorder({ discardCalls: true });

    using sc = await createScenario({
      seed: 0,
      mode: "classic",
      rounds: 2,
      recorder,
      renderObserver: {
        terrainDrawn: (target, mapRef) =>
          terrainEvents.push({ target, mapRef }),
      },
    });

    // The first BATTLE phase transition shows the "ATTACK!" banner with
    // preservePrevScene=true, so the old castles/walls get composited below
    // the sweep line. Classic mode never carries modifierId, so
    // `ev.modifierId === undefined` is the distinguishing check.
    //
    // Same chained-banner caveat as the modifier cases: the BATTLE banner's
    // `onDone` callback transitions into the build banner, which starts a
    // new sweep on the same tick BANNER_END emits. Capture the end-state
    // from inside the handler before the successor banner takes over.
    let startText: string | null = null;
    let ended = false;
    let finalProgress = Number.NaN;
    let finalModifierDiffWasUndefined = false;
    sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
      if (
        startText === null &&
        ev.modifierId === undefined &&
        ev.phase === Phase.BATTLE
      ) {
        startText = ev.text;
      }
    });
    sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
      if (startText !== null && !ended && ev.text === startText) {
        const banner = sc.banner();
        finalProgress = banner.progress;
        finalModifierDiffWasUndefined = banner.modifierDiff === undefined;
        ended = true;
      }
    });

    const progressSamples: number[] = [];
    sc.runUntil(() => {
      if (startText === null) return false;
      if (ended) return true;
      progressSamples.push(sc.banner().progress);
      return false;
    }, MAX_TICKS);

    assert(startText !== null, "classic: BATTLE banner never fired");
    assert(ended, "classic: BATTLE banner never ended");
    assert(
      progressSamples.length >= MIN_SWEEP_SAMPLES,
      `classic: expected ≥${MIN_SWEEP_SAMPLES} sampled frames, got ${progressSamples.length}`,
    );
    for (let index = 1; index < progressSamples.length; index++) {
      const prev = progressSamples[index - 1]!;
      const cur = progressSamples[index]!;
      assert(
        cur >= prev,
        `classic: progress went backward at frame ${index} (${prev} → ${cur})`,
      );
    }
    const lastSample = progressSamples[progressSamples.length - 1]!;
    assert(
      lastSample > 0.9,
      `classic: expected last in-sweep sample > 0.9, got ${lastSample}`,
    );
    assertEquals(finalProgress, 1, "classic: final progress should be 1");

    // Classic banners never carry a modifier diff.
    assert(
      finalModifierDiffWasUndefined,
      "classic: phase banner should not carry modifierDiff",
    );

    // drawBannerPrevScene fired at least once during the sweep (proves the
    // old castle/wall composite actually happened).
    assert(
      terrainEvents.some((ev) => ev.target === "banner"),
      "classic: drawBannerPrevScene never ran — old scene was not composited",
    );
  },
);

for (const modifierId of SCREENSHOT_CASES) {
  Deno.test(
    `banner reconstructed screenshot: ${modifierId} reveals new terrain top-down`,
    async () => {
      const frames: ComposeFrame[] = [];
      let latestMainMap: GameMap | null = null;
      let latestBannerMap: GameMap | null = null;
      // Gate frame capture on the modifier banner's active window. Opened
      // by BANNER_START for this modifierId, closed by the first matching
      // BANNER_END. Modifier banners chain into a successor phase banner
      // whose compose frames fire on the *same tick* as our banner's END,
      // so without this gate the capture would include clipY=-64 samples
      // from the successor and fail the monotonic assertion.
      let capturing = false;
      let changedTiles: readonly number[] = [];
      let startText: string | null = null;
      const recorder = createCanvasRecorder({ discardCalls: true });

      using sc = await loadSeed(`modifier:${modifierId}`, {
        recorder,
        renderObserver: {
          terrainDrawn: (target, mapRef) => {
            if (target === "main") latestMainMap = mapRef;
            else latestBannerMap = mapRef;
          },
          bannerComposited: (info) => {
            if (!capturing) return;
            if (latestMainMap === null || latestBannerMap === null) return;
            frames.push({
              clipY: info.clipY,
              H: info.H,
              bannerH: info.bannerH,
              liveMap: latestMainMap,
              snapshotMap: latestBannerMap,
            });
          },
        },
      });

      sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
        if (ev.modifierId === modifierId && startText === null) {
          startText = ev.text;
          changedTiles = ev.changedTiles ?? [];
          capturing = true;
        }
      });
      sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
        if (capturing && startText !== null && ev.text === startText) {
          capturing = false;
        }
      });

      // Run the game until the modifier banner has fully swept (capturing
      // is closed by the BANNER_END handler). We require at least one frame
      // at clipY >= H before stopping so the last-frame assertion holds.
      let modifierBannerEnded = false;
      sc.runUntil(() => {
        if (!capturing && frames.length > 0) {
          modifierBannerEnded = true;
          return true;
        }
        return false;
      }, MAX_TICKS);

      assert(
        modifierBannerEnded,
        `${modifierId}: modifier banner never completed within ${MAX_TICKS} ticks`,
      );

      const sweepFrames = frames;
      assert(
        sweepFrames.length >= MIN_SWEEP_SAMPLES,
        `${modifierId}: expected ≥${MIN_SWEEP_SAMPLES} compose frames, got ${sweepFrames.length}`,
      );

      // ── Invariant 1: clipY monotonically non-decreasing ─────────────
      // The curtain only ever sweeps downward.
      for (let index = 1; index < sweepFrames.length; index++) {
        const prev = sweepFrames[index - 1]!.clipY;
        const cur = sweepFrames[index]!.clipY;
        assert(
          cur >= prev,
          `${modifierId}: clipY moved backward at frame ${index} (${prev} → ${cur})`,
        );
      }

      // ── Invariant 2: clipY range ────────────────────────────────────
      // The renderer's clipY = banner.y - bannerH/2, and banner.y sweeps
      // from -bannerH/2 to H + bannerH/2. So clipY sweeps -bannerH..H.
      // The renderer early-returns once `clipY >= H` (no clip region to
      // draw) so the LAST observed compose frame has clipY at most H-1.
      const first = sweepFrames[0]!;
      const last = sweepFrames[sweepFrames.length - 1]!;
      assert(
        first.clipY < 0,
        `${modifierId}: first clipY should start above the top edge (negative), got ${first.clipY}`,
      );
      // Within one tile of the bottom == effectively fully revealed for
      // every row except the very last one. `chooseSampleTiles` skips that
      // last row for the same reason.
      assert(
        last.clipY >= last.H - TILE_SIZE,
        `${modifierId}: final clipY should reach ≥H-${TILE_SIZE} (${last.H - TILE_SIZE}), got ${last.clipY}`,
      );

      // ── Invariant 3: the modifier carries tile mutations ────────────
      assert(
        changedTiles.length > 0,
        `${modifierId}: expected non-empty changedTiles`,
      );

      // ── Invariant 4: reconstructed screenshot — reveal top-down ─────
      // For each changedTile, the reveal crosses its row boundary exactly
      // once, and the transition is monotonic (once revealed, stays
      // revealed). Verifying a handful of tiles across different rows is
      // enough — they're all sampled through the same sweep math.
      const sampledTiles = chooseSampleTiles(changedTiles, 6);
      for (const key of sampledTiles) {
        const row = Math.floor(key / GRID_COLS);
        const col = key % GRID_COLS;
        const tileBottom = (row + 1) * TILE_SIZE;
        const tileTop = row * TILE_SIZE;

        // For each frame, decide from the captured clipY which map's tile
        // would actually appear at this (row, col) on screen:
        //   - tileBottom <= clipY → fully above clip → NEW (live map)
        //   - tileTop    >= clipY → fully below clip → OLD (snapshot map)
        //   - otherwise the tile straddles the clip line; we skip those
        //     frames because both halves show on screen.
        let sawOld = false;
        let sawNew = false;
        let lastVisible: "old" | "new" | null = null;
        for (const frame of sweepFrames) {
          let visible: "old" | "new" | null;
          if (tileBottom <= frame.clipY) visible = "new";
          else if (tileTop >= frame.clipY) visible = "old";
          else visible = null; // split by clip line this frame

          if (visible === null) continue;

          // Once a tile is "new", it must never go back to "old". If the
          // renderer flipped the clip direction, the sequence would go
          // new → old somewhere and fail this check.
          if (lastVisible === "new" && visible === "old") {
            throw new Error(
              `${modifierId}: tile (r=${row},c=${col}) went new→old at clipY=${frame.clipY} — reveal direction reversed`,
            );
          }
          lastVisible = visible;

          // Read the actual tile value from the map reference the renderer
          // used for the source of that region. This is the reconstructed
          // "pixel" for this tile on this frame.
          const actual =
            visible === "new"
              ? frame.liveMap.tiles[row]![col]!
              : frame.snapshotMap.tiles[row]![col]!;

          if (visible === "new") {
            sawNew = true;
            assertEquals(
              actual,
              Tile.Water,
              `${modifierId}: reconstructed NEW region at (r=${row},c=${col}) should be Water, got ${actual} (clipY=${frame.clipY})`,
            );
          } else {
            sawOld = true;
            assertEquals(
              actual,
              Tile.Grass,
              `${modifierId}: reconstructed OLD region at (r=${row},c=${col}) should be Grass, got ${actual} (clipY=${frame.clipY})`,
            );
          }
        }

        assert(
          sawOld,
          `${modifierId}: tile (r=${row},c=${col}) never appeared in the OLD (bottom) region during the sweep — reveal covered it before any compose frame sampled`,
        );
        assert(
          sawNew,
          `${modifierId}: tile (r=${row},c=${col}) never appeared in the NEW (top) region during the sweep — reveal never passed it`,
        );
      }
    },
  );
}

Deno.test("upgrade-pick overlay: progressive disappearance during build banner", async () => {
  const recorder = createCanvasRecorder({ discardCalls: true });

  // Pick any registered upgrade seed — the choice doesn't matter for this
  // test, only that we reach the post-upgrade phase banner. small_pieces
  // is registered and resolves quickly.
  using sc = await loadSeed("upgrade:small_pieces", {
    recorder,
    renderObserver: { terrainDrawn: () => {} },
  });

  // Wait for the first UPGRADE_PICKED event, then the next BUILD banner.
  // The upgrade-pick gate runs `showUpgradePickBanner → tryShow → onDone =
  // showBuildPhaseBanner`, so after picks resolve the build banner sweeps
  // in — that's the moment the upgrade overlay should "disappear
  // progressively".
  let upgradePicked = false;
  let buildBannerText: string | null = null;
  let buildBannerEnded = false;

  sc.bus.on(GAME_EVENT.UPGRADE_PICKED, () => {
    upgradePicked = true;
  });
  sc.bus.on(GAME_EVENT.BANNER_START, (ev) => {
    if (
      upgradePicked &&
      buildBannerText === null &&
      ev.phase === Phase.WALL_BUILD &&
      ev.modifierId === undefined
    ) {
      buildBannerText = ev.text;
    }
  });
  sc.bus.on(GAME_EVENT.BANNER_END, (ev) => {
    if (
      buildBannerText !== null &&
      !buildBannerEnded &&
      ev.text === buildBannerText
    ) {
      buildBannerEnded = true;
    }
  });

  // Sample dialog state across the battle banner sweep. Capture every
  // frame: was the upgrade-pick dialog still around? what was the banner
  // progress at that moment?
  interface OverlayFrame {
    progress: number;
    upgradePickPresent: boolean;
  }
  const overlayFrames: OverlayFrame[] = [];
  sc.runUntil(() => {
    if (buildBannerText === null) return false;
    if (buildBannerEnded) return true;
    overlayFrames.push({
      progress: sc.banner().progress,
      upgradePickPresent: sc.dialogs().upgradePick !== null,
    });
    return false;
  }, MAX_TICKS);

  assert(upgradePicked, "no upgrade was ever picked");
  assert(
    buildBannerText !== null,
    "BUILD banner after UPGRADE_PICKED never fired",
  );
  assert(buildBannerEnded, "BUILD banner after UPGRADE_PICKED never ended");
  assert(
    overlayFrames.length >= MIN_SWEEP_SAMPLES,
    `expected ≥${MIN_SWEEP_SAMPLES} sampled frames during the build banner, got ${overlayFrames.length}`,
  );

  // For the dialog to "disappear progressively" instead of snapping off,
  // it must still be present in `runtimeState.dialogs.upgradePick` for at
  // least the early portion of the build banner sweep. The renderer's
  // drawUpgradePick uses `clipBottom = banner.y - bannerH/2` to fade the
  // dialog as the sweep progresses; that math only fires when the dialog
  // is non-null at draw time.
  const earlyFrames = overlayFrames.filter((f) => f.progress < 0.5);
  const upgradePickEarlyCount = earlyFrames.filter(
    (f) => f.upgradePickPresent,
  ).length;
  assert(earlyFrames.length > 0, "no early-sweep frames sampled");
  assert(
    upgradePickEarlyCount > 0,
    `upgrade-pick overlay was already gone by the time the build banner started — dialog snaps off instead of disappearing progressively. Sampled ${earlyFrames.length} early frames, ${upgradePickEarlyCount} had the dialog present.`,
  );
});

/** Read the tile value at a packed `row * GRID_COLS + col` key. */
function tileAt(map: GameMap, key: number): number {
  const row = Math.floor(key / GRID_COLS);
  const col = key % GRID_COLS;
  return map.tiles[row]![col]!;
}

/** Pick up to `count` tiles from `changedTiles`, spread across distinct rows
 *  when possible. A single row doesn't exercise the sweep at different
 *  clip-crossing points, so we prefer row diversity.
 *
 *  Skips the very last row of the map: its tileBottom equals `H` exactly,
 *  so the sweep only fully reveals it at clipY=H — a value the renderer
 *  never composites (its `if (clipY >= H) return;` guard early-exits). We
 *  can't observe a "new" state for that row, so the test would see
 *  `sawNew=false` and throw. Every other row is fine. */
function chooseSampleTiles(
  changedTiles: readonly number[],
  count: number,
): readonly number[] {
  const byRow = new Map<number, number>();
  for (const key of changedTiles) {
    const row = Math.floor(key / GRID_COLS);
    if ((row + 1) * TILE_SIZE >= MAP_PX_H) continue; // skip final row
    if (!byRow.has(row)) byRow.set(row, key);
    if (byRow.size >= count) break;
  }
  if (byRow.size > 0) return Array.from(byRow.values());
  return changedTiles.slice(0, count);
}
