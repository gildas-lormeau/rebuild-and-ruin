/**
 * 3D crosshair indicators — Phase 6 of the 3D renderer migration.
 *
 * During battle, each active player has a crosshair hovering over their
 * aim point. The 2D renderer draws eight arms (four cardinals + four
 * diagonals) with a pulsing alpha / arm length driven by `cannonReady`
 * state. The 3D path reproduces this as flat, upward-facing planes laid
 * on the ground plane — the same pulse / arm math from render-effects.ts
 * ports directly.
 *
 * Geometry strategy: each arm is a thin rectangle scaled per-frame to
 * `arm`/`diag` length and `gap` offset. Eight arms per crosshair: four
 * white cardinals + four colored diagonals (per-player colour). A bigger
 * darker "shadow" plane sits under each arm to mimic the 2D stroke's
 * black outer stroke.
 *
 * We rebuild the mesh set on count change only; positions + scales +
 * alphas update every frame because the pulse is continuous and the
 * aim point can drift between frames.
 */

import * as THREE from "three";
import type { GameMap } from "../../../shared/core/geometry-types.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { aimElevationAt } from "../elevation.ts";

export interface CrosshairsManager {
  /** Per-frame update. Materials + positions/scales always rewrite;
   *  mesh pool only rebuilds when crosshair count changes. */
  update(
    overlay: RenderOverlay | undefined,
    map: GameMap | undefined,
    now: number,
  ): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface ArmMesh {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  shadowMesh: THREE.Mesh;
  shadowMaterial: THREE.MeshBasicMaterial;
}

interface CrosshairHost {
  group: THREE.Group;
  // Eight arms: 4 diagonals (colored) then 4 cardinals (white).
  diagArms: ArmMesh[];
  cardArms: ArmMesh[];
  color: number;
}

// Pulse timing + geometry — mirror render-effects.ts exactly.
const CROSSHAIR_READY_CYCLE_MS = 16;
const CROSSHAIR_IDLE_CYCLE_MS = 4;
const CROSSHAIR_ARM_READY = 14;
const CROSSHAIR_ARM_IDLE = 10;
const CROSSHAIR_ARM_PULSE = 3;
const CROSSHAIR_DIAG_RATIO = 0.7;
const CROSSHAIR_ALPHA_READY_BASE = 0.7;
const CROSSHAIR_ALPHA_READY_AMP = 0.3;
const CROSSHAIR_ALPHA_IDLE_BASE = 0.35;
const CROSSHAIR_ALPHA_IDLE_AMP = 0.15;
const CROSSHAIR_GAP_READY = 5;
const CROSSHAIR_GAP_IDLE = 3;
// Per-player crosshair colors — parity with CROSSHAIR_COLORS in render-effects.ts.
const CROSSHAIR_COLORS: number[] = [
  0xff3232, // P1 red
  0x3c82ff, // P2 blue
  0xffc81e, // P3 gold
];
const WHITE = 0xffffff;
const BLACK = 0x000000;
// Fraction of the arm's length that the "shadow stroke" is thicker by —
// 2D uses lineWidth 5 for the shadow and lineWidth 2 for the arm.
const ARM_THICKNESS = 2;
const SHADOW_THICKNESS = 5;
// Arm lifted slightly above terrain + above impact discs so it reads as
// the topmost effect, matching the 2D layer order (crosshairs > impacts).
const CROSSHAIR_Y_LIFT = 0.8;

export function createCrosshairsManager(scene: THREE.Scene): CrosshairsManager {
  const root = new THREE.Group();
  root.name = "crosshairs";
  scene.add(root);

  // Shared unit rectangle — scaled per-arm each frame.
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);

  const hosts: CrosshairHost[] = [];

  function buildArm(color: number): ArmMesh {
    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: BLACK,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const shadowMesh = new THREE.Mesh(geometry, shadowMaterial);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    return { mesh, material, shadowMesh, shadowMaterial };
  }

  function buildHost(color: number): CrosshairHost {
    const group = new THREE.Group();
    const diagArms: ArmMesh[] = [];
    const cardArms: ArmMesh[] = [];
    for (let i = 0; i < 4; i++) {
      const arm = buildArm(color);
      group.add(arm.shadowMesh);
      group.add(arm.mesh);
      diagArms.push(arm);
    }
    for (let i = 0; i < 4; i++) {
      const arm = buildArm(WHITE);
      group.add(arm.shadowMesh);
      group.add(arm.mesh);
      cardArms.push(arm);
    }
    root.add(group);
    return { group, diagArms, cardArms, color };
  }

  function disposeArm(arm: ArmMesh): void {
    arm.material.dispose();
    arm.shadowMaterial.dispose();
  }

  function disposeHost(host: CrosshairHost): void {
    for (const arm of host.diagArms) disposeArm(arm);
    for (const arm of host.cardArms) disposeArm(arm);
    root.remove(host.group);
  }

  function ensurePool(count: number, colors: readonly number[]): void {
    while (hosts.length < count) hosts.push(buildHost(colors[hosts.length]!));
    while (hosts.length > count) {
      const host = hosts.pop();
      if (host) disposeHost(host);
    }
    // Recolor existing hosts if player mapping shifted.
    for (let i = 0; i < hosts.length; i++) {
      const want = colors[i]!;
      const host = hosts[i]!;
      if (host.color !== want) {
        host.color = want;
        for (const arm of host.diagArms) arm.material.color.setHex(want);
      }
    }
  }

