/**
 * 3D terrain tile-data texture — per-tile metadata (`GRID_COLS × GRID_ROWS`
 * RGBA8) the terrain shader samples to find each fragment's owning player
 * and the sinkhole/frozen flags that gate the per-pixel bank-gradient
 * override.
 *
 * Channels:
 *   - R: ownerId+1 (0 = unowned, 1..MAX_PLAYERS = player)
 *   - G: flag bits (`FLAG_SINKHOLE`, `FLAG_FROZEN`)
 *   - B/A: reserved
 *
 * Refreshed only when the per-player interior Set references / sinkhole
 * tiles / frozen tiles / battle-mode flag change — fingerprint piggybacks
 * on the same `interiorRefsMatch` check the previous 2D second-plane
 * sinkhole overlay relied on.
 */

import * as THREE from "three";
import { GRID_COLS, GRID_ROWS } from "../../../shared/core/grid.ts";
import {
  interiorOwnersFromOverlay,
  interiorRefsMatch,
  snapshotInteriorRefs,
} from "../../../shared/ui/overlay-types.ts";
import type { FrameCtx } from "../frame-ctx.ts";

export interface TerrainTileDataManager {
  readonly texture: THREE.DataTexture;
  /** Per-frame: rebuild the tile-data texture if any input changed. Cheap
   *  no-op on steady-state frames (single fingerprint compare). */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface TileDataFingerprint {
  mapVersion: number;
  interiorRefs: ReadonlyArray<ReadonlySet<number>>;
  sinkholeTiles: ReadonlySet<number> | undefined;
  frozenTiles: ReadonlySet<number> | undefined;
  inBattle: boolean;
}

/** Bit masks for the G channel. Kept in sync with the GLSL constants in
 *  `terrain.ts`'s shader patch. */
const FLAG_SINKHOLE = 1;
const FLAG_FROZEN = 2;

export function createTerrainTileDataManager(): TerrainTileDataManager {
  const data = new Uint8Array(GRID_COLS * GRID_ROWS * 4);
  const texture = new THREE.DataTexture(
    data,
    GRID_COLS,
    GRID_ROWS,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  let lastFingerprint: TileDataFingerprint | undefined;

  function update(ctx: FrameCtx): void {
    const overlay = ctx.overlay;
    const map = ctx.map;
    if (!overlay || !map) return;
    const inBattle = !!overlay.battle?.inBattle;
    const sinkholeTiles = overlay.entities?.sinkholeTiles;
    const frozenTiles = overlay.entities?.frozenTiles;

    // `mapVersion` covers in-place mutations of frozenTiles / sinkholeTiles
    // (see ICE_THAWED in battle-system.ts — `frozenTiles.delete()` keeps
    // the same Set reference but bumps mapVersion). Without this, ref
    // equality alone would let a thawed-mid-battle tile keep showing as
    // ice until the next phase replaced the Set wholesale.
    if (
      lastFingerprint &&
      lastFingerprint.mapVersion === map.mapVersion &&
      lastFingerprint.inBattle === inBattle &&
      lastFingerprint.sinkholeTiles === sinkholeTiles &&
      lastFingerprint.frozenTiles === frozenTiles &&
      interiorRefsMatch(lastFingerprint.interiorRefs, overlay, inBattle)
    ) {
      return;
    }

    const interiorOwners = interiorOwnersFromOverlay(overlay);
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const tileIdx = row * GRID_COLS + col;
        const owner = interiorOwners.get(tileIdx);
        let flags = 0;
        if (sinkholeTiles?.has(tileIdx)) flags |= FLAG_SINKHOLE;
        if (frozenTiles?.has(tileIdx)) flags |= FLAG_FROZEN;
        const dataIdx = tileIdx * 4;
        data[dataIdx] = owner !== undefined ? owner + 1 : 0;
        data[dataIdx + 1] = flags;
        data[dataIdx + 2] = 0;
        data[dataIdx + 3] = 0;
      }
    }
    texture.needsUpdate = true;
    lastFingerprint = {
      mapVersion: map.mapVersion,
      interiorRefs: snapshotInteriorRefs(overlay, inBattle),
      sinkholeTiles,
      frozenTiles,
      inBattle,
    };
  }

  function dispose(): void {
    texture.dispose();
  }

  return { texture, update, dispose };
}
