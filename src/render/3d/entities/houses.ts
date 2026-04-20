/**
 * 3D house meshes — Phase 3 of the 3D renderer migration.
 *
 * Houses live on `GameMap.houses[]` (stable list for the duration of a
 * match — houses can be destroyed in battle but are never added). Each
 * house is a single 1×1 tile civilian dwelling with no directional
 * orientation, no player color, and no variants: the manager simply
 * reconciles one mesh per living house at its tile center.
 *
 * The 2D renderer draws houses inside `drawHouses` (render-effects.ts),
 * reading `overlay.entities.houses`. This manager mirrors that placement
 * and also honours the `alive` flag — destroyed houses are skipped here
 * exactly as the 2D path skips them.
 *
 * Update cadence: the set of living houses changes only when a house is
 * destroyed (wildfire, etc.). A small signature over `(col, row, alive)`
 * skips the rebuild on steady-state frames.
 *
 * Reconciliation is teardown+rebuild (dispose every mesh, rebuild from
 * scratch). Houses top out at a handful per map — well below the
 * threshold where incremental reconciliation starts paying off.
 */

import * as THREE from "three";
import type { House } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { buildHouse, getHouseVariant } from "../sprites/house-scene.ts";

export interface HousesManager {
  /** Reconcile house meshes with the current map. Cheap no-op when the
   *  living-house set hasn't changed since the last update. */
  update(houses: readonly House[] | undefined): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

/** House-scene authors each dwelling in a ±1 frustum (2 world units wide).
 *  We want 1 cell = 1 game tile, so we scale by TILE_SIZE / 2. */
const HOUSE_SCALE = TILE_SIZE / 2;

export function createHousesManager(scene: THREE.Scene): HousesManager {
  // Root group: everything this manager owns lives under here so teardown
  // is a single `scene.remove(root)` + per-mesh resource disposal.
  const root = new THREE.Group();
  root.name = "houses";
  scene.add(root);

  let lastSignature: string | undefined;

  function buildFromHouses(houses: readonly House[]): void {
    const variant = getHouseVariant("house");
    if (!variant) return;

    for (const house of houses) {
      if (!house.alive) continue;

      const host = new THREE.Group();
      buildHouse(THREE, host, variant.params);

      // Position at tile centre (col + 0.5, row + 0.5) * TILE_SIZE.
      host.position.set(
        (house.col + 0.5) * TILE_SIZE,
        0,
        (house.row + 0.5) * TILE_SIZE,
      );
      host.scale.setScalar(HOUSE_SCALE);
      root.add(host);
    }
  }

  function clear(): void {
    // Dispose per-mesh geometry (materials are shared scene-local
    // constants — leave them to GC). Walk the whole subtree since
    // buildHouse creates body + roof + door + windows under the host
    // group.
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
    while (root.children.length > 0) {
      const child = root.children[0]!;
      root.remove(child);
    }
  }

  function update(houses: readonly House[] | undefined): void {
    // Signature: `col:row:alive` per house, sorted for stability against
    // input-order drift. Rebuilds only when one of those changes.
    if (!houses || houses.length === 0) {
      if (lastSignature !== "") {
        clear();
        lastSignature = "";
      }
      return;
    }
    const parts: string[] = [];
    for (const house of houses) {
      parts.push(`${house.col}:${house.row}:${house.alive ? 1 : 0}`);
    }
    parts.sort();
    const signature = parts.join(",");
    if (signature === lastSignature) return;
    lastSignature = signature;

    clear();
    buildFromHouses(houses);
  }

  function dispose(): void {
    clear();
    scene.remove(root);
  }

  return { update, dispose };
}
