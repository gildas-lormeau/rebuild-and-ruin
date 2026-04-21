/**
 * 3D water fine-wave highlights — parity pass for the 2D `drawWaterAnimation`.
 *
 * The terrain mesh already paints the base `WATER_COLOR` (plus a per-tile
 * sinusoidal brightness shimmer during battle). The 2D path adds on top a
 * denser pattern: three drifting wave highlights per deep-water tile, each a
 * bright 1px line plus a darker 1px shadow underneath. This module
 * reproduces that pattern in the 3D scene by re-rendering the same canvas
 * code each frame onto a reused offscreen canvas, uploading it as a
 * `THREE.CanvasTexture`, and stretching it across a single map-sized flat
 * mesh floating just above the terrain.
 *
 * Design notes:
 *   - Only runs when `overlay.battle.inBattle` is true (matches 2D gate).
 *   - Only paints water tiles whose 4 cardinal neighbors are also water
 *     (bank tiles are skipped). Matches the 2D check.
 *   - Frozen tiles are skipped (they already show as ice in terrain.ts).
 *   - Canvas / context / texture are allocated once and reused; the only
 *     per-frame cost is `clearRect` + N×3 pairs of `fillRect` + a texture
 *     re-upload.
 *   - The mesh sits at a small positive Y so it renders on top of the
 *     terrain quad (Y=0) but below walls / entities that have real height.
 */

import type * as THREE from "three";
import type { GameMap } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { isWater } from "../../../shared/core/spatial.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { ELEVATION_STACK } from "../elevation.ts";
import { createMapLayerCanvas, disposeMapLayerCanvas } from "./layer-canvas.ts";

export interface WaterWavesManager {
  /** Per-frame update. No-op outside battle; otherwise redraws the fine
   *  wave pattern onto the shared offscreen canvas and flags the texture
   *  dirty. */
  update(map: GameMap, overlay: RenderOverlay | undefined, now: number): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

// Mirror `drawWaterAnimation` in render-effects.ts — three drifting wave
// layers with per-layer frequency variation.
const WAVE_LAYERS = 3;
const WAVE_TIME_BASE = 0.8;
const WAVE_TIME_LAYER_STEP = 0.3;
const WAVE_ROW_FREQ = 0.5;
const WAVE_ROW_LAYER_VAR = 0.2;
const WAVE_COL_FREQ = 0.3;
const WAVE_COL_LAYER_VAR = 0.15;
const WAVE_PHASE_OFFSET = 2.1;
// Highlight / shadow colors (same channels as 2D); alpha is driven per-pixel.
const WAVE_HIGHLIGHT_RGB = "140, 200, 255";
const WAVE_SHADOW_RGB = "20, 60, 120";

export function createWaterWavesManager(scene: THREE.Scene): WaterWavesManager {
  const layer = createMapLayerCanvas(scene, {
    yLift: ELEVATION_STACK.WATER_WAVES,
    transparent: true,
  });
  const { canvas, ctx, texture, mesh } = layer;
  mesh.visible = false;

  let lastDrawWasEmpty = true;

  function update(
    map: GameMap,
    overlay: RenderOverlay | undefined,
    now: number,
  ): void {
    if (!overlay?.battle?.inBattle) {
      if (!lastDrawWasEmpty) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        texture.needsUpdate = true;
        lastDrawWasEmpty = true;
      }
      mesh.visible = false;
      return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const time = now / 1000;
    const frozen = overlay.entities?.frozenTiles;
    const sinkholes = overlay.entities?.sinkholeTiles;
    const rows = map.tiles.length;
    const cols = map.tiles[0]?.length ?? 0;

    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (!isWater(map.tiles, r, c)) continue;
        if (frozen?.has(r * cols + c)) continue;
        if (sinkholes?.has(r * cols + c)) continue;
        // Skip bank tiles — any non-water cardinal neighbor disqualifies.
        if (
          !isWater(map.tiles, r - 1, c) ||
          !isWater(map.tiles, r + 1, c) ||
          !isWater(map.tiles, r, c - 1) ||
          !isWater(map.tiles, r, c + 1)
        )
          continue;
        paintTileWaves(ctx, r, c, time);
      }
    }

    texture.needsUpdate = true;
    mesh.visible = true;
    lastDrawWasEmpty = false;
  }

  function dispose(): void {
    disposeMapLayerCanvas(scene, layer);
  }

  return { update, dispose };
}

/** Paint the three drifting wave highlights for a single deep-water tile.
 *  Byte-for-byte mirror of the inner loop in `drawWaterAnimation`. */
function paintTileWaves(
  ctx: CanvasRenderingContext2D,
  row: number,
  col: number,
  time: number,
): void {
  const px = col * TILE_SIZE;
  const py = row * TILE_SIZE;
  for (let layer = 0; layer < WAVE_LAYERS; layer++) {
    const phase =
      time * (WAVE_TIME_BASE + layer * WAVE_TIME_LAYER_STEP) +
      row * (WAVE_ROW_FREQ + layer * WAVE_ROW_LAYER_VAR) +
      col * (WAVE_COL_FREQ + layer * WAVE_COL_LAYER_VAR) +
      layer * WAVE_PHASE_OFFSET;
    const wave = Math.sin(phase) * 0.5 + 0.5;
    const alpha = 0.06 + wave * 0.09;
    const waveY = py + 1 + Math.floor(wave * (TILE_SIZE - 3));
    const waveX = px + 1 + ((layer * 3) % (TILE_SIZE - 4));
    const waveLen = 3 + Math.floor(wave * 4);
    ctx.fillStyle = `rgba(${WAVE_HIGHLIGHT_RGB}, ${alpha})`;
    ctx.fillRect(waveX, waveY, waveLen, 1);
    ctx.fillStyle = `rgba(${WAVE_SHADOW_RGB}, ${alpha * 0.5})`;
    ctx.fillRect(waveX, waveY + 1, waveLen, 1);
  }
}
