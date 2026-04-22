/**
 * 3D wall-burn effect — fire / smoke / sparks burst when a wall is
 * destroyed.
 *
 * Reads `overlay.battle.wallBurns: WallBurn[]` and reconciles a per-tile
 * host group that holds a small bundle of meshes:
 *   - 3 flame clusters (yellow core + orange body + red tuft) authored
 *     as LatheGeometry teardrops so they read as licking flames, not
 *     party-hat cones. Per-frame sin jitter on Y-scale + emissive
 *     intensity gives the crackle.
 *   - 5 stacked camera-facing smoke puffs (radial-gradient texture, dark
 *     gray) that rise + expand + fade.
 *   - 12 spark billboards on a real ballistic arc (units/sec velocities,
 *     gravity in units/sec²) that pop outward then settle on the ground.
 *   - 1 brief white flash disc in the first ~12% of life.
 *
 * Effect lifetime is `WALL_BURN_DURATION` (~0.7 s). Aging happens in
 * `ageImpacts` on the runtime side; expired entries drop out of
 * `battleAnim.wallBurns` and the host is disposed on the next reconcile.
 *
 * Per-burn variation (cluster offsets, flame sizes, spark angles, smoke
 * jitter) is seeded deterministically from `tileSeed(row, col)` so a
 * given tile always animates the same way — no spawn-time random state
 * lives on `WallBurn` itself.
 */

import * as THREE from "three";
import {
  WALL_BURN_DURATION,
  type WallBurn,
} from "../../../shared/core/battle-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { tileSeed, tileSignature } from "./helpers.ts";

export interface WallBurnsManager {
  update(ctx: FrameCtx): void;
  dispose(): void;
}

interface FlameMesh {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  baseRadius: number;
  baseHeight: number;
  baseEmissive: number;
  phase: number;
}

interface SmokePuff {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  delay: number;
  riseSpeed: number;
  baseScale: number;
  stretchX: number;
  stretchY: number;
  rot: number;
}

interface SparkMesh {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
}

interface BurnHost {
  group: THREE.Group;
  flames: FlameMesh[];
  smoke: SmokePuff[];
  sparks: SparkMesh[];
  flash: THREE.Mesh;
  flashMaterial: THREE.MeshBasicMaterial;
}

const CLUSTER_COUNT = 3;
const SPARK_COUNT = 12;
const SMOKE_PUFF_COUNT = 5;
// Flame layer materials. Emissive slightly above base so flames glow
// against the scene's directional light (mirrors pit-scene FLAME_*).
const FLAME_LAYERS = [
  {
    color: 0xffe066,
    emissive: 0xffaa00,
    emissiveIntensity: 1.4,
    rRatio: 0.25,
    hMul: 1.0,
    phaseOff: 0.0,
  },
  {
    color: 0xff8a30,
    emissive: 0xcc4400,
    emissiveIntensity: 1.1,
    rRatio: 0.375,
    hMul: 0.78,
    phaseOff: 1.3,
  },
  {
    color: 0xc83018,
    emissive: 0x661800,
    emissiveIntensity: 0.9,
    rRatio: 0.3,
    hMul: 0.55,
    phaseOff: 2.4,
  },
] as const;
const SMOKE_COLOR = 0x303036;
const SPARK_COLOR = 0xffd066;
const FLASH_COLOR = 0xffffcc;
// Flame nominal height in tile units — half a tile reads well at the
// in-game camera tilt. cells(8) of a 16-cell tile = TILE_SIZE / 2.
const FLAME_HEIGHT = TILE_SIZE / 2;
// Crackle amplitude (0..1) — sin jitter on flame Y-scale and emissive.
const CRACKLE = 0.35;
// Sparks: velocities expressed as tile-multiples so the burst keeps a
// consistent visual scale across TILE_SIZE changes.
const SPARK_HORIZ_MIN = 1.0;
// tiles/sec
const SPARK_HORIZ_RANGE = 1.3;
const SPARK_VERT_MIN = 2.1;
const SPARK_VERT_RANGE = 1.4;
const SPARK_GRAVITY = 15;
// tiles/sec²
const SPARK_SIZE_MIN = 0.16;
// tiles
const SPARK_SIZE_RANGE = 0.12;
// Smoke puff base radius (tiles) and rise speed (tiles/sec).
const SMOKE_BASE_RADIUS = 0.225;
const SMOKE_RISE_BASE = 1.1;
const SMOKE_RISE_STEP = 0.16;
// Initial flash: brief bright disc, gone by 12% of life.
const FLASH_RADIUS = 0.55;
// tiles
const FLASH_DURATION = 0.12;
const FLAME_PROFILE_SEGMENTS = 12;
const SMOKE_TEXTURE_SIZE = 128;

