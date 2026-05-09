/**
 * 3D tower meshes. Variant: `home_tower` vs `secondary_tower` from
 * `overlay.entities.homeTowerIndices`; ownership tints flag/body/parapet.
 * Roofs stay neutral so identity reads via flag + wall tone. Dead towers
 * skip — `./debris.ts` owns rubble. Teardown+rebuild on a
 * `(variant, ownerId, idx)` fingerprint; ≤6 towers per map.
 */

import * as THREE from "three";
import type { Tower } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../../../shared/core/player-slot.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { buildTower, getTowerVariant } from "../sprites/tower-scene.ts";
import { disposeGroupSubtree, tintNamedMeshes } from "./entity-helpers.ts";

export interface TowersManager {
  /** Reconcile tower meshes with the current overlay. Cheap no-op when
   *  the overlay's tower set hasn't changed since the last update. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

/** Tower-scene authors each turret in a ±1 frustum (2 world units wide)
 *  covering a 2-tile span. We want 2 cells = 2 game tiles, so we scale
 *  by TILE_SIZE — each authored 1 world unit becomes TILE_SIZE pixels. */
const TOWER_SCALE = TILE_SIZE;
/** Tower footprint in tiles. Towers are 2×2 — anchor is the top-left
 *  tile, center sits one full tile inward on both axes. */
const TOWER_CENTER_OFFSET = TILE_SIZE;

export function createTowersManager(scene: THREE.Scene): TowersManager {
  const root = new THREE.Group();
  root.name = "towers";
  scene.add(root);

  // Materials we created (not shared with tower-scene's shared texture
  // objects — only the player-tint flag materials we clone). Tracked so
  // dispose() can free them.
  const ownedMaterials: THREE.Material[] = [];
  let lastSignature: string | undefined;

  function buildAllTowers(
    towers: readonly Tower[],
    ownedTowers: ReadonlyMap<number, number> | undefined,
    homeTowerIndices: ReadonlySet<number> | undefined,
    aliveMask: readonly boolean[] | undefined,
  ): void {
    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i]!;
      // Skip dead towers — the 3D debris manager (entities/debris.ts)
      // renders their rubble under the separate `debris` layer flag.
      // `towerAlive === undefined` (no battle state yet) means "all alive".
      if (aliveMask && aliveMask[i] === false) continue;

      const ownerId = ownedTowers?.get(i);
      const isHome = homeTowerIndices?.has(i) ?? false;
      const variantName = isHome ? "home_tower" : "secondary_tower";
      const variant = getTowerVariant(variantName);
      if (!variant) continue;

      const host = new THREE.Group();
      buildTower(THREE, host, variant.params);

      // Position at tower centre: (col + 1, row + 1) * TILE_SIZE.
      host.position.set(
        tower.col * TILE_SIZE + TOWER_CENTER_OFFSET,
        0,
        tower.row * TILE_SIZE + TOWER_CENTER_OFFSET,
      );
      host.scale.setScalar(TOWER_SCALE);

      // Per-player tinting for home towers. Flags and roofs use the
      // vivid `interiorLight` tint for instant team readability at the
      // gameplay camera; stone body + parapets use the muted `wall`
      // tint so the whole silhouette feels player-coloured without
      // washing out the stonework.
      if (ownerId !== undefined) {
        tintNamedMeshes(
          host,
          "flag",
          ownerId as ValidPlayerSlot,
          ownedMaterials,
        );
        tintNamedMeshes(
          host,
          "body",
          ownerId as ValidPlayerSlot,
          ownedMaterials,
          "wall",
        );
        tintNamedMeshes(
          host,
          "parapet",
          ownerId as ValidPlayerSlot,
          ownedMaterials,
          "wall",
        );
        tintNamedMeshes(
          host,
          "pole_base",
          ownerId as ValidPlayerSlot,
          ownedMaterials,
          "wall",
        );
      }

      root.add(host);
    }
  }

  function clear(): void {
    // Dispose per-mesh geometry + owned tint materials. Shared
    // texture/material objects owned by tower-scene are not touched —
    // they're cached and re-used across rebuilds.
    disposeGroupSubtree(root, ownedMaterials);
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    const towers = ctx.map?.towers;
    if (!towers || towers.length === 0) {
      if (lastSignature !== "") {
        clear();
        lastSignature = "";
      }
      return;
    }
    const ownedTowers = overlay?.entities?.ownedTowers;
    const homeTowerIndices = overlay?.entities?.homeTowerIndices;
    const aliveMask = overlay?.entities?.towerAlive;

    // Signature: tower index + variant + ownerId + alive bit. Rebuilds
    // only when one of those changes.
    const parts: string[] = [];
    for (let i = 0; i < towers.length; i++) {
      const alive = aliveMask ? aliveMask[i] !== false : true;
      const ownerId = ownedTowers?.get(i);
      const home = homeTowerIndices?.has(i) ? 1 : 0;
      parts.push(`${i}:${ownerId ?? "-"}:${home}:${alive ? 1 : 0}`);
    }
    const signature = parts.join(",");
    if (signature === lastSignature) return;
    lastSignature = signature;

    clear();
    buildAllTowers(towers, ownedTowers, homeTowerIndices, aliveMask);
  }

  function dispose(): void {
    clear();
    scene.remove(root);
  }

  return { update, dispose };
}
