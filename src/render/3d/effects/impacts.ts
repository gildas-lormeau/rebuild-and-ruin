/**
 * 3D impact effects — Phase 6 of the 3D renderer migration.
 *
 * Cannonball-hit flashes rendered as flat, camera-facing-up planes on the
 * ground (Y=0) at each impact's tile center. Mirrors the per-phase timeline
 * computed by `drawImpacts` in render-effects.ts:
 *
 *   0.0–0.25  core flash  (bright yellow disc, shrinks)
 *   0.0–0.6   shock ring  (yellow ring, expands)
 *   0.0–0.8   debris      (5 spark billboards flying outward)
 *   0.2–1.0   smoke puff  (dark disc, expands + rises)
 *
 * All phase progress math ports directly from the 2D impl — same constants,
 * same sin/cosine seeds. The 3D path swaps canvas strokes/fills for three
 * small meshes per impact that we size / colour / alpha each frame.
 *
 * Meshes are rebuilt whenever the impact set (fingerprinted by position)
 * changes; per-frame updates only rewrite material/alpha/scale/position. The
 * `Impact.age` timeline keeps ticking in game state, so the 3D path just
 * reads `age / IMPACT_FLASH_DURATION` to derive phase progress — identical
 * to 2D.
 */

import * as THREE from "three";
import type { Impact } from "../../../shared/core/battle-types.ts";
import { IMPACT_FLASH_DURATION } from "../../../shared/core/game-constants.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import type { RenderOverlay } from "../../../shared/ui/overlay-types.ts";
import { ELEVATION_STACK } from "../elevation.ts";
import { createFlatDisc, tileSeed, tileSignature } from "./helpers.ts";

export interface ImpactsManager {
  /** Per-frame update. Cheap early-out when the impact set (positions)
   *  hasn't changed; materials always update to drive the time-based
   *  phase animation. */
  update(overlay: RenderOverlay | undefined): void;
  /** Free GPU resources when the renderer is torn down. */
  dispose(): void;
}

interface ImpactHost {
  group: THREE.Group;
  core: THREE.Mesh;
  ring: THREE.Mesh;
  smoke: THREE.Mesh;
  sparks: THREE.Mesh[];
  coreMaterial: THREE.MeshBasicMaterial;
  ringMaterial: THREE.MeshBasicMaterial;
  smokeMaterial: THREE.MeshBasicMaterial;
  sparkMaterials: THREE.MeshBasicMaterial[];
  seed: number;
}

// Phase boundaries — mirror render-effects.ts exactly.
const IMPACT_CORE_END = 0.25;
const IMPACT_RING_END = 0.6;
const IMPACT_DEBRIS_END = 0.8;
const IMPACT_SMOKE_START = 0.2;
// Core flash
const IMPACT_CORE_SIZE_RATIO = 0.6;
const IMPACT_CORE_SHRINK_RATE = 1.2;
// Shock ring
const IMPACT_RING_INITIAL_RATIO = 0.5;
// Smoke
const SMOKE_BASE_RADIUS_RATIO = 0.4;
const SMOKE_EXPAND_RATIO = 0.3;
const SMOKE_RISE_PX = 4;
// Sparks
const SPARK_COUNT = 5;
const SPARK_ANGLE_STEP = 1.3;
const SPARK_BASE_SPEED_RATIO = 0.8;
const SPARK_SPEED_PER_PARTICLE = 3;
const SPARK_DROP_SPEED = 3;
const SPARK_ALPHA_SCALE = 0.9;
// Small lift keeps the effect above the terrain plane so z-fighting with
// the ground mesh doesn't produce shimmer. Half a pixel is enough given
// pixel-snap ortho camera.
// Colors
const CORE_COLOR = 0xffe0a0;
const RING_COLOR = 0xffcc44;
const SMOKE_COLOR = 0x3a3028;
const SPARK_COLOR_A = 0xffaa30;
const SPARK_COLOR_B = 0xff6600;