// Module-level resources reused across all hosts. The flame lathe is
// authored at unit size and scaled per-flame; the smoke texture is the
// soft radial gradient from the demo, used by both smoke + spark
// sprites (a soft round splat reads fine for both).
let sharedFlameGeometry: THREE.LatheGeometry | undefined;
let sharedSmokeTexture: THREE.CanvasTexture | undefined;
let sharedFlashGeometry: THREE.CircleGeometry | undefined;

export function createWallBurnsManager(scene: THREE.Scene): WallBurnsManager {
  const root = new THREE.Group();
  root.name = "wall-burns";
  scene.add(root);

  ensureSharedResources();

  const hosts: BurnHost[] = [];
  let lastSignature: string | undefined;

  function update(ctx: FrameCtx): void {
    const burns = ctx.overlay?.battle?.wallBurns ?? [];
    const signature = tileSignature(burns);
    if (signature !== lastSignature) {
      lastSignature = signature;
      rebuild(burns);
    }
    if (burns.length === 0) return;
    for (let i = 0; i < burns.length; i++) {
      const host = hosts[i];
      const burn = burns[i];
      if (!host || !burn) continue;
      animateHost(host, burn);
    }
  }

  function rebuild(burns: readonly WallBurn[]): void {
    clear();
    for (const burn of burns) hosts.push(buildHost(burn));
  }

  function clear(): void {
    // Geometry (flame lathe, flash disc) and the smoke texture are
    // module-level shared resources owned by `ensureSharedResources` —
    // disposing them per-host would break subsequent burns. Materials
    // are owned per-host (each carries its own opacity / emissive
    // tweaks) so they MUST be disposed here.
    for (const host of hosts) {
      for (const flame of host.flames) flame.material.dispose();
      for (const puff of host.smoke) puff.material.dispose();
      for (const spark of host.sparks) spark.material.dispose();
      host.flashMaterial.dispose();
      root.remove(host.group);
    }
    hosts.length = 0;
  }

  function buildHost(burn: WallBurn): BurnHost {
    const group = new THREE.Group();
    group.position.set(
      burn.col * TILE_SIZE + TILE_SIZE / 2,
      ELEVATION_STACK.WALL_BURNS,
      burn.row * TILE_SIZE + TILE_SIZE / 2,
    );
    root.add(group);

    const seed = tileSeed(burn.row, burn.col);
    const flames = buildFlames(group, seed);
    const smoke = buildSmoke(group, seed);
    const sparks = buildSparks(group, seed);
    const flashMaterial = new THREE.MeshBasicMaterial({
      color: FLASH_COLOR,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const flash = new THREE.Mesh(sharedFlashGeometry, flashMaterial);
    flash.scale.setScalar(FLASH_RADIUS * TILE_SIZE);
    flash.position.y = 0.02;
    group.add(flash);

    return { group, flames, smoke, sparks, flash, flashMaterial };
  }

  function dispose(): void {
    clear();
    scene.remove(root);
  }

  return { update, dispose };
}

function ensureSharedResources(): void {
  if (!sharedFlameGeometry) {
    sharedFlameGeometry = buildFlameGeometry();
  }
  if (!sharedSmokeTexture) {
    sharedSmokeTexture = buildSmokeTexture();
  }
  if (!sharedFlashGeometry) {
    sharedFlashGeometry = new THREE.CircleGeometry(1, 24);
    sharedFlashGeometry.rotateX(-Math.PI / 2);
  }
}

function buildFlameGeometry(): THREE.LatheGeometry {
  // Teardrop profile: ~0.6 width at base, peaks at 1.0 around 20% up,
  // then tapers to a wisp. Sampled at 12 points and revolved 12 times.
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= FLAME_PROFILE_SEGMENTS; i++) {
    const t = i / FLAME_PROFILE_SEGMENTS;
    let r: number;
    if (t < 0.2) {
      r = 0.6 + (t / 0.2) * 0.4;
    } else if (t < 0.55) {
      r = 1.0 - ((t - 0.2) / 0.35) * 0.25;
    } else {
      const tipT = (t - 0.55) / 0.45;
      r = 0.75 * (1 - tipT) ** 1.7;
    }
    points.push(new THREE.Vector2(r, t));
  }
  return new THREE.LatheGeometry(points, 12);
}

function buildSmokeTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = SMOKE_TEXTURE_SIZE;
  canvas.height = SMOKE_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("wall-burns: 2D context unavailable for smoke");
  const center = SMOKE_TEXTURE_SIZE / 2;
  const grad = ctx.createRadialGradient(center, center, 0, center, center, 60);
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SMOKE_TEXTURE_SIZE, SMOKE_TEXTURE_SIZE);
  // Three offset blobs added with `lighter` to break the perfect circle.
  ctx.globalCompositeOperation = "lighter";
  const blobs: Array<readonly [number, number, number]> = [
    [40, 50, 30],
    [85, 70, 35],
    [60, 85, 28],
  ];
  for (const [px, py, r] of blobs) {
    const blob = ctx.createRadialGradient(px, py, 0, px, py, r);
    blob.addColorStop(0, "rgba(255,255,255,0.4)");
    blob.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, SMOKE_TEXTURE_SIZE, SMOKE_TEXTURE_SIZE);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function buildFlames(group: THREE.Group, seed: number): FlameMesh[] {
  const flames: FlameMesh[] = [];
  for (let cluster = 0; cluster < CLUSTER_COUNT; cluster++) {
    const angle =
      (cluster / CLUSTER_COUNT) * Math.PI * 2 +
      pseudoRandom(seed, cluster, 11) * 0.8;
    const dist =
      (0.15 + pseudoRandom(seed, cluster, 13) * 0.35) * (TILE_SIZE / 2);
    const offsetX = Math.cos(angle) * dist;
    const offsetZ = Math.sin(angle) * dist;
    const heightMul = 0.7 + pseudoRandom(seed, cluster, 17) * 0.5;
    const widthMul = 0.7 + pseudoRandom(seed, cluster, 19) * 0.4;
    const phaseBase = pseudoRandom(seed, cluster, 23) * Math.PI * 2;
    for (const layer of FLAME_LAYERS) {
      const radius = layer.rRatio * (TILE_SIZE / 2) * widthMul;
      const height = FLAME_HEIGHT * layer.hMul * heightMul;
      const material = new THREE.MeshStandardMaterial({
        color: layer.color,
        emissive: layer.emissive,
        emissiveIntensity: layer.emissiveIntensity,
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(sharedFlameGeometry, material);
      // Lathe profile is authored at radius=1 base and y=0..1, so scale
      // by (radius, height, radius) to reach the desired flame size.
      mesh.scale.set(radius, height, radius);
      mesh.position.set(offsetX, 0, offsetZ);
      mesh.rotation.y = pseudoRandom(seed, cluster, 29) * Math.PI * 2;
      group.add(mesh);
      flames.push({
        mesh,
        material,
        baseRadius: radius,
        baseHeight: height,
        baseEmissive: layer.emissiveIntensity,
        phase: phaseBase + layer.phaseOff,
      });
    }
  }
  return flames;
}

function buildSmoke(group: THREE.Group, seed: number): SmokePuff[] {
  const puffs: SmokePuff[] = [];
  for (let i = 0; i < SMOKE_PUFF_COUNT; i++) {
    const material = new THREE.SpriteMaterial({
      color: SMOKE_COLOR,
      map: sharedSmokeTexture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const jitterX = (pseudoRandom(seed, i, 31) - 0.5) * TILE_SIZE * 0.3;
    const jitterZ = (pseudoRandom(seed, i, 37) - 0.5) * TILE_SIZE * 0.3;
    sprite.position.set(jitterX, FLAME_HEIGHT * 0.4, jitterZ);
    const stretchX = 0.8 + pseudoRandom(seed, i, 41) * 0.5;
    const stretchY = 0.8 + pseudoRandom(seed, i, 43) * 0.5;
    const rot = pseudoRandom(seed, i, 47) * Math.PI * 2;
    group.add(sprite);
    puffs.push({
      sprite,
      material,
      delay: i * 0.08,
      riseSpeed: (SMOKE_RISE_BASE + i * SMOKE_RISE_STEP) * TILE_SIZE,
      baseScale: 0.6 + i * 0.1,
      stretchX,
      stretchY,
      rot,
    });
  }
  return puffs;
}

function buildSparks(group: THREE.Group, seed: number): SparkMesh[] {
  const sparks: SparkMesh[] = [];
  for (let i = 0; i < SPARK_COUNT; i++) {
    const angle =
      (i / SPARK_COUNT) * Math.PI * 2 + (pseudoRandom(seed, i, 53) - 0.5) * 0.4;
    const horiz =
      (SPARK_HORIZ_MIN + pseudoRandom(seed, i, 59) * SPARK_HORIZ_RANGE) *
      TILE_SIZE;
    const vert =
      (SPARK_VERT_MIN + pseudoRandom(seed, i, 61) * SPARK_VERT_RANGE) *
      TILE_SIZE;
    const material = new THREE.SpriteMaterial({
      color: SPARK_COLOR,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const size =
      (SPARK_SIZE_MIN + pseudoRandom(seed, i, 67) * SPARK_SIZE_RANGE) *
      TILE_SIZE;
    sprite.scale.set(size, size, 1);
    sprite.position.set(0, FLAME_HEIGHT * 0.3, 0);
    group.add(sprite);
    sparks.push({
      sprite,
      material,
      velocityX: Math.cos(angle) * horiz,
      velocityY: vert,
      velocityZ: Math.sin(angle) * horiz,
    });
  }
  return sparks;
}

function animateHost(host: BurnHost, burn: WallBurn): void {
  const t = burn.age / WALL_BURN_DURATION;
  if (t >= 1) {
    host.group.visible = false;
    return;
  }
  host.group.visible = true;

  // Flame envelope: rise 0..0.15, hold 0.15..0.6, fall 0.6..1
  let envelope: number;
  if (t < 0.15) envelope = t / 0.15;
  else if (t < 0.6) envelope = 1;
  else envelope = 1 - (t - 0.6) / 0.4;

  const tSec = burn.age;
  for (const flame of host.flames) {
    const wob =
      Math.sin(tSec * 22 + flame.phase) * 0.5 +
      Math.sin(tSec * 37 + flame.phase * 2) * 0.5;
    const yScale = Math.max(0.05, envelope * (1 + wob * CRACKLE));
    const xzWob = 1 + wob * CRACKLE * 0.3;
    flame.mesh.scale.set(
      flame.baseRadius * xzWob,
      flame.baseHeight * yScale,
      flame.baseRadius * xzWob,
    );
    flame.material.opacity = envelope;
    flame.material.emissiveIntensity =
      flame.baseEmissive * (0.85 + wob * CRACKLE * 0.6);
  }

  for (const puff of host.smoke) {
    const localT = (t - puff.delay) / Math.max(0.01, 1 - puff.delay);
    if (localT <= 0) {
      puff.material.opacity = 0;
      continue;
    }
    // Rise driven by elapsed seconds for this puff (don't double-apply
    // dt — the burn ages once globally, so derive rise from age * speed).
    const puffAge = Math.max(0, burn.age - puff.delay * WALL_BURN_DURATION);
    puff.sprite.position.y = FLAME_HEIGHT * 0.4 + puff.riseSpeed * puffAge;
    const scale = puff.baseScale + localT * 1.3;
    const baseSize = SMOKE_BASE_RADIUS * TILE_SIZE * 2;
    puff.sprite.scale.set(
      baseSize * scale * puff.stretchX,
      baseSize * scale * puff.stretchY,
      1,
    );
    puff.material.rotation = puff.rot + localT * 0.4;
    let alpha: number;
    if (localT < 0.2) alpha = localT / 0.2;
    else if (localT > 0.6) alpha = Math.max(0, 1 - (localT - 0.6) / 0.4);
    else alpha = 1;
    puff.material.opacity = alpha * 0.85;
  }

  for (const spark of host.sparks) {
    const sparkAge = burn.age;
    const posX = spark.velocityX * sparkAge;
    let posY =
      FLAME_HEIGHT * 0.3 +
      spark.velocityY * sparkAge -
      0.5 * SPARK_GRAVITY * TILE_SIZE * sparkAge * sparkAge;
    const posZ = spark.velocityZ * sparkAge;
    if (posY < 1) posY = 1;
    spark.sprite.position.set(posX, posY, posZ);
    spark.material.opacity = Math.max(0, 1 - t);
  }

  if (t < FLASH_DURATION) {
    const flashT = t / FLASH_DURATION;
    host.flashMaterial.opacity = 1 - flashT;
    host.flash.scale.setScalar(FLASH_RADIUS * TILE_SIZE * (1 + flashT * 0.6));
    host.flash.visible = true;
  } else {
    host.flash.visible = false;
  }
}

// Cheap deterministic hash → [0, 1). Mixing tile seed with a per-element
// index and a small co-prime salt gives independent values across all
// uses. Avoids per-burn random state — every wall always animates the
// same way given the same (row, col).
function pseudoRandom(seed: number, index: number, salt: number): number {
  const mixed =
    Math.sin(seed * 12.9898 + index * 78.233 + salt * 31.41) * 43758.5453;
  return mixed - Math.floor(mixed);
}
