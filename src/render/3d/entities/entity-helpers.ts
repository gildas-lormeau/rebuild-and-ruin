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
import type { ValidPlayerSlot } from "../../../shared/core/player-slot.ts";
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
    parts.push({
      geometry: obj.geometry,
      material: obj.material,
      localMatrix: obj.matrixWorld.clone(),
      name: obj.name || "",
    });
  });
  return parts;
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
 *  for a tinted clone in the player's color. Tracks clones in
 *  `ownedMaterials` so the manager's dispose path can free them. */
export function tintNamedMeshes(
  host: THREE.Group,
  meshName: string,
  ownerId: ValidPlayerSlot,
  ownedMaterials: THREE.Material[],
): void {
  const color = rgbToHex(getPlayerColor(ownerId).interiorLight);
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
