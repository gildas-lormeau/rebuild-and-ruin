/**
 * 3D debris meshes — Phase 3 of the 3D renderer migration, with Phase 8d
 * instancing on top.
 *
 * One entity manager covers all three debris kinds because they share a
 * single sprite scene (`debris-scene.ts`) and the same mesh lifecycle:
 *
 *   • **Wall debris** — tiles in a castle's original wall set that are
 *     no longer present in the live wall set (the 2D renderer calls
 *     these out via `drawWallDebris`). 1×1 tile footprint; two seed
 *     variants (`wall_debris_a`/`wall_debris_b`) picked by a stable
 *     hash of (col, row) so adjacent ruins don't mirror.
 *   • **Cannon debris** — `castle.cannons[]` entries where
 *     `isCannonAlive(cannon) === false`. 2×2 tile footprint; variant
 *     picked from mode/flags (super → super_gun_debris, mortar →
 *     mortar_debris, otherwise tier_1_debris).
 *   • **Tower debris** — towers with `overlay.entities.towerAlive[i] === false`.
 *     2×2 tile footprint; variant = `home_tower_debris` if the tower
 *     was a home tower, else `secondary_tower_debris`.
 *
 * The live-entity managers (`walls.ts`, `towers.ts`) intentionally
 * ignore the dead/ruined entries — they're drawn here so a single
 * disposal path owns every rubble mesh.
 *
 * Instancing approach — "extract-and-instance" (same pattern as
 * cannons.ts, walls.ts, grunts.ts):
 *
 *   1. Lazily per bucket key: run `buildDebris` once with the full
 *      variant descriptor into a throwaway Group. Each pile contains a
 *      procedural pool of 20-60 rocks + a few hand-placed chunks
 *      (~25-65 meshes) plus an optional ground shadow+AO pair for
 *      cannon-source variants. Extract every Mesh as
 *      `{geometry, material, localMatrix, name}` via `extractSubParts`.
 *   2. For each sub-part, create one `InstancedMesh` attached to the
 *      manager's root group. Initial capacity 16, grown power-of-two
 *      via `ensureBucket`.
 *   3. Per fingerprint change: bucket debris entries by key, compute
 *      each entry's host matrix (translate to centre × uniform scale),
 *      and write `hostMatrix * subPart.localMatrix` via `setMatrixAt`.
 *      Clamp `.count` to the live bucket size so unused slots don't
 *      render.
 *
 * Procedural pile tradeoff: each variant bakes in an RNG seed, so one
 * extraction produces one canonical pile shape. Instancing means every
 * rubble tile sharing a bucket renders an IDENTICAL layout of rocks.
 * That's already the case in the pre-instancing path — the layout is
 * deterministic in the seed — and wall debris specifically has two
 * seed variants (`wall_debris_a`/`_b`) to break up the uniformity
 * across tiles.
 *
 * Player-color tinting (home tower flag): only the `home_tower_debris`
 * variant carries a chunk named "flag" (tagged inside debris-scene.ts
 * when its material === FLAG_RED). We fork that one variant into per-
 * ownerId buckets (`home_tower_debris:<ownerId>`): when building such a
 * bucket we clone+tint the flag sub-part's material to the owner's
 * interior-light color. At most 4 home-tower-debris buckets (one per
 * `ValidPlayerSlot`) coexist. All other variants remain single-bucket.
 *
 * Update cadence: the three input sets change rarely — walls and
 * cannons transition between states only on battle wall/cannon kills
 * and zone resets; towers transition only on tower kills. A composite
 * signature (dead-tower indices + dead-cannon positions + destroyed-
 * wall keys + debris variants + flag owners) lets every steady-state
 * frame early-out.
 */

import * as THREE from "three";
import type { CannonMode } from "../../../shared/core/battle-types.ts";
import type { Tower } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../../../shared/core/player-slot.ts";
import { isCannonAlive, isSuperCannon } from "../../../shared/core/spatial.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { getPlayerColor } from "../../../shared/ui/player-config.ts";
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
} from "./instance-bucket.ts";

