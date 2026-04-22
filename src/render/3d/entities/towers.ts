/**
 * 3D tower meshes — Phase 3 of the 3D renderer migration.
 *
 * Towers live on the `GameMap` (stable list, one entry per selectable
 * keep) and the overlay attaches per-frame ownership data:
 *
 *   • `overlay.entities.ownedTowers` — Map<towerIdx, playerId> for every
 *     tower a player has claimed (their original home tower + any
 *     secondary towers they've enclosed). Drives per-player tinting of
 *     flag, roof, body, and parapets.
 *   • `overlay.entities.homeTowerIndices` — set of tower indices that are
 *     a player's *original* home tower. Selects `home_tower` geometry
 *     (gate, corner flags, taller main flag); other towers use the
 *     `secondary_tower` geometry even when claimed.
 *   • `overlay.entities.towerAlive` — boolean[] indexed by towerIdx.
 *     Dead towers (false) are skipped here — the 3D `debris` entity
 *     manager (see `./debris.ts`) renders their rubble piles under a
 *     separate layer flag.
 *
 * The 2D renderer draws towers inside `drawTowers` (render-towers.ts),
 * picking one of three per-player baked sprites per tower. This
 * manager builds a shared tower model and recolours named meshes per
 * owner: "flag" uses the vivid `interiorLight` team tint, "body" and
 * "parapet" use the muted `wall` stone tint. Roofs stay on their
 * neutral pale palette (cool slate on home, warm terracotta on
 * secondary) so the team identity reads via the flag and wall tone
 * without a saturated roof. Captured secondary towers keep the
 * sandstone geometry and pick up the tint on body + flag.
 *
 * Update cadence: the set of towers only changes across castle-
 * selection phases (ownership) and battle deaths. A small fingerprint
 * of the (variant, ownerId, tower index) triples skips the rebuild on
 * steady-state frames.
 *
 * Reconciliation is teardown+rebuild (dispose every mesh and material
 * the manager owns, rebuild from scratch). Towers top out at 6 per
 * map; this is well below the threshold where incremental
 * reconciliation starts paying off.
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
