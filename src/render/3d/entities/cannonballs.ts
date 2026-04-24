/**
 * 3D cannonball meshes — Phase 4 of the 3D renderer migration.
 *
 * Renders every in-flight cannonball present on the overlay. Unlike
 * static entities, cannonballs move sub-tile every frame (the 2D path
 * interpolates x/y in pixels per second), so the manager MUST update
 * per frame — a fingerprint early-out only works when the ball set
 * itself has changed (count or variant mix).
 *
 * Variant selection (mirrors the 2D color picker in `drawCannonballs`
 * — render-effects.ts):
 *
 *   • ball.mortar     → `cannonball_mortar` (darker iron + equatorial band)
 *   • ball.incendiary → `cannonball_fire`   (red + flame puffs)
 *   • otherwise       → `cannonball_iron`   (plain dark iron)
 *
 * Altitude & scaling (matches the 2D formula from drawCannonballs):
 *   height = sin(progress · π)        // 0 at launch/impact, 1 at apex
 *   radius = baseRadius + height · arcBonus
 * 2D base/bonus radii (normal 3/2, mortar 4.5/3) mean a normal ball
 * grows 3→5 px (+66%) and a mortar grows 4.5→7.5 px (+66%) over the
 * arc. We mirror the same +height · (arcBonus / baseRadius) SCALE
 * multiplier against the authored sphere (which is already sized
 * correctly per variant), so the ball fattens toward the apex the
 * same way the 2D circle does. Note: the 2D arc has the ball LARGER
 * at the apex and smaller at launch/impact — the task description's
 * "apex = smaller, near-ground = larger" does not match the 2D
 * implementation. We follow the 2D source as the ground truth (this
 * is the "parity first" migration) and document the deviation here.
 *
 * Y (lift): the parabolic arc also raises the host group so the ball
 * visibly rises and falls. `host.position.y = height · LIFT_MAX`
 * where LIFT_MAX = TILE_SIZE / 2 (half a tile at apex), matching the
 * 2D arcBonus magnitude relative to a ball radius.
 *
 * X/Z: `ball.x` / `ball.y` from the overlay are already in surface
 * pixels, which equals world units (1 world unit = 1 game-1× pixel —
 * see `scene.ts` header). So position.x = ball.x and position.z =
 * ball.y directly, no TILE_SIZE scaling needed (the ball's position
 * is sub-tile, already in pixel units).
 *
 * Update cadence: every frame — no fingerprint early-out on the
 * whole update, because positions move continuously. We DO keep a
 * lightweight "ball set fingerprint" (count + ordered variant list)
 * to rebuild the mesh set only when balls spawn, despawn, or reorder.
 * In between, we just reposition and rescale existing host groups.
 * Phase 8 revisits perf (mesh pool, InstancedMesh) if needed; typical
 * battle cannonball counts are <10.
 */

import * as THREE from "three";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { OverlayCannonball } from "../../../shared/ui/overlay-types.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import {
  buildCannonball,
  getCannonballVariant,
} from "../sprites/cannonball-scene.ts";
import { disposeGroupSubtree } from "./entity-helpers.ts";

