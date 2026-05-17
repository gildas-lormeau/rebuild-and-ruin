/**
 * Cyan absorb-ring shown when a defensive shield eats an incoming hit —
 * rampart radius shielding a wall (wallShielded), or Shield Battery
 * shielding a cannon (cannonShielded). A single ring expands from
 * mid-tile out past the tile edge with a quick opacity fade. No flash,
 * no sparks — the message is "absorbed, nothing happened to the
 * defender". Pure visual effect driven by `overlay.battle.shieldFlashes`.
 */

import * as THREE from "three";
import {
  SHIELD_FLASH_DURATION,
  type ShieldFlash,
} from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import type { EffectManager } from "./fire-burst.ts";
import { createReconciler } from "./reconciler.ts";

interface FlashHost {
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
}

// Cyan-toward-white — reads as "energy shield" against the brown / grey
// terrain and is distinct from the warm yellow impact ring.
const SHIELD_RING_COLOR = 0x6ee0ff;
// Inner / outer radius ratios relative to TILE_SIZE. Ring scales
// uniformly each frame.
const RING_START_RADIUS_RATIO = 0.25;
const RING_END_RADIUS_RATIO = 0.85;

export function createShieldFlashManager(scene: THREE.Scene): EffectManager {
  const root = new THREE.Group();
  root.name = "shield-flashes";
  scene.add(root);

  // Shared ring geometry — inner/outer = 0.85/1.0 so the visible band is
  // 15% of the per-frame scale; thinner than the impact ring (0.9/1.0
  // visually similar but the absorb effect uses cyan to disambiguate).
  const ringGeometry = new THREE.RingGeometry(0.85, 1.0, 32);
  ringGeometry.rotateX(-Math.PI / 2);

  function buildHost(): FlashHost {
    const material = new THREE.MeshBasicMaterial({
      color: SHIELD_RING_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(ringGeometry, material);
    const group = new THREE.Group();
    group.add(mesh);
    root.add(group);
    return { group, mesh, material };
  }

  function disposeHost(host: FlashHost): void {
    host.material.dispose();
    root.remove(host.group);
  }

  function animateHost(host: FlashHost, flash: ShieldFlash): void {
    const progress = Math.min(
      1,
      Math.max(0, flash.age / SHIELD_FLASH_DURATION),
    );
    const centerX = flash.col * TILE_SIZE + TILE_SIZE / 2;
    const centerZ = flash.row * TILE_SIZE + TILE_SIZE / 2;
    host.group.position.set(centerX, ELEVATION_STACK.THAWING, centerZ);

    const radius =
      TILE_SIZE *
      (RING_START_RADIUS_RATIO +
        progress * (RING_END_RADIUS_RATIO - RING_START_RADIUS_RATIO));
    // Ease-out alpha: bright at the start, gone by the end.
    host.material.opacity = (1 - progress) * 0.8;
    host.mesh.scale.set(radius, 1, radius);
  }

  const reconciler = createReconciler<ShieldFlash, FlashHost>({
    build: buildHost,
    dispose: disposeHost,
    animate: animateHost,
  });

  function update(ctx: FrameCtx): void {
    reconciler.update(ctx.overlay?.battle?.shieldFlashes ?? []);
  }

  function dispose(): void {
    reconciler.disposeAll();
    ringGeometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
