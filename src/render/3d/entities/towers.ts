/**
 * 3D tower meshes. Variant: `home_tower` vs `secondary_tower` from
 * `overlay.entities.homeTowerIndices`; ownership tints flag/body/parapet.
 * Roofs stay neutral so identity reads via flag + wall tone. Dead towers
 * skip — `./debris.ts` owns rubble. Per-tower incremental update: each
 * tower owns its own host Group + signature; only changed towers rebuild.
 */

import * as THREE from "three";
import type { Tower, TowerIdx } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { ValidPlayerId } from "../../../shared/core/player-slot.ts";
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

interface TowerEntry {
  host: THREE.Group;
  ownedMaterials: THREE.Material[];
  signature: string;
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

  // Per-tower entries keyed by `towers[]` index. Each owns its host
  // Group + the player-tint materials it cloned (shared texture/material
  // objects from tower-scene are not tracked — those are cached). Per-
  // tower disposal lets a single ownership flip rebuild one tower
  // instead of all of them.
  const entries = new Map<TowerIdx, TowerEntry>();
  // Last seen map reference — a new GameMap (rematch / fresh game) means
  // tower positions may have changed under stable indices, so we must
  // clear before re-syncing. Without this the per-tower signature
  // (ownerId + isHome) would happily match across games and leave
  // geometry at the previous match's coordinates.
  let lastMap: FrameCtx["map"] | undefined;

  function buildEntry(
    tower: Tower,
    ownerId: number | undefined,
    isHome: boolean,
    signature: string,
  ): TowerEntry | undefined {
    const variantName = isHome ? "home_tower" : "secondary_tower";
    const variant = getTowerVariant(variantName);
    if (!variant) return undefined;

    const host = new THREE.Group();
    buildTower(THREE, host, variant.params);

    // Position at tower centre: (col + 1, row + 1) * TILE_SIZE.
    host.position.set(
      tower.col * TILE_SIZE + TOWER_CENTER_OFFSET,
      0,
      tower.row * TILE_SIZE + TOWER_CENTER_OFFSET,
    );
    host.scale.setScalar(TOWER_SCALE);

    const ownedMaterials: THREE.Material[] = [];
    if (ownerId !== undefined) {
      // Flags use the vivid `interiorLight` tint for team readability at
      // the gameplay camera; stone body + parapets use the muted `wall`
      // tint so the silhouette feels player-coloured without washing out
      // the stonework.
      tintNamedMeshes(host, "flag", ownerId as ValidPlayerId, ownedMaterials);
      tintNamedMeshes(
        host,
        "body",
        ownerId as ValidPlayerId,
        ownedMaterials,
        "wall",
      );
      tintNamedMeshes(
        host,
        "parapet",
        ownerId as ValidPlayerId,
        ownedMaterials,
        "wall",
      );
      tintNamedMeshes(
        host,
        "pole_base",
        ownerId as ValidPlayerId,
        ownedMaterials,
        "wall",
      );
    }

    root.add(host);
    return { host, ownedMaterials, signature };
  }

  function disposeEntry(entry: TowerEntry): void {
    disposeGroupSubtree(entry.host, entry.ownedMaterials);
    root.remove(entry.host);
  }

  function clearAll(): void {
    for (const entry of entries.values()) disposeEntry(entry);
    entries.clear();
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    if (ctx.map !== lastMap) {
      clearAll();
      lastMap = ctx.map;
    }
    const towers = ctx.map?.towers;
    if (!towers || towers.length === 0) {
      clearAll();
      return;
    }
    const ownedTowers = overlay?.entities?.ownedTowers;
    const homeTowerIndices = overlay?.entities?.homeTowerIndices;
    const aliveMask = overlay?.entities?.towerAlive;

    const live = new Set<TowerIdx>();
    for (let idx = 0; idx < towers.length; idx++) {
      const i = idx as TowerIdx;
      // Skip dead towers — the 3D debris manager (entities/debris.ts)
      // renders their rubble under the separate `debris` layer flag.
      // `towerAlive === undefined` (no battle state yet) means "all alive".
      if (aliveMask && aliveMask[i] === false) continue;
      live.add(i);

      const ownerId = ownedTowers?.get(i);
      const isHome = homeTowerIndices?.has(i) ? 1 : 0;
      const signature = `${ownerId ?? "-"}:${isHome}`;

      const existing = entries.get(i);
      if (existing && existing.signature === signature) continue;
      if (existing) disposeEntry(existing);
      const fresh = buildEntry(towers[i]!, ownerId, isHome === 1, signature);
      if (fresh) entries.set(i, fresh);
      else entries.delete(i);
    }

    // Drop entries whose tower is no longer live (removed or just died).
    for (const [idx, entry] of entries) {
      if (live.has(idx)) continue;
      disposeEntry(entry);
      entries.delete(idx);
    }
  }

  function dispose(): void {
    clearAll();
    scene.remove(root);
  }

  return { update, dispose };
}
