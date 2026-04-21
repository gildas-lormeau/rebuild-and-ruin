/**
 * 3D placement phantoms — migrates the 2D `drawPhantoms` overlay onto
 * the WebGL world canvas. Covers both piece phantoms (the tetromino
 * cell previews rendered during `WALL_BUILD`) and cannon phantoms
 * (the 2×2 / 3×3 footprint preview rendered during `CANNON_PLACE`).
 *
 * Piece phantoms stay as flat, semi-transparent boxes — they're
 * high-churn (every pointer move rebuilds them) and one cell per offset
 * means a box is the cheapest readable marker.
 *
 * Cannon phantoms use the real authored cannon/rampart/balloon-base
 * sprite geometry (same builders as the live-entity path) rendered with
 * cloned transparent materials. The 2D path draws the actual cannon
 * sprite at alpha; the 3D phantom is the same idea applied to the 3D
 * sprite. Variant selection:
 *
 *   • BALLOON  → `balloon_base` via `buildBalloon`
 *   • RAMPART  → `rampart_cannon` via `buildRampart` (no rotation)
 *   • SUPER    → `super_gun` via `buildCannon` (3×3 footprint)
 *   • default  → `tier_1` via `buildCannon` (2×2 footprint)
 *
 * Rotation uses `defaultFacings.get(playerId)` — the player's last cannon
 * facing — so the ghost aims the same way the placed cannon will.
 * Rampart and balloon variants don't rotate (matches the 2D picker).
 *
 * Rebuild cadence: host groups are pooled per phantom slot and only
 * torn down when a slot's variant OR validity flips. Position / rotation
 * update every frame (positions follow pointer motion).
 */

import * as THREE from "three";
import {
  isBalloonMode,
  isRampartMode,
  isSuperMode,
} from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type {
  RenderCannonPhantom,
  RenderOverlay,
  RenderPiecePhantom,
} from "../../../shared/ui/overlay-types.ts";
import { buildBalloon, getBalloonVariant } from "../sprites/balloon-scene.ts";
import { buildCannon, getCannonVariant } from "../sprites/cannon-scene.ts";
import { buildRampart, getRampartVariant } from "../sprites/rampart-scene.ts";
import { type ExtractedSubPart, extractSubParts } from "./entity-helpers.ts";

