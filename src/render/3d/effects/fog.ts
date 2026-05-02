/**
 * 3D fog-of-war overlay — Phase 6 of the 3D renderer migration.
 *
 * When fog-of-war is active, each castle's interior + walls (dilated by
 * one tile in all 8 directions) is blanketed with a near-opaque grey
 * layer so opponents must aim from memory. The 2D path paints this as
 * per-tile rectangles with a subtle drifting highlight band. The 3D
 * path reproduces it with two `InstancedMesh`es — one for the opaque
 * base, one for the drifting highlight band — so the whole overlay is
 * two draw calls regardless of fog footprint size.
 *
 * Per-instance animation: base tiles are static (one `setMatrixAt` per
 * tile at rebuild time). Band tiles update `setMatrixAt` each frame to
 * drift along Z, and `setColorAt` modulates per-tile brightness to
 * approximate the original alpha wave (material alpha stays constant;
 * per-instance color scales the highlight color from dim to full).
 *
 * Rebuild cadence: the fogged tile set only changes when walls are
 * destroyed/added or a castle's interior shifts. A cheap integer
 * fingerprint (size + running-xor of keys) gates rebuild so the hot
 * path allocates nothing.
 */

import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { DIRS_8, packTile, unpackTile } from "../../../shared/core/spatial.ts";
import { ELEVATION_STACK, RENDER_ORDER, Z_FIGHT_MARGIN } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { tileSeed } from "./helpers.ts";