export interface CannonballsManager {
  /** Per-frame update. Cheap when the ball set hasn't changed — only
   *  positions/scales get rewritten. Rebuilds meshes when the ball
   *  set (count or variant list) changes. */
  update(ctx: FrameCtx): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

/** Cannonball scenes are authored in a ±1 frustum covering a 1-tile
 *  span, so scaling by TILE_SIZE / 2 makes 1 authored unit = half a
 *  tile (the full ±1 sprite fits inside a 1×1 tile). Matches the
 *  grunt scale convention. */
const CANNONBALL_SCALE = TILE_SIZE / 2;
/** Scale bonus at apex — matches the 2D formula's ~66% radius growth
 *  from launch to apex (3→5 px and 4.5→7.5 px both land at +66%).
 *  Driven by altitude relative to a "typical apex" reference height
 *  rather than `sin(progress·π)` so the scale bump tracks the actual
 *  ballistic curve instead of a faked one. */
const SCALE_APEX_BONUS = 2 / 3;
/** Reference altitude (world units) at which the scale bonus reaches
 *  its full +SCALE_APEX_BONUS multiplier. Roughly the apex of a
 *  mid-range shot (~30 tiles); higher shots cap at full bonus, lower
 *  shots scale proportionally. */
const SCALE_APEX_REFERENCE_Y = 110;

export function createCannonballsManager(
  scene: THREE.Scene,
): CannonballsManager {
  const root = new THREE.Group();
  root.name = "cannonballs";
  scene.add(root);

  // No player-tinted materials — cannonballs are neutral across
  // owners (variant encodes "type of shot", not player color).
  const ownedMaterials: THREE.Material[] = [];
  /** Fingerprint of the current mesh set — rebuilt only when this
   *  changes. Positions/scales are rewritten every frame regardless. */
  let lastBallSetSignature: string | undefined;

  function clear(): void {
    disposeGroupSubtree(root, ownedMaterials);
    lastBallSetSignature = undefined;
  }

  function buildAllCannonballs(balls: readonly OverlayCannonball[]): void {
    for (const ball of balls) {
      const variantName = selectVariantName(ball);
      const variant = getCannonballVariant(variantName);
      if (!variant) continue;
      const host = new THREE.Group();
      buildCannonball(THREE, host, variant.params);
      root.add(host);
    }
  }

  function positionHosts(balls: readonly OverlayCannonball[]): void {
    // The ball set fingerprint ensures host count matches ball count.
    // Walk in parallel — index i of root.children matches index i of
    // the overlay array.
    const hosts = root.children;
    for (let i = 0; i < balls.length; i++) {
      const ball = balls[i]!;
      const host = hosts[i];
      if (!(host instanceof THREE.Group)) continue;
      // Trajectory is fully resolved by the simulation: ball.x, ball.y
      // (xz plane) and ball.altitude (worldY) are the parabolic
      // closed-form result. Renderer just plots the point.
      host.position.set(ball.x, ball.altitude, ball.y);
      // Scale grows with altitude as a perspective cue, peaking at
      // SCALE_APEX_REFERENCE_Y (typical mid-range apex). Capped at
      // 1 + SCALE_APEX_BONUS so very high shots don't blow up.
      const altScale = Math.min(1, ball.altitude / SCALE_APEX_REFERENCE_Y);
      host.scale.setScalar(
        CANNONBALL_SCALE * (1 + altScale * SCALE_APEX_BONUS),
      );
    }
  }

  function update(ctx: FrameCtx): void {
    const { overlay } = ctx;
    const balls = overlay?.battle?.cannonballs ?? [];
    const signature = computeBallSetSignature(balls);
    if (signature !== lastBallSetSignature) {
      clear();
      lastBallSetSignature = signature;
      if (balls.length === 0) return;
      buildAllCannonballs(balls);
    }
    if (balls.length > 0) positionHosts(balls);
  }

  function dispose(): void {
    clear();
    scene.remove(root);
  }

  return { update, dispose };
}

/** Fingerprint of the current ball set — count + ordered variant
 *  list. Rebuilds meshes only when this changes; positions/scales are
 *  rewritten every frame regardless (so sub-tile motion during flight
 *  always updates without a rebuild). */
function computeBallSetSignature(balls: readonly OverlayCannonball[]): string {
  if (balls.length === 0) return "";
  const parts: string[] = [];
  for (const ball of balls) parts.push(selectVariantName(ball));
  return parts.join("|");
}

/** Pick a cannonball-scene variant name by overlay flags. Mirrors the
 *  2D `drawCannonballs` color switch (mortar > incendiary > default). */
function selectVariantName(ball: OverlayCannonball): string {
  if (ball.mortar) return "cannonball_mortar";
  if (ball.incendiary) return "cannonball_fire";
  return "cannonball_iron";
}
