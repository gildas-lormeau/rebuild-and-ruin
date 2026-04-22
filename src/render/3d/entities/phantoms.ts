/**
 * 3D placement phantoms — migrates the 2D `drawPhantoms` overlay onto
 * the WebGL world canvas. Covers both piece phantoms (the tetromino
 * cell previews rendered during `WALL_BUILD`) and cannon phantoms
 * (the 2×2 / 3×3 footprint preview rendered during `CANNON_PLACE`).
 *
 * Piece phantoms render as tile-sized blocks in the player's wall
 * colour — saturated (like the 2D `PHANTOM_SATURATION` pass) and
 * semi-transparent. Each face gets a different shade so the block
 * reads with a natural bevel: top brighter, sides mid, bottom darker
 * (mirrors the 2D bevel of top/left highlight + bottom/right shadow
 * reduced to the axes a 3D camera actually sees). Invalid placements
 * blend toward red using the same `face * 0.15 + red-bias` recipe as
 * the 2D path.
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
 * torn down when a slot's identity (variant/valid or playerId/valid)
 * flips. Position / rotation update every frame (positions follow
 * pointer motion).
 */

import * as THREE from "three";
import { NORMAL_CANNON_SIZE } from "../../../shared/core/game-constants.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../../../shared/core/player-slot.ts";
import type {
  RenderCannonPhantom,
  RenderPiecePhantom,
} from "../../../shared/ui/overlay-types.ts";
import { getPlayerColor } from "../../../shared/ui/player-config.ts";
import type { RGB } from "../../../shared/ui/theme.ts";
import { ELEVATION_STACK, RENDER_ORDER } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { buildBalloon, getBalloonVariant } from "../sprites/balloon-scene.ts";
import { buildCannon, getCannonVariant } from "../sprites/cannon-scene.ts";
import { buildRampart, getRampartVariant } from "../sprites/rampart-scene.ts";
import {
  cannonKind,
  type ExtractedSubPart,
  extractSubParts,
} from "./entity-helpers.ts";

export interface PhantomsManager {
  /** Rebuild phantom meshes from the current overlay's `phantoms`
   *  field. Called every frame; typical cost is a handful of instance
   *  matrix writes. */
  update(ctx: FrameCtx): void;
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

/** Cache key for piece-phantom material sets: one entry per
 *  (playerId, valid) pair seen this session. */
type PieceMaterialKey = `${number}:${0 | 1}`;

interface PieceMaterialSet {
  material: THREE.MeshBasicMaterial;
  texture: THREE.CanvasTexture;
}

// Piece-phantom styling — matches the 2D `drawPiecePhantom` feel.
// `PHANTOM_PIECE_ALPHA` / `PHANTOM_PIECE_INVALID_ALPHA` in the 2D path
// are 0.85 / 0.55; PHANTOM_SATURATION is 2.5; BEVEL_HIGHLIGHT_ADD is
// 80; BEVEL_SHADOW_MULT is 0.45. Keep the same numbers so the 3D
// phantom reads the same.
const PIECE_VALID_OPACITY = 0.85;
const PIECE_INVALID_OPACITY = 0.55;
const PIECE_SATURATION = 2.5;
const PIECE_BEVEL_HIGHLIGHT_ADD = 80;
const PIECE_BEVEL_SHADOW_MULT = 0.45;
const PIECE_BEVEL_W = 2;
/** Per-cell texture resolution. TILE_SIZE is 16 world-units per tile
 *  and our target is pixel-perfect parity with the 2D bevel strips
 *  (2 px wide on a 16 px tile), so we bake at 1 canvas-pixel per
 *  world-unit. NearestFilter keeps the strips crisp at any zoom. */
const PIECE_TEXTURE_SIZE = TILE_SIZE;
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
  // Unit quad rotated into the XZ plane so v=0 (top of canvas) maps to
  // local −Z (north of tile) — same convention the map-layer canvas uses.
  const pieceQuad = new THREE.PlaneGeometry(1, 1);
  pieceQuad.rotateX(-Math.PI / 2);
  // One material + texture per (playerId, valid); a full session only
  // mints a handful of entries (≤3 players × 2 validity = 6 sets).
  const pieceMaterialCache = new Map<PieceMaterialKey, PieceMaterialSet>();
  const pieceMeshes: THREE.Mesh[] = [];
  let pieceMeshCount = 0;

  // Cannon-phantom state --------------------------------------------------
  const cannonTemplates = new Map<CannonVariantName, CannonTemplate>();
  const cannonHosts: CannonHost[] = [];