  function positionArm(
    arm: ArmMesh,
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    alpha: number,
    baseY: number,
  ): void {
    const deltaX = toX - fromX;
    const deltaZ = toZ - fromZ;
    const length = Math.hypot(deltaX, deltaZ);
    const centerX = (fromX + toX) / 2;
    const centerZ = (fromZ + toZ) / 2;
    // PlaneGeometry(1,1) rotated into XZ lies along X by default; rotate
    // around Y so local X aligns with the from→to direction.
    const angle = Math.atan2(deltaZ, deltaX);
    arm.mesh.position.set(centerX, baseY + CROSSHAIR_Y_LIFT + 0.1, centerZ);
    arm.mesh.rotation.y = -angle;
    arm.mesh.scale.set(length, 1, ARM_THICKNESS);
    arm.material.opacity = alpha;
    arm.mesh.visible = alpha > 0.001;
    arm.shadowMesh.position.set(centerX, baseY + CROSSHAIR_Y_LIFT, centerZ);
    arm.shadowMesh.rotation.y = -angle;
    arm.shadowMesh.scale.set(length, 1, SHADOW_THICKNESS);
    arm.shadowMaterial.opacity = alpha * 0.8;
    arm.shadowMesh.visible = arm.mesh.visible;
  }

  function update(
    overlay: RenderOverlay | undefined,
    map: GameMap | undefined,
    now: number,
  ): void {
    const crosshairs = overlay?.battle?.crosshairs ?? [];
    const colors = crosshairs.map(
      (ch) => CROSSHAIR_COLORS[ch.playerId % CROSSHAIR_COLORS.length]!,
    );
    ensurePool(crosshairs.length, colors);
    if (crosshairs.length === 0) return;

    const time = now / 1000;
    for (let i = 0; i < crosshairs.length; i++) {
      const ch = crosshairs[i]!;
      const host = hosts[i]!;
      const centerX = ch.x;
      const centerZ = ch.y;
      const geom = crosshairGeometry(ch.cannonReady === true, time);
      const { alpha, arm, diag, gap } = geom;
      // Lift the crosshair onto the top of whatever geometry sits at
      // the aim point (wall / tower / cannon / house / grunt) —
      // otherwise the glow draws on the ground plane and visually
      // passes through the target.
      const baseY = aimElevationAt(centerX, centerZ, overlay, map);

      // Diagonals (colored): NW, NE, SW, SE.
      positionArm(
        host.diagArms[0]!,
        centerX - gap,
        centerZ - gap,
        centerX - diag,
        centerZ - diag,
        alpha,
        baseY,
      );
      positionArm(
        host.diagArms[1]!,
        centerX + gap,
        centerZ - gap,
        centerX + diag,
        centerZ - diag,
        alpha,
        baseY,
      );
      positionArm(
        host.diagArms[2]!,
        centerX - gap,
        centerZ + gap,
        centerX - diag,
        centerZ + diag,
        alpha,
        baseY,
      );
      positionArm(
        host.diagArms[3]!,
        centerX + gap,
        centerZ + gap,
        centerX + diag,
        centerZ + diag,
        alpha,
        baseY,
      );

      // Cardinals (white): N, S, W, E.
      positionArm(
        host.cardArms[0]!,
        centerX,
        centerZ - gap,
        centerX,
        centerZ - arm,
        alpha,
        baseY,
      );
      positionArm(
        host.cardArms[1]!,
        centerX,
        centerZ + gap,
        centerX,
        centerZ + arm,
        alpha,
        baseY,
      );
      positionArm(
        host.cardArms[2]!,
        centerX - gap,
        centerZ,
        centerX - arm,
        centerZ,
        alpha,
        baseY,
      );
      positionArm(
        host.cardArms[3]!,
        centerX + gap,
        centerZ,
        centerX + arm,
        centerZ,
        alpha,
        baseY,
      );
    }
  }

  function dispose(): void {
    for (const host of hosts) disposeHost(host);
    hosts.length = 0;
    geometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}

/** Compute animated crosshair dimensions from ready state and time.
 *  Mirrors crosshairGeometry() in render-effects.ts. */
function crosshairGeometry(
  ready: boolean,
  time: number,
): { alpha: number; arm: number; diag: number; gap: number } {
  const alpha = ready
    ? CROSSHAIR_ALPHA_READY_BASE +
      CROSSHAIR_ALPHA_READY_AMP * Math.sin(time * CROSSHAIR_READY_CYCLE_MS)
    : CROSSHAIR_ALPHA_IDLE_BASE +
      CROSSHAIR_ALPHA_IDLE_AMP * Math.sin(time * CROSSHAIR_IDLE_CYCLE_MS);
  const arm = ready
    ? CROSSHAIR_ARM_READY +
      Math.sin(time * CROSSHAIR_READY_CYCLE_MS) * CROSSHAIR_ARM_PULSE
    : CROSSHAIR_ARM_IDLE;
  const diag = Math.round(arm * CROSSHAIR_DIAG_RATIO);
  const gap = ready ? CROSSHAIR_GAP_READY : CROSSHAIR_GAP_IDLE;
  return { alpha, arm, diag, gap };
}
