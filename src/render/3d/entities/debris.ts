/**
 * 3D debris meshes (wall + cannon + tower rubble). One manager because all
 * three share `debris-scene.ts`; live-entity managers skip dead entries so
 * this file owns every rubble mesh. Variants pick by hashed (col,row) for
 * walls, mode/flags for cannons, home vs secondary for towers. Extract-
 * and-instance bucket pattern; `home_tower_debris` forks per ownerId so
 * the flag tints to the owning player.
 */

import * as THREE from "three";
import type { CannonMode } from "../../../shared/core/battle-types.ts";
import {
  isCannonAlive,
  isSuperCannon,
} from "../../../shared/core/battle-types.ts";
import type { Tower, TowerIdx } from "../../../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  TILE_SIZE,
  type TileKey,
} from "../../../shared/core/grid.ts";
import type { ValidPlayerId } from "../../../shared/core/player-slot.ts";
import { wallDestroyAnimAt } from "../../../shared/core/wall-destroy-anim.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { getPlayerColor } from "../../../shared/ui/player-config.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { buildDebris, getDebrisVariant } from "../sprites/debris-scene.ts";
import {
  cannonKind,
  cloneAndTintMaterial,
  rgbToHex,
  TILE_2X2_CENTER_OFFSET,
  TILE_3X3_CENTER_OFFSET,
  unpackTileKey,
} from "./entity-helpers.ts";
import {
  type BucketSubPart,
  buildVariantBucket,
  disposeAllBuckets,
  ensureBucketCapacity,
  fillBucket,
  hideSubParts,
  writeBucketAttribute,
} from "./instance-bucket.ts";
import { attachInstanceOpacity } from "./instance-modulation.ts";

export interface DebrisManager {
  /** Reconcile all debris meshes (wall / cannon / tower) with the current
   *  overlay + map. Cheap no-op when no source set has changed since the
   *  last call. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface VariantBucket {
  readonly key: string;
  readonly variantName: string;
  /** One InstancedMesh per sub-part of the authored debris pile. Shape is
   *  constant for the bucket's lifetime; capacity grows by replacement. */
  subParts: BucketSubPart[];
  /** Per-sub-part instance-opacity attribute (parallel to `subParts`). */
  opacityAttrs: THREE.InstancedBufferAttribute[];
  capacity: number;
}

interface DebrisEntry {
  readonly key: string;
  readonly variantName: string;
  readonly centerPxX: number;
  readonly centerPxZ: number;
  readonly scale: number;
  readonly ownerId: ValidPlayerId | undefined;
  /** Per-instance alpha multiplier in [0, 1]. 1 for live entries;
   *  held entries carry the runtime-derived fade multiplier. */
  readonly opacity: number;
}

/** 2×2 debris (tower / cannon). The scene authors each pile inside a ±1
 *  frustum (2 world units wide) covering a 2-tile span, so scaling by
 *  TILE_SIZE makes 1 authored world unit = 1 game tile. */
const DEBRIS_SCALE_2X2 = TILE_SIZE;
/** 1×1 debris (walls). The scene authors inside the same ±1 frustum but
 *  the pile represents a single tile, so we scale by TILE_SIZE / 2. */
const DEBRIS_SCALE_1X1 = TILE_SIZE / 2;
/** Initial InstancedMesh capacity per bucket. Peak mid-battle totals:
 *  ≤6 tower debris, ≤20-30 cannon debris across all modes (each in its
 *  own bucket), ≤120 wall tiles split across 2 wall buckets. 16 covers
 *  the common case with headroom; grows power-of-two as needed. */
const INITIAL_CAPACITY = 16;