interface FogManager {
  /** Per-frame update. Rebuilds the fog tile set only when castles'
   *  interior/wall composition changes; otherwise just re-drives the
   *  highlight band positions + brightness from `now`. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface FogTile {
  row: number;
  col: number;
  seed: number;
}

// Fog visual — mirror render-effects.ts constants.
const FOG_BASE_ALPHA = 0.95;
// 120, 128, 140 → 0x78808c
const FOG_BASE_COLOR = 0x78808c;
// 200, 210, 220 → 0xc8d2dc
const FOG_HIGHLIGHT_COLOR = 0xc8d2dc;
const FOG_HIGHLIGHT_ALPHA = 0.18;
const FOG_DRIFT_HZ = 0.6;
// Minimum + span of the per-instance brightness wave. Matches the old
// per-tile alpha wave `FOG_HIGHLIGHT_ALPHA * (0.6 + wave * 0.4)`: the
// material holds max alpha and the instance color scales brightness.
const FOG_WAVE_MIN = 0.6;
const FOG_WAVE_SPAN = 0.4;
const INITIAL_CAPACITY = 64;

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

  const baseMaterial = new THREE.MeshBasicMaterial({
    color: FOG_BASE_COLOR,
    transparent: true,
    opacity: FOG_BASE_ALPHA,
    depthWrite: false,
  });
  const bandMaterial = new THREE.MeshBasicMaterial({
    color: FOG_HIGHLIGHT_COLOR,
    transparent: true,
    opacity: FOG_HIGHLIGHT_ALPHA,
    depthWrite: false,
  });

  let baseMesh: THREE.InstancedMesh | undefined;
  let bandMesh: THREE.InstancedMesh | undefined;
  let capacity = 0;

  const tiles: FogTile[] = [];
  const scratchMatrix = new THREE.Matrix4();
  const scratchColor = new THREE.Color();
  // Reused across frames so `dilateInto` doesn't allocate. `clear()` then refill.
  const keys = new Set<number>();
  let lastFingerprint = -1;

  function ensureCapacity(required: number): void {
    if (baseMesh && bandMesh && required <= capacity) return;
    disposeMeshes();
    capacity = Math.max(INITIAL_CAPACITY, nextPowerOfTwo(required));
    baseMesh = new THREE.InstancedMesh(tileGeometry, baseMaterial, capacity);
    baseMesh.count = 0;
    baseMesh.frustumCulled = false;
    baseMesh.renderOrder = RENDER_ORDER.FOG;
    baseMesh.name = "fog-base";
    root.add(baseMesh);
    bandMesh = new THREE.InstancedMesh(bandGeometry, bandMaterial, capacity);
    bandMesh.count = 0;
    bandMesh.frustumCulled = false;
    bandMesh.renderOrder = RENDER_ORDER.FOG + 1;
    bandMesh.name = "fog-band";
    // Allocate the per-instance color buffer up-front so `setColorAt`
    // works immediately in the per-frame update.
    bandMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    root.add(bandMesh);
  }

  function disposeMeshes(): void {
    if (baseMesh) {
      root.remove(baseMesh);
      baseMesh.dispose();
      baseMesh = undefined;
    }
    if (bandMesh) {
      root.remove(bandMesh);
      bandMesh.dispose();
      bandMesh = undefined;
    }
    capacity = 0;
  }

  function rebuild(): void {
    tiles.length = 0;
    for (const key of keys) {
      const { r, c } = unpackTile(key);
      tiles.push({ row: r, col: c, seed: tileSeed(r, c) });
    }
    ensureCapacity(tiles.length);
    if (!baseMesh) return;
    // Base instance matrices are static — write once here, band fills
    // positions per-frame in the animation loop.
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!;
      scratchMatrix.makeTranslation(
        tile.col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.FOG,
        tile.row * TILE_SIZE + TILE_SIZE / 2,
      );
      baseMesh.setMatrixAt(i, scratchMatrix);
    }
    baseMesh.count = tiles.length;
    baseMesh.instanceMatrix.needsUpdate = true;
    if (bandMesh) bandMesh.count = tiles.length;
  }

  function update(ctx: FrameCtx): void {
    const { overlay, now } = ctx;
    const fogActive = !!overlay?.battle?.fogOfWar;
    const castles = overlay?.castles;

    if (!fogActive || !castles || castles.length === 0) {
      if (lastFingerprint !== 0) {
        lastFingerprint = 0;
        keys.clear();
        tiles.length = 0;
        if (baseMesh) baseMesh.count = 0;
        if (bandMesh) bandMesh.count = 0;
      }
      return;
    }

    keys.clear();
    for (const castle of castles) {
      if (castle.interior.size === 0) continue;
      const walls =
        overlay?.battle?.battleWalls?.[castle.playerId] ?? castle.walls;
      dilateInto(keys, castle.interior, walls);
    }

    const fingerprint = computeFingerprint(keys);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      rebuild();
    }

    if (tiles.length === 0 || !bandMesh) return;
    const time = now / 1000;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!;
      const wave = Math.sin(time * FOG_DRIFT_HZ + tile.seed);
      const brightness = FOG_WAVE_MIN + Math.max(0, wave) * FOG_WAVE_SPAN;
      scratchColor.setHex(FOG_HIGHLIGHT_COLOR).multiplyScalar(brightness);
      bandMesh.setColorAt(i, scratchColor);
      // 2D moves the band between y=py and y=py + (TILE_SIZE - 3). We map
      // that vertical offset onto Z.
      const bandOffset =
        (Math.sin(time + tile.seed) + 1) * 0.5 * (TILE_SIZE - 3);
      scratchMatrix.makeTranslation(
        tile.col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.FOG + Z_FIGHT_MARGIN,
        tile.row * TILE_SIZE + 1 + bandOffset,
      );
      bandMesh.setMatrixAt(i, scratchMatrix);
    }
    bandMesh.instanceMatrix.needsUpdate = true;
    if (bandMesh.instanceColor) bandMesh.instanceColor.needsUpdate = true;
  }

  function dispose(): void {
    disposeMeshes();
    tileGeometry.dispose();
    bandGeometry.dispose();
    baseMaterial.dispose();
    bandMaterial.dispose();
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
  for (const key of interior) dilateKey(out, key);
  for (const key of walls) dilateKey(out, key);
}

function dilateKey(out: Set<number>, key: number): void {
  out.add(key);
  const { r, c } = unpackTile(key);
  for (const [dr, dc] of DIRS_8) {
    out.add(packTile(r + dr, c + dc));
  }
}

/** Cheap O(n) fingerprint of a packed-key set. Size + running xor +
 *  additive hash: flips for any add/remove without sorting or joining
 *  strings. Collisions are theoretically possible but negligible for
 *  our footprint sizes (≤ a few hundred tiles). Reserves `0` to mean
 *  "fog inactive" so the toggle reliably triggers a clear. */
function computeFingerprint(packedKeys: Set<number>): number {
  if (packedKeys.size === 0) return -2;
  let hash = packedKeys.size;
  for (const key of packedKeys) {
    hash = (hash * 31 + key) | 0;
    hash ^= key;
  }
  return hash === 0 ? 1 : hash;
}

function nextPowerOfTwo(value: number): number {
  let power = 1;
  while (power < value) power <<= 1;
  return power;
}
