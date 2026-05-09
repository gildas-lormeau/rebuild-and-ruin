/**
 * 3D cannonball meshes. Variant per ball: mortar / fire / iron (mirrors
 * `drawCannonballs`). Positions are already in pixel/world units so
 * `position.x = ball.x`, `position.z = ball.y`; lift = `sin(progress·π)
 * · LIFT_MAX` and ball scale fattens toward apex (parity with 2D).
 * Mesh set rebuilt only on count/variant fingerprint change; positions
 * rewrite every frame.
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
 *  from launch to apex (3→5 px and 4.5→7.5 px both land at +66%). The
 *  apex contour is approximated by sin(progress·π) since the renderer
 *  doesn't carry the trajectory's true peak; close enough for fattening. */
const SCALE_APEX_BONUS = 2 / 3;
/** Tumble cadence — different periods per axis so the spin reads as
 *  chaotic tumbling rather than a uniform rotation. Each ball gets a
 *  position-derived phase offset so simultaneously-fired balls don't
 *  spin in lock-step. */
const TUMBLE_PERIOD_X_MS = 1200;
const TUMBLE_PERIOD_Y_MS = 800;

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
    now: number,
  ): void {
    // The ball set fingerprint ensures host count matches ball count.
    // Walk in parallel — index i of root.children matches index i of
    // the overlay array.
    const hosts = root.children;
    const TWO_PI = Math.PI * 2;
    const tumbleX = (now / TUMBLE_PERIOD_X_MS) * TWO_PI;
    const tumbleY = (now / TUMBLE_PERIOD_Y_MS) * TWO_PI;
    for (let i = 0; i < balls.length; i++) {
      const ball = balls[i]!;
      const host = hosts[i];
      if (!(host instanceof THREE.Group)) continue;
      // Altitude comes straight from the sim — the ball follows the
      // pinned ballistic trajectory, so y == altitude already accounts
      // for the muzzle exit height, the parabolic arc, and the target
      // surface elevation at impact. No fake-arc, no muzzle-fade hack.
      host.position.set(ball.x, ball.altitude, ball.y);
      // Tumble: position-derived phase offset desyncs identical balls.
      // Iron is a plain sphere so rotation has no visible effect; the
      // mortar's equatorial band and the fire ball's offset flame puffs
      // both pick up the spin and read as motion.
      const phaseOffset = ball.x * 0.013 + ball.y * 0.017;
      host.rotation.set(tumbleX + phaseOffset, tumbleY + phaseOffset, 0);
      const arc = Math.sin(ball.progress * Math.PI);
      host.scale.setScalar(CANNONBALL_SCALE * (1 + arc * SCALE_APEX_BONUS));
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
    if (balls.length > 0) positionHosts(balls, ctx.now);
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