export function createDebrisManager(scene: THREE.Scene): DebrisManager {
  const root = new THREE.Group();
  root.name = "debris";
  scene.add(root);

  // One bucket per key. Allocated lazily on first use. For every variant
  // but home_tower_debris, key === variantName. For home_tower_debris,
  // key === `home_tower_debris:<ownerId>` so the flag chunk can render
  // with a per-owner tint in the shared material.
  const buckets = new Map<string, VariantBucket>();
  const ownedMaterials: THREE.Material[] = [];
  // Two-tier cache: structural signature gates the expensive bucket
  // rebuild + matrix recompose; fade values are tracked separately so
  // the rubble-clearing ramp only triggers a per-slot opacity rewrite
  // per frame (skipping ensureBucket + fillBucket).
  let lastStructuralSignature: string | undefined;
  let lastRubbleFade = 1;

  // Scratch objects reused inside `update`.
  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const identityQuat = new THREE.Quaternion();
  const scaleVec = new THREE.Vector3();

  function ensureBucket(
    key: string,
    variantName: string,
    ownerId: ValidPlayerId | undefined,
    required: number,
  ): VariantBucket | undefined {
    return ensureBucketCapacity(
      buckets,
      key,
      required,
      INITIAL_CAPACITY,
      (capacity) =>
        buildBucket(key, variantName, ownerId, capacity, root, ownedMaterials),
    );
  }

  function collectEntries(
    overlay: RenderOverlay,
    towers: readonly Tower[] | undefined,
  ): DebrisEntry[] {
    const entries: DebrisEntry[] = [];
    const debrisOpacityByTileKey = buildDebrisOpacityMap(overlay);
    collectWallDebris(entries, overlay, debrisOpacityByTileKey);
    collectDeadCannonDebris(entries, overlay);
    collectDeadTowerDebris(entries, overlay, towers);
    collectHeldDeadCannonDebris(entries, overlay);
    return entries;
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    const towers = ctx.map?.towers;
    const rubbleFade = overlay?.battle?.rubbleClearingFade ?? 1;
    // destroyedWalls entries advance their per-tile age every frame, so
    // when any are present we force a refresh so the per-tile cross-
    // fade-in writes opacity each frame.
    const hasDestroyedWalls =
      (overlay?.battle?.destroyedWalls?.length ?? 0) > 0;
    const structuralSignature = computeStructuralSignature(overlay, towers);
    const structuralChanged = structuralSignature !== lastStructuralSignature;
    const fadeChanged = rubbleFade !== lastRubbleFade;
    if (!structuralChanged && !fadeChanged && !hasDestroyedWalls) return;
    lastRubbleFade = rubbleFade;

    if (!overlay || structuralSignature === "") {
      lastStructuralSignature = structuralSignature;
      for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
      return;
    }

    const entries = collectEntries(overlay, towers);
    const byKey = new Map<string, DebrisEntry[]>();
    for (const entry of entries) {
      let list = byKey.get(entry.key);
      if (!list) {
        list = [];
        byKey.set(entry.key, list);
      }
      list.push(entry);
    }

    if (structuralChanged) {
      lastStructuralSignature = structuralSignature;

      for (const [key, bucket] of buckets) {
        if (!byKey.has(key)) hideSubParts(bucket.subParts);
      }

      for (const [key, list] of byKey) {
        const first = list[0]!;
        const bucket = ensureBucket(
          key,
          first.variantName,
          first.ownerId,
          list.length,
        );
        if (!bucket) continue;
        fillBucket(
          bucket,
          list,
          hostMatrix,
          instanceMatrix,
          (entry, matrix) => {
            hostTranslation.set(entry.centerPxX, 0, entry.centerPxZ);
            scaleVec.setScalar(entry.scale);
            matrix.compose(hostTranslation, identityQuat, scaleVec);
          },
        );
      }
    }

    // Always write opacities — fade-only frames need this; structural
    // rebuild also resets `attachInstanceOpacity`'s default-1 fill.
    writeBucketAttribute(
      buckets,
      byKey,
      (bucket) => bucket.opacityAttrs,
      (entry) => entry.opacity,
    );
  }

  function dispose(): void {
    disposeAllBuckets(buckets, ownedMaterials);
    scene.remove(root);
  }

  return { update, dispose };
}

/** Pick between the A/B wall-debris variant names from a stable hash of
 *  the tile position, so adjacent ruined walls don't render identically. */
/** Per-tile debris-opacity overrides from active destroyedWalls entries
 *  (cross-fade-in matching the held mesh's sink). The wall-debris loop
 *  picks up the override; tiles not in destroyedWalls render at full
 *  opacity (default rubble). */
function buildDebrisOpacityMap(overlay: RenderOverlay): Map<number, number> {
  const out = new Map<number, number>();
  const destroyedWalls = overlay.battle?.destroyedWalls;
  if (!destroyedWalls) return out;
  for (const wall of destroyedWalls) {
    const opacity = wallDestroyAnimAt(wall.age * 1000).debrisOpacity;
    out.set(wall.row * GRID_COLS + wall.col, opacity);
  }
  return out;
}

/** Wall debris: tiles in battleWalls that aren't in the current walls set. */
function collectWallDebris(
  entries: DebrisEntry[],
  overlay: RenderOverlay,
  debrisOpacityByTileKey: ReadonlyMap<number, number>,
): void {
  const battleWalls = overlay.battle?.battleWalls;
  if (!battleWalls || !overlay.castles) return;
  for (const castle of overlay.castles) {
    const origWalls = battleWalls[castle.playerId];
    if (!origWalls) continue;
    for (const key of origWalls) {
      if (castle.walls.has(key)) continue;
      const { row, col } = unpackTileKey(key);
      const variantName = wallDebrisVariantName(col, row);
      entries.push({
        key: variantName,
        variantName,
        centerPxX: (col + 0.5) * TILE_SIZE,
        centerPxZ: (row + 0.5) * TILE_SIZE,
        scale: DEBRIS_SCALE_1X1,
        ownerId: undefined,
        opacity: debrisOpacityByTileKey.get(key) ?? 1,
      });
    }
  }
}

