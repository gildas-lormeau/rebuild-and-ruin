/**
 * 3D burning-pit meshes — Phase 4 of the 3D renderer migration.
 *
 * Burning pits are 1×1 tile, ownerless hazards created by mortar /
 * super-gun (fire) cannonball impacts. Each pit lives 3 battle rounds,
 * fading through three authored variants as its `roundsLeft` counter
 * ticks down:
 *
 *   roundsLeft = 3 → `pit_fresh`  (tall flames + hot lava)
 *   roundsLeft = 2 → `pit_dim`    (shorter flames + warm lava)
 *   roundsLeft = 1 → `pit_embers` (no flames, cool embers only)
 *
 * This mirrors the 2D renderer's stage picker in
 * `drawBurningPits` (render-effects.ts), which uses sprites named
 * `burning_pit_3` / `_2` / `_1` keyed on the same counter.
 *
 * Reconciliation: a composite fingerprint of `col:row:variant` per pit
 * covers everything worth rebuilding for. A pit enters the set, its
 * variant swaps on a round decrement, or the set shrinks when the
 * counter hits zero — each of those flips the fingerprint and triggers
 * a full rebuild. Pit counts are bounded (only mortar/fire impacts
 * create them) so tear-down + rebuild is cheap enough here; Phase 8
 * can revisit if profiling warrants.
 *
 * Transparent background: the sprite's charred disc is a narrow ring
 * that does NOT fill the whole tile, so the terrain mesh underneath
 * (including the `PIT_COLOR` brown marker painted by `terrain.ts`)
 * shows through the tile corners. That brown tile-wide tint is kept to
 * frame the pit — the sprite provides the center detail (lava, flames,
 * rim debris).
 */

import * as THREE from "three";
import type { BurningPit } from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { buildPit, getPitVariant } from "../sprites/pit-scene.ts";
import { disposeGroupSubtree } from "./entity-helpers.ts";

export interface PitsManager {
  /** Reconcile pit meshes with the overlay. Cheap no-op when the
   *  composite fingerprint (per-pit col:row:variant) hasn't changed. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

/** Pit scenes are authored in a ±1 frustum spanning a 1-tile footprint.
 *  Scaling by TILE_SIZE / 2 maps 1 authored unit = half a tile, so the
 *  full ±1 sprite fits inside the 1×1 tile cell. Matches the grunt /
 *  cannonball scale convention. */
const PIT_SCALE = TILE_SIZE / 2;
/** 1×1 pits anchor at their single tile; center sits half a tile
 *  inward (identical to the grunts manager convention). */
const TILE_1X1_CENTER_OFFSET = TILE_SIZE / 2;

export function createPitsManager(scene: THREE.Scene): PitsManager {
  const root = new THREE.Group();
  root.name = "pits";
  scene.add(root);

  // No per-pit tinted materials — pits are neutral hazards. Kept for
  // parity with the other managers so future owner-tinting (e.g. "your
  // mortar pits" UI hint) can plug in.
  const ownedMaterials: THREE.Material[] = [];
  let lastSignature: string | undefined;

  function clear(): void {
    disposeGroupSubtree(root, ownedMaterials);
  }

  function buildAllPits(pits: readonly BurningPit[]): void {
    for (const pit of pits) {
      const variantName = selectVariantName(pit.roundsLeft);
      const variant = getPitVariant(variantName);
      if (!variant) continue;
      const host = new THREE.Group();
      buildPit(THREE, host, variant.params);
      host.position.set(
        pit.col * TILE_SIZE + TILE_1X1_CENTER_OFFSET,
        0,
        pit.row * TILE_SIZE + TILE_1X1_CENTER_OFFSET,
      );
      host.scale.setScalar(PIT_SCALE);
      root.add(host);
    }
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    const pits = overlay?.entities?.burningPits ?? [];
    const signature = computeSignature(pits);
    if (signature === lastSignature) return;
    lastSignature = signature;

    clear();
    if (pits.length === 0) return;
    buildAllPits(pits);
  }

  function dispose(): void {
    clear();
    scene.remove(root);
  }

  return { update, dispose };
}

/** Composite signature across every pit. Rebuilds only when one of
 *  the watched fields changes (position, set membership, or variant
 *  from a round decrement). */
function computeSignature(pits: readonly BurningPit[]): string {
  if (pits.length === 0) return "";
  const parts: string[] = [];
  for (const pit of pits) {
    parts.push(`${pit.col}:${pit.row}:${selectVariantName(pit.roundsLeft)}`);
  }
  return parts.join("|");
}

/** Pick a pit-scene variant name from the remaining-rounds counter.
 *  Mirrors the 2D stage picker in `drawBurningPits`: clamps to [1, 3]
 *  and maps 3 → fresh, 2 → dim, 1 → embers. */
function selectVariantName(roundsLeft: number): string {
  const stage = Math.max(1, Math.min(3, roundsLeft));
  if (stage === 3) return "pit_fresh";
  if (stage === 2) return "pit_dim";
  return "pit_embers";
}
