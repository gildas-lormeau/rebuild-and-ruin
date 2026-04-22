/**
 * Shared lifecycle + tinting helpers for Phase 3 entity managers.
 *
 * Every per-entity manager (walls / towers / houses / debris) owns a
 * root `THREE.Group` under which reconciliation adds fresh host groups
 * per live entity. Several of them also clone a shared material to
 * re-color a signature mesh per owning player. These helpers factor
 * those patterns out so each manager stays focused on the state-to-
 * mesh mapping and not on disposal / material cloning boilerplate.
 *
 * Kept intentionally small — any manager-specific wrinkle (wall
 * `root.traverse` walks are identical, but e.g. debris also traverses
 * to find the "flag" chunk) stays in the manager itself.
 */

import * as THREE from "three";
import type { CannonMode } from "../../../shared/core/battle-types.ts";
import { GRID_COLS, TILE_SIZE } from "../../../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../../../shared/core/player-slot.ts";
import {
  isBalloonCannon,
  isRampartCannon,
  isSuperCannon,
} from "../../../shared/core/spatial.ts";
import { getPlayerColor } from "../../../shared/ui/player-config.ts";
import type { RGB } from "../../../shared/ui/theme.ts";

/** A mesh sub-part extracted from a builder's throwaway scene. The
 *  `localMatrix` captures the mesh's resolved world transform inside
 *  that scratch group — i.e. its authored placement relative to the
 *  entity's local origin. Consumers typically wrap each sub-part in an
 *  `InstancedMesh` and compose host×local matrices per frame. */
export interface ExtractedSubPart {
  readonly geometry: THREE.BufferGeometry;
  /** Preserves material arrays (multi-group meshes like ExtrudeGeometry
   *  with separate side/cap materials). `InstancedMesh` supports both
   *  single materials and arrays — pass through as-is. */
  readonly material: THREE.Material | THREE.Material[];
  readonly localMatrix: THREE.Matrix4;
  readonly name: string;
  /** Behavior tags surfaced from authoring-time `userData.tags` (or
   *  `DecorationSpec.tags`). Always defined — empty array when no tags
   *  were authored. Consumers use `subPartHasTag` instead of matching
   *  on `name` strings. */
  readonly tags: readonly string[];
}

type CannonKind = "balloon" | "rampart" | "super" | "mortar" | "tier_1";

/** Half the 2×2-tile footprint expressed in world pixels — used to
 *  centre 2×2 cannon / debris / balloon hosts on their top-left
 *  anchor (col, row). Equivalent to one tile inward on both axes. */
export const TILE_2X2_CENTER_OFFSET = TILE_SIZE;
/** Half the 3×3-tile footprint (super-gun cannon / debris). */
export const TILE_3X3_CENTER_OFFSET = TILE_SIZE * 1.5;

/** Unpack a `row * GRID_COLS + col` tile key into (row, col). Inverse of
 *  the packing both `walls.ts` and `debris.ts` use for battleWalls /
 *  interior sets. */
export function unpackTileKey(key: number): { row: number; col: number } {
  const row = Math.floor(key / GRID_COLS);
  return { row, col: key - row * GRID_COLS };
}

/** Classify a live/dead cannon by its mode + mortar flag. Centralizes
 *  the branching every manager had drifted separately (cannons live,
 *  debris dead, phantoms preview); adding a new CannonMode now fails
 *  the exhaustiveness check here instead of silently missing a
 *  consumer. */
export function cannonKind(cannon: {
  mode: CannonMode;
  mortar?: boolean;
}): CannonKind {
  if (isBalloonCannon(cannon)) return "balloon";
  if (isRampartCannon(cannon)) return "rampart";
  if (isSuperCannon(cannon)) return "super";
  if (cannon.mortar) return "mortar";
  return "tier_1";
}

/** Walk a built `THREE.Group`, call `updateMatrixWorld`, and extract
 *  every `THREE.Mesh` as an `ExtractedSubPart`. Used by entity managers
 *  that want to re-host authored geometry inside an `InstancedMesh`
 *  bucket (grunts, walls). The caller owns the returned geometries and
 *  materials — the scratch group is expected to be discarded. */
export function extractSubParts(scratch: THREE.Group): ExtractedSubPart[] {
  scratch.updateMatrixWorld(true);
  const parts: ExtractedSubPart[] = [];
  scratch.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const rawTags = obj.userData.tags;
    const tags: readonly string[] = Array.isArray(rawTags)
      ? (rawTags as readonly string[])
      : [];
    parts.push({
      geometry: obj.geometry,
      material: obj.material,
      localMatrix: obj.matrixWorld.clone(),
      name: obj.name || "",
      tags,
    });
  });
  return parts;
}

/** True when the extracted sub-part (or its wrapped bucket form) declares
 *  `tag` in its behavior tag list. Prefer this over matching on `name`
 *  strings so authoring can rename a mesh without breaking runtime
 *  branch logic. */
export function subPartHasTag(
  part: { readonly tags: readonly string[] },
  tag: string,
): boolean {
  return part.tags.includes(tag);
}

/** Dispose every mesh geometry under `root`, detach all children, and
 *  dispose every material in `ownedMaterials` (clearing the array).
 *  Used by every entity manager's `clear()` and `dispose()` paths. */
export function disposeGroupSubtree(
  root: THREE.Group,
  ownedMaterials: THREE.Material[],
): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
    }
  });
  while (root.children.length > 0) {
    const child = root.children[0]!;
    root.remove(child);
  }
  for (const mat of ownedMaterials) mat.dispose();
  ownedMaterials.length = 0;
}

/** Walk `host`, find every mesh named `meshName`, and swap its material
 *  for a tinted clone in the player's color. `colorVariant` selects
 *  which of the player's color channels to use — `"interiorLight"`
 *  (default) is the vivid team hue used on flags, `"wall"` is the muted
 *  stone-friendly tone used on structural surfaces. Tracks clones in
 *  `ownedMaterials` so the manager's dispose path can free them. */
export function tintNamedMeshes(
  host: THREE.Group,
  meshName: string,
  ownerId: ValidPlayerSlot,
  ownedMaterials: THREE.Material[],
  colorVariant: "interiorLight" | "wall" = "interiorLight",
): void {
  const color = rgbToHex(getPlayerColor(ownerId)[colorVariant]);
  host.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name === meshName) {
      const tinted = cloneAndTintMaterial(obj.material, color);
      obj.material = tinted;
      ownedMaterials.push(tinted);
    }
  });
}

/** Pack an RGB tuple into a 24-bit THREE hex integer. */
export function rgbToHex(rgb: RGB): number {
  const [red, green, blue] = rgb;
  return ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff);
}

/** Clone a material (picking the first entry if an array is passed) and
 *  overwrite its diffuse color. Returns the clone; does not mutate the
 *  source. */
export function cloneAndTintMaterial(
  source: THREE.Material | THREE.Material[],
  color: number,
): THREE.Material {
  const base = Array.isArray(source) ? source[0]! : source;
  const cloned = base.clone();
  if (
    cloned instanceof THREE.MeshStandardMaterial ||
    cloned instanceof THREE.MeshBasicMaterial
  ) {
    cloned.color.setHex(color);
  }
  return cloned;
}