export function createImpactsManager(scene: THREE.Scene): ImpactsManager {
  const root = new THREE.Group();
  root.name = "impacts";
  scene.add(root);

  // Geometry shared by every effect disc / ring / spark — the meshes scale
  // per-frame so we only need one instance of each primitive.
  const discGeometry = createFlatDisc(24);
  const ringGeometry = new THREE.RingGeometry(0.9, 1.0, 32);
  ringGeometry.rotateX(-Math.PI / 2);
  const sparkGeometry = new THREE.PlaneGeometry(1, 1);
  sparkGeometry.rotateX(-Math.PI / 2);

  const ownedGeometries: THREE.BufferGeometry[] = [
    discGeometry,
    ringGeometry,
    sparkGeometry,
  ];

  const hosts: ImpactHost[] = [];
  let lastSignature: string | undefined;

  function buildHost(impact: Impact): ImpactHost {
    const group = new THREE.Group();
    const centerX = impact.col * TILE_SIZE + TILE_SIZE / 2;
    const centerZ = impact.row * TILE_SIZE + TILE_SIZE / 2;
    group.position.set(centerX, ELEVATION_STACK.IMPACTS, centerZ);

    const coreMaterial = new THREE.MeshBasicMaterial({
      color: CORE_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const core = new THREE.Mesh(discGeometry, coreMaterial);
    core.visible = false;
    group.add(core);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: RING_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.visible = false;
    group.add(ring);

    const smokeMaterial = new THREE.MeshBasicMaterial({
      color: SMOKE_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const smoke = new THREE.Mesh(discGeometry, smokeMaterial);
    smoke.visible = false;
    group.add(smoke);

    const sparks: THREE.Mesh[] = [];
    const sparkMaterials: THREE.MeshBasicMaterial[] = [];
    for (let spark = 0; spark < SPARK_COUNT; spark++) {
      const material = new THREE.MeshBasicMaterial({
        color: spark % 2 === 0 ? SPARK_COLOR_A : SPARK_COLOR_B,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(sparkGeometry, material);
      mesh.visible = false;
      group.add(mesh);
      sparks.push(mesh);
      sparkMaterials.push(material);
    }

    root.add(group);
    return {
      group,
      core,
      ring,
      smoke,
      sparks,
      coreMaterial,
      ringMaterial,
      smokeMaterial,
      sparkMaterials,
      seed: tileSeed(impact.row, impact.col),
    };
  }

  function clear(): void {
    for (const host of hosts) {
      host.coreMaterial.dispose();
      host.ringMaterial.dispose();
      host.smokeMaterial.dispose();
      for (const material of host.sparkMaterials) material.dispose();
      root.remove(host.group);
    }
    hosts.length = 0;
  }

  function rebuild(impacts: readonly Impact[]): void {
    clear();
    for (const impact of impacts) hosts.push(buildHost(impact));
  }

  function animateHost(host: ImpactHost, impact: Impact): void {
    const time = impact.age / IMPACT_FLASH_DURATION;
    if (time >= 1) {
      host.core.visible = false;
      host.ring.visible = false;
      host.smoke.visible = false;
      for (const spark of host.sparks) spark.visible = false;
      return;
    }

    // Core flash: bright disc shrinking quickly.
    if (time < IMPACT_CORE_END) {
      const coreAlpha = (1 - time / IMPACT_CORE_END) * 0.6;
      const coreSize =
        TILE_SIZE * (IMPACT_CORE_SIZE_RATIO - time * IMPACT_CORE_SHRINK_RATE);
      const safeSize = Math.max(1, coreSize);
      host.coreMaterial.opacity = coreAlpha;
      host.core.scale.set(safeSize, 1, safeSize);
      host.core.visible = true;
    } else {
      host.core.visible = false;
    }

    // Shock ring: expands outward.
    if (time < IMPACT_RING_END) {
      const ringR = TILE_SIZE * IMPACT_RING_INITIAL_RATIO + time * TILE_SIZE;
      host.ringMaterial.opacity = (1 - time / IMPACT_RING_END) * 0.7;
      host.ring.scale.set(ringR, 1, ringR);
      host.ring.visible = true;
    } else {
      host.ring.visible = false;
    }

    // Debris sparks: 5 particles fly outward from center.
    if (time < IMPACT_DEBRIS_END) {
      const sparkAlpha = 1 - time / IMPACT_DEBRIS_END;
      for (let i = 0; i < SPARK_COUNT; i++) {
        const angle = (host.seed + i * SPARK_ANGLE_STEP) % (Math.PI * 2);
        const dist =
          time *
          (TILE_SIZE * SPARK_BASE_SPEED_RATIO + i * SPARK_SPEED_PER_PARTICLE);
        const sx = Math.cos(angle) * dist;
        // The 2D code subtracts time * SPARK_DROP_SPEED from `sy` (canvas Y
        // grows downward). Our Z axis grows "downward" too (row 0 at Z=0,
        // higher row = larger Z), so the same subtraction reads naturally.
        const sz = Math.sin(angle) * dist - time * SPARK_DROP_SPEED;
        const spark = host.sparks[i]!;
        const material = host.sparkMaterials[i]!;
        spark.position.set(sx, 0, sz);
        spark.scale.set(2, 1, 2);
        material.opacity = sparkAlpha * SPARK_ALPHA_SCALE;
        spark.visible = true;
      }
    } else {
      for (const spark of host.sparks) spark.visible = false;
    }

    // Smoke: dark puff rising in second half.
    if (time > IMPACT_SMOKE_START) {
      const smokeT = (time - IMPACT_SMOKE_START) / (1 - IMPACT_SMOKE_START);
      const smokeR =
        TILE_SIZE * SMOKE_BASE_RADIUS_RATIO +
        smokeT * TILE_SIZE * SMOKE_EXPAND_RATIO;
      host.smokeMaterial.opacity = (1 - smokeT) * 0.35;
      // The 2D version offsets the puff upward in screen Y (cy - rise). On
      // the ground plane we keep the disc at Y=ELEVATION_STACK.IMPACTS but shift it
      // toward the camera (-Z) so it reads as "rising" from the top-down.
      host.smoke.position.set(0, 0, -smokeT * SMOKE_RISE_PX);
      host.smoke.scale.set(smokeR, 1, smokeR);
      host.smoke.visible = true;
    } else {
      host.smoke.visible = false;
    }
  }

  function update(overlay: RenderOverlay | undefined): void {
    const impacts = overlay?.battle?.impacts ?? [];
    const signature = tileSignature(impacts);
    if (signature !== lastSignature) {
      lastSignature = signature;
      rebuild(impacts);
    }
    if (impacts.length === 0) return;
    for (let i = 0; i < impacts.length; i++) {
      const host = hosts[i];
      if (!host) continue;
      animateHost(host, impacts[i]!);
    }
  }

  function dispose(): void {
    clear();
    for (const geometry of ownedGeometries) geometry.dispose();
    scene.remove(root);
  }

  return { update, dispose };
}
