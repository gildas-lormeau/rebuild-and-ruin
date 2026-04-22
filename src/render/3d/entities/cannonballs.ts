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
import type { GameMap } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type {
  OverlayCannonball,
  RenderOverlay,
} from "../../../shared/ui/overlay-types.ts";
import { targetTopAt } from "../elevation.ts";
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
/** Arc apex = flight distance × APEX_RATIO, clamped to at least
 *  MIN_APEX. Tuned so long shots stay inside the camera frustum:
 *  the map is ~28 tiles tall, so a 20-tile shot should apex around
 *  ~10 tiles. MIN_APEX keeps close shots from looking flat. */
const APEX_RATIO = 0.48;
const MIN_APEX = TILE_SIZE * 1.6;
/** Scale bonus at apex — matches the 2D formula's ~66% radius growth
 *  from launch to apex (3→5 px and 4.5→7.5 px both land at +66%). */
const SCALE_APEX_BONUS = 2 / 3;
/** Muzzle-tip offset applied at progress=0 so the ball visibly
 *  emerges from the barrel tip rather than from the cannon's ground
 *  center. Fades linearly to zero by progress=1 (impact).
 *    • forward: tier_1 barrel length ≈ 13 world units (half-length
 *      ~6.5) plus ~3.5 for barrel zOffset from cannon center → 10.
 *      Tuned by eye; close enough for every variant since larger
 *      cannons also have proportionally longer barrels relative to
 *      their footprints.
 *    • Y: barrel sits ~12 world units above the ground plane. See
 *      CANNON_TOP_Y = 14 in elevation.ts — we aim slightly below the
 *      top so the ball emerges from the bore, not the muzzle swell. */
const MUZZLE_FORWARD = 10;
const MUZZLE_Y = 12;

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

  function positionHosts(
    balls: readonly OverlayCannonball[],
    overlay: RenderOverlay | undefined,
    map: GameMap | undefined,
  ): void {
    // The ball set fingerprint ensures host count matches ball count.
    // Walk in parallel — index i of root.children matches index i of
    // the overlay array.
    const hosts = root.children;
    for (let i = 0; i < balls.length; i++) {
      const ball = balls[i]!;
      const host = hosts[i];
      if (!(host instanceof THREE.Group)) continue;
      // Parabolic arc: peaks at progress=0.5, zero at 0 and 1.
      const arc = Math.sin(ball.progress * Math.PI);
      // Floor elevation lerps from launch (ground level for now) to the
      // target's top. Using `targetTopAt` means balls landing on a
      // tower / cannon / house / grunt disappear at that entity's top
      // instead of punching through to the ground plane at Y=0.
      // Sampling only at the endpoints (not the ball's current
      // position) prevents the ball from "bobbing up" as it flies over
      // the shooter's own walls.
      const targetFloor = targetTopAt(ball.targetX, ball.targetY, overlay, map);
      const floor = targetFloor * ball.progress;
      // Apex lift scales with flight distance (a la Rampart's tall
      // arcs). Close shots bottom out at MIN_APEX so they still read
      // as arcs, long shots fly proportionally higher.
      const dx = ball.targetX - ball.startX;
      const dy = ball.targetY - ball.startY;
      const flightDist = Math.hypot(dx, dy);
      const apex = Math.max(MIN_APEX, flightDist * APEX_RATIO);
      // Muzzle-tip offset: at progress=0 the ball sits at the barrel
      // tip (forward along the firing direction + elevated to barrel
      // Y), fading linearly to zero by progress=1 so impact still
      // lands exactly at the target. Without this the ball visually
      // spawns at cannon-center-on-ground and "teleports" up+forward
      // on its first frame of flight.
      const muzzleFade = 1 - ball.progress;
      const fwdUnit = flightDist > 0 ? 1 / flightDist : 0;
      const muzzleOffX = dx * fwdUnit * MUZZLE_FORWARD * muzzleFade;
      const muzzleOffZ = dy * fwdUnit * MUZZLE_FORWARD * muzzleFade;
      const muzzleOffY = MUZZLE_Y * muzzleFade;
      host.position.set(
        ball.x + muzzleOffX,
        floor + arc * apex + muzzleOffY,
        ball.y + muzzleOffZ,
      );
      host.scale.setScalar(CANNONBALL_SCALE * (1 + arc * SCALE_APEX_BONUS));
    }
  }

  function update(ctx: FrameCtx): void {
    const { overlay, map } = ctx;
    const balls = overlay?.battle?.cannonballs ?? [];
    const signature = computeBallSetSignature(balls);
    if (signature !== lastBallSetSignature) {
      clear();
      lastBallSetSignature = signature;
      if (balls.length === 0) return;
      buildAllCannonballs(balls);
    }
    if (balls.length > 0) positionHosts(balls, overlay, map);
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