export interface PhantomsManager {
  /** Rebuild phantom meshes from the current overlay's `phantoms`
   *  field. Called every frame; typical cost is a handful of instance
   *  matrix writes. */
  update(overlay: RenderOverlay | undefined): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

type CannonVariantName =
  | "tier_1"
  | "super_gun"
  | "rampart_cannon"
  | "balloon_base";

interface CannonTemplate {
  subParts: ExtractedSubPart[];
  /** Whether this variant rotates with the player's default facing.
   *  Rampart has no barrel; balloon-base stakes are symmetric. */
  rotatable: boolean;
  /** Footprint in tiles. Super-gun is 3; everything else is 2. */
  footprint: number;
}

interface CannonHost {
  group: THREE.Group;
  variant: CannonVariantName;
  valid: boolean;
  clonedMaterials: THREE.Material[];
}

// Piece-phantom box styling — unchanged from the original flat-box impl.
const PIECE_VALID_COLOR = 0x40ff40;
const PIECE_INVALID_COLOR = 0xff4040;
const PIECE_OPACITY = 0.4;
const PIECE_Y_LIFT = 0.5;
const PIECE_BOX_HEIGHT = 2;
// Cannon-phantom ghost styling — matches the 2D `PHANTOM_CANNON_ALPHA`
// (valid) and `PHANTOM_CANNON_INVALID_ALPHA` (invalid). The invalid
// case is additionally tinted red so the phantom reads as blocked at a
// glance even on small targets.
const CANNON_VALID_OPACITY = 0.7;
const CANNON_INVALID_OPACITY = 0.5;
// Per-channel multipliers blended with the authored diffuse color when
// the placement is invalid. Keeps relative brightness but shifts hue
// strongly toward red.
const INVALID_TINT = new THREE.Color(1.0, 0.32, 0.32);

export function createPhantomsManager(scene: THREE.Scene): PhantomsManager {
  const root = new THREE.Group();
  root.name = "phantoms";
  scene.add(root);

  // Piece-phantom state ---------------------------------------------------
  const pieceBox = new THREE.BoxGeometry(1, PIECE_BOX_HEIGHT, 1);
  const pieceValidMaterial = new THREE.MeshBasicMaterial({
    color: PIECE_VALID_COLOR,
    transparent: true,
    opacity: PIECE_OPACITY,
    depthWrite: false,
  });
  const pieceInvalidMaterial = new THREE.MeshBasicMaterial({
    color: PIECE_INVALID_COLOR,
    transparent: true,
    opacity: PIECE_OPACITY,
    depthWrite: false,
  });
  const pieceValidMeshes: THREE.Mesh[] = [];
  const pieceInvalidMeshes: THREE.Mesh[] = [];
  let pieceValidCount = 0;
  let pieceInvalidCount = 0;

  // Cannon-phantom state --------------------------------------------------
  const cannonTemplates = new Map<CannonVariantName, CannonTemplate>();
  const cannonHosts: CannonHost[] = [];

  function acquirePieceMesh(valid: boolean): THREE.Mesh {
    const pool = valid ? pieceValidMeshes : pieceInvalidMeshes;
    const material = valid ? pieceValidMaterial : pieceInvalidMaterial;
    const used = valid ? pieceValidCount : pieceInvalidCount;
    if (used < pool.length) {
      const mesh = pool[used]!;
      mesh.visible = true;
      if (valid) pieceValidCount += 1;
      else pieceInvalidCount += 1;
      return mesh;
    }
    const mesh = new THREE.Mesh(pieceBox, material);
    mesh.frustumCulled = false;
    pool.push(mesh);
    root.add(mesh);
    if (valid) pieceValidCount += 1;
    else pieceInvalidCount += 1;
    return mesh;
  }

  function hideUnusedPieces(): void {
    for (let i = pieceValidCount; i < pieceValidMeshes.length; i++) {
      pieceValidMeshes[i]!.visible = false;
    }
    for (let i = pieceInvalidCount; i < pieceInvalidMeshes.length; i++) {
      pieceInvalidMeshes[i]!.visible = false;
    }
  }

  function placePieceCell(
    phantom: RenderPiecePhantom,
    dr: number,
    dc: number,
  ): void {
    const col = phantom.col + dc;
    const row = phantom.row + dr;
    const mesh = acquirePieceMesh(phantom.valid);
    mesh.position.set(
      (col + 0.5) * TILE_SIZE,
      PIECE_Y_LIFT + PIECE_BOX_HEIGHT / 2,
      (row + 0.5) * TILE_SIZE,
    );
    mesh.scale.set(TILE_SIZE, 1, TILE_SIZE);
    mesh.rotation.set(0, 0, 0);
  }

  function ensureCannonTemplate(
    variant: CannonVariantName,
  ): CannonTemplate | undefined {
    const cached = cannonTemplates.get(variant);
    if (cached) return cached;
    const scratch = new THREE.Group();
    let footprint = 2;
    let rotatable = true;
    if (variant === "rampart_cannon") {
      const entry = getRampartVariant(variant);
      if (!entry) return undefined;
      buildRampart(THREE, scratch, entry.params);
      rotatable = false;
    } else if (variant === "balloon_base") {
      const entry = getBalloonVariant(variant);
      if (!entry) return undefined;
      buildBalloon(THREE, scratch, entry);
      rotatable = false;
    } else {
      const entry = getCannonVariant(variant);
      if (!entry) return undefined;
      buildCannon(THREE, scratch, entry.params);
      if (variant === "super_gun") footprint = 3;
    }
    const subParts = extractSubParts(scratch);
    const template: CannonTemplate = { subParts, rotatable, footprint };
    cannonTemplates.set(variant, template);
    return template;
  }

  function buildCannonHost(
    variant: CannonVariantName,
    valid: boolean,
    template: CannonTemplate,
  ): CannonHost {
    const group = new THREE.Group();
    const clonedMaterials: THREE.Material[] = [];
    for (const part of template.subParts) {
      const source = Array.isArray(part.material)
        ? part.material[0]!
        : part.material;
      const mat = source.clone();
      mat.transparent = true;
      mat.opacity = valid ? CANNON_VALID_OPACITY : CANNON_INVALID_OPACITY;
      mat.depthWrite = false;
      if (
        !valid &&
        (mat instanceof THREE.MeshStandardMaterial ||
          mat instanceof THREE.MeshBasicMaterial)
      ) {
        mat.color.multiply(INVALID_TINT);
      }
      clonedMaterials.push(mat);
      const mesh = new THREE.Mesh(part.geometry, mat);
      mesh.applyMatrix4(part.localMatrix);
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    root.add(group);
    return { group, variant, valid, clonedMaterials };
  }

  function disposeCannonHost(host: CannonHost): void {
    for (const mat of host.clonedMaterials) mat.dispose();
    root.remove(host.group);
  }

  function selectCannonVariant(
    phantom: RenderCannonPhantom,
  ): CannonVariantName {
    if (isBalloonMode(phantom.mode)) return "balloon_base";
    if (isRampartMode(phantom.mode)) return "rampart_cannon";
    if (isSuperMode(phantom.mode)) return "super_gun";
    return "tier_1";
  }

  function placeCannon(
    phantom: RenderCannonPhantom,
    index: number,
    facings: ReadonlyMap<number, number> | undefined,
  ): void {
    const variant = selectCannonVariant(phantom);
    const template = ensureCannonTemplate(variant);
    if (!template) return;
    const existing = cannonHosts[index];
    let host: CannonHost;
    if (
      !existing ||
      existing.variant !== variant ||
      existing.valid !== phantom.valid
    ) {
      if (existing) disposeCannonHost(existing);
      host = buildCannonHost(variant, phantom.valid, template);
      cannonHosts[index] = host;
    } else {
      host = existing;
    }
    const offset = (template.footprint / 2) * TILE_SIZE;
    host.group.position.set(
      phantom.col * TILE_SIZE + offset,
      0,
      phantom.row * TILE_SIZE + offset,
    );
    host.group.scale.setScalar(TILE_SIZE);
    const facing = template.rotatable
      ? (facings?.get(phantom.playerId) ?? 0)
      : 0;
    host.group.rotation.y = -facing;
    host.group.visible = true;
  }

  function trimCannonHosts(liveCount: number): void {
    while (cannonHosts.length > liveCount) {
      const host = cannonHosts.pop();
      if (host) disposeCannonHost(host);
    }
  }

  function update(overlay: RenderOverlay | undefined): void {
    pieceValidCount = 0;
    pieceInvalidCount = 0;

    const phantoms = overlay?.phantoms;
    if (phantoms?.piecePhantoms) {
      for (const phantom of phantoms.piecePhantoms) {
        for (const [dr, dc] of phantom.offsets) {
          placePieceCell(phantom, dr, dc);
        }
      }
    }
    hideUnusedPieces();

    const cannonPhantoms = phantoms?.cannonPhantoms ?? [];
    const facings = phantoms?.defaultFacings;
    for (let i = 0; i < cannonPhantoms.length; i++) {
      placeCannon(cannonPhantoms[i]!, i, facings);
    }
    trimCannonHosts(cannonPhantoms.length);
  }

  function dispose(): void {
    // Piece pools
    for (const mesh of pieceValidMeshes) root.remove(mesh);
    for (const mesh of pieceInvalidMeshes) root.remove(mesh);
    pieceValidMeshes.length = 0;
    pieceInvalidMeshes.length = 0;
    pieceBox.dispose();
    pieceValidMaterial.dispose();
    pieceInvalidMaterial.dispose();
    // Cannon hosts + templates
    for (const host of cannonHosts) disposeCannonHost(host);
    cannonHosts.length = 0;
    for (const template of cannonTemplates.values()) {
      for (const part of template.subParts) {
        part.geometry.dispose();
        const mats = Array.isArray(part.material)
          ? part.material
          : [part.material];
        for (const mat of mats) mat.dispose();
      }
    }
    cannonTemplates.clear();
    scene.remove(root);
  }

  return { update, dispose };
}
