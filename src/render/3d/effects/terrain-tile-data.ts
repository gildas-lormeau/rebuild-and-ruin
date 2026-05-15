/**
 * Per-tile metadata texture (`GRID_COLS × GRID_ROWS` RGBA8) sampled by
 * the terrain shader: R = ownerId+1 (0 unowned, 1..MAX_PLAYERS player),
 * G = flag bits (`FLAG_FROZEN`, `FLAG_FLOODED`, `FLAG_EXPOSED`; bit 0
 * reserved), B/A reserved. Refreshed when interior / frozen / flooded /
 * exposed / battle-mode change.
 */

import * as THREE from "three";
import { Phase } from "../../../shared/core/game-phase.ts";
import { GRID_COLS, GRID_ROWS } from "../../../shared/core/grid.ts";
import {
  interiorOwnersFromOverlay,
  interiorRefsMatch,
  snapshotInteriorRefs,
} from "../../overlay-helpers.ts";
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
  frozenTiles: ReadonlySet<number> | undefined;
  highTideActive: boolean;
  exposedRiverbedTiles: ReadonlySet<number> | undefined;
  inBattle: boolean;
}

/** Bit masks for the G channel. Kept in sync with the GLSL constants in
 *  `terrain.ts`'s shader patch. Bit 0 is reserved. */
const FLAG_FROZEN = 2;
const FLAG_FLOODED = 4;
const FLAG_EXPOSED = 8;

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
    const inBattle = overlay.phase === Phase.BATTLE;
    const frozenTiles = overlay.entities?.frozenTiles;
    const floodedTiles = overlay.entities?.floodedTiles;
    const exposedRiverbedTiles = overlay.entities?.exposedRiverbedTiles;
    const highTideActive = floodedTiles !== undefined;

    // `mapVersion` covers in-place mutations of frozenTiles (see ICE_THAWED
    // in battle-system.ts — `frozenTiles.delete()` keeps the same Set
    // reference but bumps mapVersion). Without this, ref equality alone
    // would let a thawed-mid-battle tile keep showing as ice until the
    // next phase replaced the Set wholesale. high_tide / low_water also
    // bump mapVersion on apply/clear so the flooded / exposed paint
    // flips on the same frame the modifier becomes (in)active.
    if (
      lastFingerprint &&
      lastFingerprint.mapVersion === map.mapVersion &&
      lastFingerprint.inBattle === inBattle &&
      lastFingerprint.frozenTiles === frozenTiles &&
      lastFingerprint.highTideActive === highTideActive &&
      lastFingerprint.exposedRiverbedTiles === exposedRiverbedTiles &&
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
        if (frozenTiles?.has(tileIdx)) flags |= FLAG_FROZEN;
        if (floodedTiles?.has(tileIdx)) flags |= FLAG_FLOODED;
        if (exposedRiverbedTiles?.has(tileIdx)) flags |= FLAG_EXPOSED;
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
      frozenTiles,
      highTideActive,
      exposedRiverbedTiles,
      inBattle,
    };
  }

  function dispose(): void {
    texture.dispose();
  }

  return { texture, update, dispose };
}