function collectDeadCannonDebris(
  entries: DebrisEntry[],
  overlay: RenderOverlay,
): void {
  if (!overlay.castles) return;
  for (const castle of overlay.castles) {
    for (const cannon of castle.cannons) {
      if (isCannonAlive(cannon)) continue;
      const variantName = cannonDebrisVariantName(cannon, castle.cannonTier);
      const offset = isSuperCannon(cannon)
        ? TILE_3X3_CENTER_OFFSET
        : TILE_2X2_CENTER_OFFSET;
      entries.push({
        key: variantName,
        variantName,
        centerPxX: cannon.col * TILE_SIZE + offset,
        centerPxZ: cannon.row * TILE_SIZE + offset,
        scale: DEBRIS_SCALE_2X2,
        ownerId: undefined,
        opacity: 1,
      });
    }
  }
}

/** Dead towers. Home towers fork by ownerId so the flag chunk carries
 *  the right color. */
function collectDeadTowerDebris(
  entries: DebrisEntry[],
  overlay: RenderOverlay,
  towers: readonly Tower[] | undefined,
): void {
  const aliveMask = overlay.entities?.towerAlive;
  if (!aliveMask || !towers) return;
  const ownedTowers = overlay.entities?.ownedTowers;
  for (let idx = 0; idx < towers.length; idx++) {
    const i = idx as TowerIdx;
    if (aliveMask[i] !== false) continue;
    const tower = towers[i]!;
    const ownerId = ownedTowers?.get(i);
    const variantName =
      ownerId !== undefined ? "home_tower_debris" : "secondary_tower_debris";
    const bucketKey =
      ownerId !== undefined ? `${variantName}:${ownerId}` : variantName;
    entries.push({
      key: bucketKey,
      variantName,
      centerPxX: tower.col * TILE_SIZE + TILE_2X2_CENTER_OFFSET,
      centerPxZ: tower.row * TILE_SIZE + TILE_2X2_CENTER_OFFSET,
      scale: DEBRIS_SCALE_2X2,
      ownerId,
      opacity: 1,
    });
  }
}

/** Held dead-cannon footprints from the rubble_clearing fade. Live entries
 *  already left `player.cannons`, but the snapshot persists until the
 *  multiplier ramps to 0; rendered with per-instance opacity = fade. */
function collectHeldDeadCannonDebris(
  entries: DebrisEntry[],
  overlay: RenderOverlay,
): void {
  const heldDeadCannons = overlay.battle?.heldDeadCannons;
  if (!heldDeadCannons) return;
  const rubbleClearingFade = overlay.battle?.rubbleClearingFade ?? 1;
  for (const held of heldDeadCannons) {
    const variantName = cannonDebrisVariantName(
      { mode: held.mode, mortar: held.mortar },
      held.tier,
    );
    const offset = isSuperCannon({ mode: held.mode })
      ? TILE_3X3_CENTER_OFFSET
      : TILE_2X2_CENTER_OFFSET;
    entries.push({
      key: variantName,
      variantName,
      centerPxX: held.col * TILE_SIZE + offset,
      centerPxZ: held.row * TILE_SIZE + offset,
      scale: DEBRIS_SCALE_2X2,
      ownerId: undefined,
      opacity: rubbleClearingFade,
    });
  }
}

function wallDebrisVariantName(col: number, row: number): string {
  // Small integer hash — any bit spreader works; this one is commutative-
  // avoiding so swapping col/row picks a different bucket.
  const hashed = ((col * 73856093) ^ (row * 19349663)) >>> 0;
  return (hashed & 1) === 0 ? "wall_debris_a" : "wall_debris_b";
}

/** Set membership across all debris sources, EXCLUDING per-frame fade
 *  values. Drives the bucket-rebuild gate; fade values flow through
 *  `entry.opacity` and are written separately on every frame regardless. */
