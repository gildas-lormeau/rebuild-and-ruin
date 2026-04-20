/**
 * 3D placement phantoms — migrates the 2D `drawPhantoms` overlay onto
 * the WebGL world canvas. Covers both piece phantoms (the tetromino
 * cell previews rendered during `WALL_BUILD`) and cannon phantoms
 * (the 2×2 / 3×3 footprint preview rendered during `CANNON_PLACE`).
 *
 * Mesh strategy: phantoms are placement indicators, not final entities.
 * We render each cell as a flat, semi-transparent box sitting on the
 * ground plane:
 *
 *   • Piece phantom  → one 1×1 tile-sized box per cell in `offsets`.
 *     Reuses the 2D "saturated color" behaviour approximately by
 *     picking a green / red tint for valid / invalid; per-player
 *     coloring is dropped here in favour of simple validity read.
 *   • Cannon phantom → one footprint-sized box (2 tiles wide for
 *     normal / rampart / balloon, 3 tiles for super). Same tint scheme.
 *
 * We intentionally skip the full `buildWall` / `buildCannon` geometry:
 * phantoms are high-churn (every pointer move rebuilds them) and the
 * fidelity is meant to read as "ghost preview", not "real wall". A flat
 * ghost box reads clearly and keeps the per-frame cost negligible.
 *
 * Update cadence: phantom position changes every pointer event, so the
 * manager rebuilds unconditionally on each `update` call. Counts are
 * tiny (≤4 piece cells + ≤1 cannon typically), so tear-down and
 * rebuild is cheaper than reconciliation bookkeeping.
 *
 * Validity tint: green `#40ff40` for valid placements, red `#ff4040`
 * for invalid placements — both at ~40% opacity. Matches the
 * "valid = placeable, invalid = blocked" reading used across the UI.
 */

import * as THREE from "three";
import { isSuperMode } from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type {
  RenderCannonPhantom,
  RenderOverlay,
  RenderPiecePhantom,
} from "../../../shared/ui/overlay-types.ts";

export interface PhantomsManager {
  /** Rebuild phantom meshes from the current overlay's `phantoms`
   *  field. Called every frame; typical cost is a handful of instance
   *  matrix writes. */
  update(overlay: RenderOverlay | undefined): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

/** Ghost tint — bright enough to read as a highlight, not overwhelm
 *  the terrain underneath. */
const VALID_COLOR = 0x40ff40;
const INVALID_COLOR = 0xff4040;
const PHANTOM_OPACITY = 0.4;
/** Small lift above the terrain plane so z-fighting with the ground
 *  mesh doesn't shimmer. Matches the effect lift used in impacts. */
const PHANTOM_Y_LIFT = 0.5;
/** Vertical extent of the phantom box — low enough to read as a ghost
 *  marker rather than a wall block, but tall enough to be visible from
 *  the top-down placement camera. */
const PHANTOM_BOX_HEIGHT = 2;

export function createPhantomsManager(scene: THREE.Scene): PhantomsManager {
  const root = new THREE.Group();
  root.name = "phantoms";
  scene.add(root);

  // Unit box centered on the XZ plane. Instanced per phantom with a
  // scale matching the footprint (1 tile for piece cells, 2 or 3 tiles
  // for cannons).
  const unitBox = new THREE.BoxGeometry(1, PHANTOM_BOX_HEIGHT, 1);

  const validMaterial = new THREE.MeshBasicMaterial({
    color: VALID_COLOR,
    transparent: true,
    opacity: PHANTOM_OPACITY,
    depthWrite: false,
  });
  const invalidMaterial = new THREE.MeshBasicMaterial({
    color: INVALID_COLOR,
    transparent: true,
    opacity: PHANTOM_OPACITY,
    depthWrite: false,
  });

  // Reconcile a pool of reusable meshes so we don't churn GPU objects.
  // Separate pools per validity so swapping a mesh in/out is just a
  // visibility toggle.
  const validMeshes: THREE.Mesh[] = [];
  const invalidMeshes: THREE.Mesh[] = [];
  let validCount = 0;
  let invalidCount = 0;

  function acquireMesh(valid: boolean): THREE.Mesh {
    const pool = valid ? validMeshes : invalidMeshes;
    const material = valid ? validMaterial : invalidMaterial;
    const used = valid ? validCount : invalidCount;
    if (used < pool.length) {
      const mesh = pool[used]!;
      mesh.visible = true;
      if (valid) validCount += 1;
      else invalidCount += 1;
      return mesh;
    }
    const mesh = new THREE.Mesh(unitBox, material);
    mesh.frustumCulled = false;
    pool.push(mesh);
    root.add(mesh);
    if (valid) validCount += 1;
    else invalidCount += 1;
    return mesh;
  }

  function hideUnused(): void {
    for (let i = validCount; i < validMeshes.length; i++) {
      validMeshes[i]!.visible = false;
    }
    for (let i = invalidCount; i < invalidMeshes.length; i++) {
      invalidMeshes[i]!.visible = false;
    }
  }

  function placePieceCell(
    phantom: RenderPiecePhantom,
    dr: number,
    dc: number,
  ): void {
    const col = phantom.col + dc;
    const row = phantom.row + dr;
    const mesh = acquireMesh(phantom.valid);
    mesh.position.set(
      (col + 0.5) * TILE_SIZE,
      PHANTOM_Y_LIFT + PHANTOM_BOX_HEIGHT / 2,
      (row + 0.5) * TILE_SIZE,
    );
    mesh.scale.set(TILE_SIZE, 1, TILE_SIZE);
    mesh.rotation.set(0, 0, 0);
  }

  function placeCannon(phantom: RenderCannonPhantom): void {
    // Super is 3×3; everything else (normal / rampart / balloon) is 2×2.
    // Mirrors the 2D picker in `drawPhantomCannon` (render-effects.ts).
    const footprint = isSuperMode(phantom.mode) ? 3 : 2;
    const mesh = acquireMesh(phantom.valid);
    const centerOffset = (footprint / 2) * TILE_SIZE;
    mesh.position.set(
      phantom.col * TILE_SIZE + centerOffset,
      PHANTOM_Y_LIFT + PHANTOM_BOX_HEIGHT / 2,
      phantom.row * TILE_SIZE + centerOffset,
    );
    mesh.scale.set(footprint * TILE_SIZE, 1, footprint * TILE_SIZE);
    mesh.rotation.set(0, 0, 0);
  }

  function update(overlay: RenderOverlay | undefined): void {
    validCount = 0;
    invalidCount = 0;

    const phantoms = overlay?.phantoms;
    if (phantoms) {
      if (phantoms.piecePhantoms) {
        for (const phantom of phantoms.piecePhantoms) {
          for (const [dr, dc] of phantom.offsets) {
            placePieceCell(phantom, dr, dc);
          }
        }
      }
      if (phantoms.cannonPhantoms) {
        for (const phantom of phantoms.cannonPhantoms) {
          placeCannon(phantom);
        }
      }
    }

    hideUnused();
  }

  function dispose(): void {
    for (const mesh of validMeshes) root.remove(mesh);
    for (const mesh of invalidMeshes) root.remove(mesh);
    validMeshes.length = 0;
    invalidMeshes.length = 0;
    unitBox.dispose();
    validMaterial.dispose();
    invalidMaterial.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