  function ensurePieceMaterial(
    playerId: ValidPlayerSlot,
    valid: boolean,
  ): PieceMaterialSet {
    const key: PieceMaterialKey = `${playerId}:${valid ? 1 : 0}`;
    const cached = pieceMaterialCache.get(key);
    if (cached) return cached;
    const wall = getPlayerColor(playerId).wall;
    const texture = buildPieceTexture(wall, valid);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: valid ? PIECE_VALID_OPACITY : PIECE_INVALID_OPACITY,
      depthWrite: false,
      depthTest: false,
    });
    const set: PieceMaterialSet = { material, texture };
    pieceMaterialCache.set(key, set);
    return set;
  }

  function acquirePieceMesh(materials: PieceMaterialSet): THREE.Mesh {
    if (pieceMeshCount < pieceMeshes.length) {
      const mesh = pieceMeshes[pieceMeshCount]!;
      mesh.material = materials.material;
      mesh.visible = true;
      pieceMeshCount += 1;
      return mesh;
    }
    const mesh = new THREE.Mesh(pieceQuad, materials.material);
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER.PHANTOM;
    pieceMeshes.push(mesh);
    root.add(mesh);
    pieceMeshCount += 1;
    return mesh;
  }

  function hideUnusedPieces(): void {
    for (let i = pieceMeshCount; i < pieceMeshes.length; i++) {
      pieceMeshes[i]!.visible = false;
    }
  }

  function placePieceCell(
    phantom: RenderPiecePhantom,
    dr: number,
    dc: number,
  ): void {
    const col = phantom.col + dc;
    const row = phantom.row + dr;
    const materials = ensurePieceMaterial(phantom.playerId, phantom.valid);
    const mesh = acquirePieceMesh(materials);
    mesh.position.set(
      (col + 0.5) * TILE_SIZE,
      ELEVATION_STACK.PIECE_PHANTOM,
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
      mat.depthTest = false;
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
      mesh.renderOrder = RENDER_ORDER.PHANTOM;
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
    // Phantoms carry only `mode` — no mortar flag — so the "mortar"
    // kind is never produced for a phantom; we still list the case in
    // the switch so adding a new CannonMode fails the exhaustiveness
    // check. Mortar phantoms fall through to the tier_1 base, matching
    // the pre-refactor default.
    const kind = cannonKind({ mode: phantom.mode });
    switch (kind) {
      case "balloon":
        return "balloon_base";
      case "rampart":
        return "rampart_cannon";
      case "super":
        return "super_gun";
      case "mortar":
      case "tier_1":
        return "tier_1";
    }
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
    host.group.scale.setScalar(
      (template.footprint * TILE_SIZE) / NORMAL_CANNON_SIZE,
    );
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

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    pieceMeshCount = 0;

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
    for (const mesh of pieceMeshes) root.remove(mesh);
    pieceMeshes.length = 0;
    pieceQuad.dispose();
    for (const set of pieceMaterialCache.values()) {
      set.material.dispose();
      set.texture.dispose();
    }
    pieceMaterialCache.clear();
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

/** Bake a per-tile texture that mirrors the 2D `drawPiecePhantom` fill
 *  + bevel strips: saturated base colour, top/left highlight lines,
 *  bottom/right shadow lines. Invalid placements blend toward red using
 *  the same `face * 0.15 + red-bias` recipe as the 2D path. */
function buildPieceTexture(wall: RGB, valid: boolean): THREE.CanvasTexture {
  const size = PIECE_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const face = saturateRgb(wall, PIECE_SATURATION);
  const base: RGB = valid
    ? face
    : [
        Math.min(255, Math.round(face[0] * 0.3 + 170)),
        Math.round(face[1] * 0.15),
        Math.round(face[2] * 0.15),
      ];
  const hi = addChannel(base, PIECE_BEVEL_HIGHLIGHT_ADD);
  const sh = mulChannel(base, PIECE_BEVEL_SHADOW_MULT);
  const bv = PIECE_BEVEL_W;

  ctx.fillStyle = rgbCss(base);
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = rgbCss(hi);
  ctx.fillRect(0, 0, size, bv); // top highlight (v=0 → north)
  ctx.fillRect(0, 0, bv, size); // left highlight (u=0 → west)
  ctx.fillStyle = rgbCss(sh);
  ctx.fillRect(0, size - bv, size, bv); // bottom shadow
  ctx.fillRect(size - bv, 0, bv, size); // right shadow

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function saturateRgb(c: RGB, factor: number): RGB {
  const avg = (c[0] + c[1] + c[2]) / 3;
  return [
    Math.round(Math.min(255, c[0] + (c[0] - avg) * factor)),
    Math.round(Math.min(255, c[1] + (c[1] - avg) * factor)),
    Math.round(Math.min(255, c[2] + (c[2] - avg) * factor)),
  ];
}

function addChannel(c: RGB, delta: number): RGB {
  return [
    Math.min(255, c[0] + delta),
    Math.min(255, c[1] + delta),
    Math.min(255, c[2] + delta),
  ];
}

function mulChannel(c: RGB, factor: number): RGB {
  return [
    Math.round(c[0] * factor),
    Math.round(c[1] * factor),
    Math.round(c[2] * factor),
  ];
}

function rgbCss(c: RGB): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