export interface DebrisManager {
  /** Reconcile all debris meshes (wall / cannon / tower) with the current
   *  overlay + map. Cheap no-op when no source set has changed since the
   *  last call. */
  update(
    overlay: RenderOverlay | undefined,
    towers: readonly Tower[] | undefined,
  ): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface VariantBucket {
  readonly key: string;
  readonly variantName: string;
  /** One InstancedMesh per sub-part of the authored debris pile. Shape is
   *  constant for the bucket's lifetime; capacity grows by replacement. */
  subParts: BucketSubPart[];
  capacity: number;
}

interface DebrisEntry {
  readonly key: string;
  readonly variantName: string;
  readonly centerPxX: number;
  readonly centerPxZ: number;
  readonly scale: number;
  readonly ownerId: ValidPlayerSlot | undefined;
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
  let lastSignature: string | undefined;

  // Scratch objects reused inside `update`.
  const hostMatrix = new THREE.Matrix4();
  const instanceMatrix = new THREE.Matrix4();
  const hostTranslation = new THREE.Vector3();
  const identityQuat = new THREE.Quaternion();
  const scaleVec = new THREE.Vector3();

  function ensureBucket(
    key: string,
    variantName: string,
    ownerId: ValidPlayerSlot | undefined,
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

    // Wall debris: (playerId) × (tile in battleWalls but not in current walls).
    const battleWalls = overlay.battle?.battleWalls;
    if (battleWalls && overlay.castles) {
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
          });
        }
      }
    }

    // Cannon debris: dead cannons across every castle.
    if (overlay.castles) {
      for (const castle of overlay.castles) {
        for (const cannon of castle.cannons) {
          if (isCannonAlive(cannon)) continue;
          const variantName = cannonDebrisVariantName(cannon);
          const isSuper = isSuperCannon(cannon);
          const offset = isSuper
            ? TILE_3X3_CENTER_OFFSET
            : TILE_2X2_CENTER_OFFSET;
          entries.push({
            key: variantName,
            variantName,
            centerPxX: cannon.col * TILE_SIZE + offset,
            centerPxZ: cannon.row * TILE_SIZE + offset,
            scale: DEBRIS_SCALE_2X2,
            ownerId: undefined,
          });
        }
      }
    }

    // Tower debris: dead towers. Home towers fork by ownerId so the
    // flag chunk carries the right color.
    const aliveMask = overlay.entities?.towerAlive;
    const homeTowers = overlay.entities?.homeTowers;
    if (aliveMask && towers) {
      for (let i = 0; i < towers.length; i++) {
        if (aliveMask[i] !== false) continue;
        const tower = towers[i]!;
        const ownerId = homeTowers?.get(i) as ValidPlayerSlot | undefined;
        const variantName =
          ownerId !== undefined
            ? "home_tower_debris"
            : "secondary_tower_debris";
        const bucketKey =
          ownerId !== undefined ? `${variantName}:${ownerId}` : variantName;
        entries.push({
          key: bucketKey,
          variantName,
          centerPxX: tower.col * TILE_SIZE + TILE_2X2_CENTER_OFFSET,
          centerPxZ: tower.row * TILE_SIZE + TILE_2X2_CENTER_OFFSET,
          scale: DEBRIS_SCALE_2X2,
          ownerId,
        });
      }
    }

    return entries;
  }

  function update(
    overlay: RenderOverlay | undefined,
    towers: readonly Tower[] | undefined,
  ): void {
    const signature = computeSignature(overlay, towers);
    if (signature === lastSignature) return;
    lastSignature = signature;

    if (!overlay || signature === "") {
      // Hide all instances; keep buckets alive so common "debris comes
      // and goes" churn doesn't thrash GPU buffers.
      for (const bucket of buckets.values()) hideSubParts(bucket.subParts);
      return;
    }

    const entries = collectEntries(overlay, towers);

    // Pre-bucket entries by key so we know capacity requirements up front.
    const byKey = new Map<string, DebrisEntry[]>();
    for (const entry of entries) {
      let list = byKey.get(entry.key);
      if (!list) {
        list = [];
        byKey.set(entry.key, list);
      }
      list.push(entry);
    }

    // Keys that have a bucket but no live entries this frame — zero
    // their count so stale instances don't ghost-render.
    for (const [key, bucket] of buckets) {
      if (!byKey.has(key)) hideSubParts(bucket.subParts);
    }

    // Write matrices for each live bucket key.
    for (const [key, list] of byKey) {
      const first = list[0]!;
      const bucket = ensureBucket(
        key,
        first.variantName,
        first.ownerId,
        list.length,
      );
      if (!bucket) continue;
      fillBucket(bucket, list, hostMatrix, instanceMatrix, (entry, matrix) => {
        hostTranslation.set(entry.centerPxX, 0, entry.centerPxZ);
        scaleVec.setScalar(entry.scale);
        matrix.compose(hostTranslation, identityQuat, scaleVec);
      });
    }
  }

  function dispose(): void {
    disposeAllBuckets(buckets, ownedMaterials);
    scene.remove(root);
  }

  return { update, dispose };
}

