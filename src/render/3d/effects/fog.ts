/**
 * 3D fog-of-war overlay — Phase 6 of the 3D renderer migration.
 *
 * When fog-of-war is active, each castle's interior + walls (dilated by
 * one tile in all 8 directions) is blanketed with a near-opaque grey
 * layer so opponents must aim from memory. The 2D path paints this as
 * per-tile rectangles with a subtle drifting highlight band. The 3D
 * path reproduces it as one filled plane per fogged tile, plus a
 * brightening band that moves along Z to mimic the highlight drift.
 *
 * Rebuild cadence: the fogged tile set only changes when walls are
 * destroyed/added or a castle's interior shifts. We fingerprint by the
 * packed-key list per castle; per-frame updates only rewrite the
 * highlight band offsets. This is cheaper than rebuilding meshes, and
 * fog tile counts are bounded by the map size (≤ ~200 tiles per
 * castle).
 */

import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { DIRS_8, packTile, unpackTile } from "../../../shared/core/spatial.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";

export interface FogManager {
  /** Per-frame update. Rebuilds the fog tile set only when castles'
   *  interior/wall composition changes; otherwise just re-drives the
   *  highlight band positions from `now`. */
  update(overlay: RenderOverlay | undefined, now: number): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface FogTile {
  row: number;
  col: number;
  seed: number;
  baseMesh: THREE.Mesh;
  baseMaterial: THREE.MeshBasicMaterial;
  bandMesh: THREE.Mesh;
  bandMaterial: THREE.MeshBasicMaterial;
}

// Fog visual — mirror render-effects.ts constants.
const FOG_BASE_ALPHA = 0.95;
// 120, 128, 140 → 0x78808c
const FOG_BASE_COLOR = 0x78808c;
// 200, 210, 220 → 0xc8d2dc
const FOG_HIGHLIGHT_COLOR = 0xc8d2dc;
const FOG_HIGHLIGHT_ALPHA = 0.18;
const FOG_DRIFT_HZ = 0.6;
// Seed multipliers from render-effects.ts for per-tile phase jitter.
const SEED_ROW = 41;
const SEED_COL = 17;
// Lift over ground / above other effects. Fog is the visual "top" of the
// world layer — above impacts but below cannonballs and crosshairs
// (matches the 2D ordering in render-map.ts where `drawFogOfWar` runs
// before `drawBattleEffectsAboveFog`).
const FOG_Y_LIFT = 1.2;

export function createFogManager(scene: THREE.Scene): FogManager {
  const root = new THREE.Group();
  root.name = "fog";
  scene.add(root);

  const tileGeometry = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
  tileGeometry.rotateX(-Math.PI / 2);
  // Thin highlight band — 2 px tall drifting line, parity with the 2D
  // 2-px rectangle highlight.
  const bandGeometry = new THREE.PlaneGeometry(TILE_SIZE, 2);
  bandGeometry.rotateX(-Math.PI / 2);

  const tiles: FogTile[] = [];
  let lastSignature: string | undefined;

  function clear(): void {
    for (const tile of tiles) {
      tile.baseMaterial.dispose();
      tile.bandMaterial.dispose();
      root.remove(tile.baseMesh);
      root.remove(tile.bandMesh);
    }
    tiles.length = 0;
  }

  function addTile(row: number, col: number): FogTile {
    const baseMaterial = new THREE.MeshBasicMaterial({
      color: FOG_BASE_COLOR,
      transparent: true,
      opacity: FOG_BASE_ALPHA,
      depthWrite: false,
    });
    const baseMesh = new THREE.Mesh(tileGeometry, baseMaterial);
    baseMesh.position.set(
      col * TILE_SIZE + TILE_SIZE / 2,
      FOG_Y_LIFT,
      row * TILE_SIZE + TILE_SIZE / 2,
    );
    root.add(baseMesh);

    const bandMaterial = new THREE.MeshBasicMaterial({
      color: FOG_HIGHLIGHT_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const bandMesh = new THREE.Mesh(bandGeometry, bandMaterial);
    bandMesh.position.set(
      col * TILE_SIZE + TILE_SIZE / 2,
      FOG_Y_LIFT + 0.1,
      row * TILE_SIZE + TILE_SIZE / 2,
    );
    root.add(bandMesh);

    return {
      row,
      col,
      seed: row * SEED_ROW + col * SEED_COL,
      baseMesh,
      baseMaterial,
      bandMesh,
      bandMaterial,
    };
  }

  function rebuild(tileKeys: Iterable<number>): void {
    clear();
    for (const key of tileKeys) {
      const { r, c } = unpackTile(key);
      tiles.push(addTile(r, c));
    }
  }

  function update(overlay: RenderOverlay | undefined, now: number): void {
    const fogActive = !!overlay?.battle?.fogOfWar;
    const castles = overlay?.castles;

    if (!fogActive || !castles || castles.length === 0) {
      if (lastSignature !== "") {
        lastSignature = "";
        clear();
      }
      return;
    }

    // Build the fog footprint once per frame — reused by signature.
    const keys = new Set<number>();
    for (const castle of castles) {
      if (castle.interior.size === 0) continue;
      const walls =
        overlay?.battle?.battleWalls?.[castle.playerId] ?? castle.walls;
      dilateInto(keys, castle.interior, walls);
    }

    const signature = computeSignature(keys);
    if (signature !== lastSignature) {
      lastSignature = signature;
      rebuild(keys);
    }

    if (tiles.length === 0) return;
    const time = now / 1000;
    for (const tile of tiles) {
      const wave = Math.sin(time * FOG_DRIFT_HZ + tile.seed);
      const highlightAlpha = FOG_HIGHLIGHT_ALPHA * (0.6 + wave * 0.4);
      tile.bandMaterial.opacity = Math.max(0, highlightAlpha);
      // 2D moves the band between y=py and y=py + (TILE_SIZE - 3). We map
      // that vertical offset onto Z.
      const bandOffset =
        (Math.sin(time + tile.seed) + 1) * 0.5 * (TILE_SIZE - 3);
      tile.bandMesh.position.set(
        tile.bandMesh.position.x,
        tile.bandMesh.position.y,
        tile.row * TILE_SIZE + 1 + bandOffset,
      );
    }
  }

  function dispose(): void {
    clear();
    tileGeometry.dispose();
    bandGeometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}

/** Add to `out` every tile in the castle footprint (interior ∪ walls)
 *  dilated by one tile in all 8 directions. Mirrors `dilateFogRegion`
 *  in render-effects.ts. */
function dilateInto(
  out: Set<number>,
  interior: ReadonlySet<number>,
  walls: ReadonlySet<number>,
): void {
  const base = new Set<number>();
  for (const key of interior) base.add(key);
  for (const key of walls) base.add(key);
  for (const key of base) {
    out.add(key);
    const { r, c } = unpackTile(key);
    for (const [dr, dc] of DIRS_8) {
      out.add(packTile(r + dr, c + dc));
    }
  }
}

/** Fingerprint the fog tile set — sorted pack-keys. */
function computeSignature(keys: Set<number>): string {
  if (keys.size === 0) return "";
  const sorted = [...keys].sort((a, b) => a - b);
  return sorted.join(",");
}