function computeStructuralSignature(
  overlay: RenderOverlay | undefined,
  towers: readonly Tower[] | undefined,
): string {
  if (!overlay) return "";
  const parts: string[] = [];

  const aliveMask = overlay.entities?.towerAlive;
  const ownedTowers = overlay.entities?.ownedTowers;
  if (aliveMask && towers) {
    for (let idx = 0; idx < towers.length; idx++) {
      const i = idx as TowerIdx;
      if (aliveMask[i] !== false) continue;
      const ownerId = ownedTowers?.get(i);
      parts.push(`t:${i}:${ownerId ?? "-"}`);
    }
  }

  if (overlay.castles) {
    for (const castle of overlay.castles) {
      for (const cannon of castle.cannons) {
        if (isCannonAlive(cannon)) continue;
        parts.push(
          `c:${castle.playerId}:${cannon.col}:${cannon.row}:${cannonDebrisVariantName(cannon, castle.cannonTier)}`,
        );
      }
    }
  }

  const battleWalls = overlay.battle?.battleWalls;
  if (battleWalls && overlay.castles) {
    for (const castle of overlay.castles) {
      const origWalls = battleWalls[castle.playerId];
      if (!origWalls) continue;
      const destroyed: TileKey[] = [];
      for (const key of origWalls) {
        if (!castle.walls.has(key)) destroyed.push(key);
      }
      if (destroyed.length === 0) continue;
      destroyed.sort((low, high) => low - high);
      parts.push(`w:${castle.playerId}:${destroyed.join(",")}`);
    }
  }

  const held = overlay.battle?.heldDeadCannons;
  if (held && held.length > 0) {
    for (const cannon of held) {
      parts.push(
        `h:${cannon.col}:${cannon.row}:${cannonDebrisVariantName(cannon, cannon.tier)}`,
      );
    }
  }

  return parts.join("|");
}

/** Pick the debris variant that best matches a dead cannon. Mirrors
 *  the 2D path's switch (rampart / super / mortar / default). Regular
 *  cannons pick the tier debris matching their owner's current tier so
 *  the rubble reads as the cannon that was there. Rampart cannons use
 *  a dedicated variant with a metallic-core palette + green emblem so
 *  the rubble reads as a wrecked forge rather than a wrecked barrel. */
function cannonDebrisVariantName(
  cannon: {
    mode: CannonMode;
    mortar?: true;
  },
  tier: 1 | 2 | 3,
): string {
  const kind = cannonKind(cannon);
  switch (kind) {
    case "rampart":
      return "rampart_debris";
    case "super":
      return "super_gun_debris";
    case "mortar":
      return "mortar_debris";
    // Balloons aren't filtered upstream here, so their wrecked state
    // falls through to the generic barrel-debris pile. Matches the
    // pre-refactor behaviour where neither isRampart/isSuper nor the
    // mortar flag matched a balloon cannon.
    case "balloon":
    case "tier_1":
      return tier === 1
        ? "tier_1_debris"
        : tier === 2
          ? "tier_2_debris"
          : "tier_3_debris";
  }
}

/** Build a bucket for one key: run `buildDebris` once into a scratch
 *  group, extract every sub-mesh, optionally swap the flag sub-part's
 *  material for a per-owner tinted clone, and wrap each as an
 *  `InstancedMesh` under `root`. Returns `undefined` if the variant is
 *  unknown to its registry. */
function buildBucket(
  key: string,
  variantName: string,
  ownerId: ValidPlayerId | undefined,
  capacity: number,
  root: THREE.Group,
  ownedMaterials: THREE.Material[],
): VariantBucket | undefined {
  const variant = getDebrisVariant(variantName);
  if (!variant) return undefined;
  const flagTint =
    ownerId !== undefined && variantName === "home_tower_debris"
      ? rgbToHex(getPlayerColor(ownerId).interiorLight)
      : undefined;
  const subParts = buildVariantBucket({
    capacity,
    root,
    ownedMaterials,
    scratchBuilder: (scratch) => {
      buildDebris(THREE, scratch, variant);
    },
    namePrefix: `debris-${key}`,
    // Per-owner flag tint: clone the material for the "flag" sub-part so
    // multiple owner buckets don't share state. Only home_tower_debris
    // names a mesh "flag" (see debris-scene.ts), so this is a no-op for
    // every other variant.
    transformPart:
      flagTint !== undefined
        ? (part) =>
            part.name === "flag"
              ? {
                  ...part,
                  material: cloneAndTintMaterial(part.material, flagTint),
                }
              : part
        : undefined,
  });
  // Attach per-instance opacity so the rubble_clearing fade can write
  // a 0..1 multiplier per slot. Live entries get 1 (no override); held
  // entries get the runtime-derived fade multiplier each frame.
  const opacityAttrs = subParts.map((part) =>
    attachInstanceOpacity(part.instanced, capacity),
  );
  return { key, variantName, subParts, opacityAttrs, capacity };
}