/** Pick between the A/B wall-debris variant names from a stable hash of
 *  the tile position, so adjacent ruined walls don't render identically. */
function wallDebrisVariantName(col: number, row: number): string {
  // Small integer hash — any bit spreader works; this one is commutative-
  // avoiding so swapping col/row picks a different bucket.
  const hashed = ((col * 73856093) ^ (row * 19349663)) >>> 0;
  return (hashed & 1) === 0 ? "wall_debris_a" : "wall_debris_b";
}

/** Compute a composite signature across all three debris sources. Any
 *  change to any source invalidates the cache — cheap vs rebuilding
 *  potentially hundreds of rubble meshes every frame. */
function computeSignature(
  overlay: RenderOverlay | undefined,
  towers: readonly Tower[] | undefined,
): string {
  if (!overlay) return "";
  const parts: string[] = [];

  // Tower debris: indices of dead towers, plus their current owner
  // (home vs secondary changes the variant, and the owner forks the
  // home_tower_debris bucket for flag tinting).
  const aliveMask = overlay.entities?.towerAlive;
  const homeTowers = overlay.entities?.homeTowers;
  if (aliveMask && towers) {
    for (let i = 0; i < towers.length; i++) {
      if (aliveMask[i] !== false) continue;
      const ownerId = homeTowers?.get(i);
      parts.push(`t:${i}:${ownerId ?? "-"}`);
    }
  }

  // Cannon debris: (playerId, col, row, variant) per dead cannon.
  if (overlay.castles) {
    for (const castle of overlay.castles) {
      for (const cannon of castle.cannons) {
        if (isCannonAlive(cannon)) continue;
        parts.push(
          `c:${castle.playerId}:${cannon.col}:${cannon.row}:${cannonDebrisVariantName(cannon)}`,
        );
      }
    }
  }

  // Wall debris: every (playerId, key) that was in the original set
  // but not in the current set. Sorted per-player for stability.
  const battleWalls = overlay.battle?.battleWalls;
  if (battleWalls && overlay.castles) {
    for (const castle of overlay.castles) {
      const origWalls = battleWalls[castle.playerId];
      if (!origWalls) continue;
      const destroyed: number[] = [];
      for (const key of origWalls) {
        if (!castle.walls.has(key)) destroyed.push(key);
      }
      if (destroyed.length === 0) continue;
      destroyed.sort((low, high) => low - high);
      parts.push(`w:${castle.playerId}:${destroyed.join(",")}`);
    }
  }

  return parts.join("|");
}

/** Pick the debris variant that best matches a dead cannon. Mirrors
 *  the 2D path's switch (rampart / super / mortar / default). The live
 *  game state doesn't carry a cannon "tier", so every regular cannon
 *  lands on `tier_1_debris`. Rampart cannons use a dedicated variant
 *  with a metallic-core palette + green emblem so the rubble reads as
 *  a wrecked forge rather than a wrecked barrel. */
function cannonDebrisVariantName(cannon: {
  mode: CannonMode;
  mortar?: boolean;
}): string {
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
      return "tier_1_debris";
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
  ownerId: ValidPlayerSlot | undefined,
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
  return { key, variantName, subParts, capacity };
}
