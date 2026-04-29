/**
 * Shared fire/smoke/spark burst kernel — the primitive bundle and
 * animation math behind wall-burns and cannon-burns.
 *
 * Each burst is a small scene-graph bundle:
 *   - N flame clusters (3-layer teardrop LatheGeometry). Crackle driven
 *     by compound sin jitter on Y-scale + emissive intensity.
 *   - M stacked camera-facing smoke puffs (radial-gradient texture).
 *     Rise + expand + fade in the back half of life.
 *   - K spark billboards on a true ballistic arc (units/sec velocities,
 *     gravity in units/sec²). Settle on the ground as they age.
 *   - 1 brief flash disc in the first ~12% of life.
 *
 * Per-burst variation (cluster offsets, flame sizes, spark angles,
 * smoke jitter) is seeded deterministically from the caller's `seed`
 * (typically `tileSeed(row, col)`). No per-burst random state lives on
 * the caller's payload — the same `seed` always animates identically.
 *
 * Shared lathe geometry, smoke texture, and flash disc geometry are
 * created once per renderer instance (via `ensureFireBurstResources`)
 * and reused across every host + every caller. Per-host materials are
 * owned by each host — dispose them when the host is removed.
 */

import * as THREE from "three";
import type { TilePos } from "../../../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../../../shared/core/grid.ts";
import { ELEVATION_STACK } from "../elevation.ts";
import type { FrameCtx } from "../frame-ctx.ts";
import { tileSeed } from "./helpers.ts";
import { createReconciler } from "./reconciler.ts";

/** Common shape every per-frame effect manager exposes — used by
 *  wall-burns, cannon-burns, and friends. */
export interface EffectManager {
  update(ctx: FrameCtx): void;
  dispose(): void;
}

export interface FlameLayer {
  readonly color: number;
  readonly emissive: number;
  readonly emissiveIntensity: number;
  readonly rRatio: number;
  readonly hMul: number;
  readonly phaseOff: number;
}

export interface FireBurstConfig {
  readonly clusterCount: number;
  readonly sparkCount: number;
  readonly smokePuffCount: number;
  /** Half-width of the effect footprint (world units). Drives flame
   *  cluster spread and layer radii. TILE_SIZE/2 for 1-tile effects;
   *  (N × TILE_SIZE) / 2 for NxN footprints. */
  readonly halfSize: number;
  /** Nominal flame height (world units). */
  readonly flameHeight: number;
  /** Initial flash disc radius (world units). */
  readonly flashBaseRadius: number;
  /** Y offset where flames plant their base above the group origin. */
  readonly flameOriginY: number;
  /** Sparks spawn on a ring of this radius around the origin
   *  (world units). 0 collapses the spawn to the centre point. */
  readonly sparkSpawnRadius: number;
  /** Half-width of the horizontal jitter applied to smoke puff spawn
   *  positions (world units). */
  readonly smokeJitter: number;
  /** Cluster positions fan out up to `halfSize * clusterSpread` from
   *  the origin. 1.0 keeps them inside the footprint; >1 lets them
   *  spill over the edges. */
  readonly clusterSpread: number;
  /** Cluster offset = halfSize · clusterSpread · (offsetBase + rand · offsetRange). */
  readonly clusterOffsetBase: number;
  readonly clusterOffsetRange: number;
  /** Flame width jitter range: base + rand·range. */
  readonly flameWidthMulBase: number;
  readonly flameWidthMulRange: number;
  /** Flame height jitter range: base + rand·range. */
  readonly flameHeightMulBase: number;
  readonly flameHeightMulRange: number;
  /** Spark horizontal velocity, tile units/sec. velocity = (min + rand·range) · TILE_SIZE. */
  readonly sparkHorizMin: number;
  readonly sparkHorizRange: number;
  /** Spark vertical velocity, tile units/sec. */
  readonly sparkVertMin: number;
  readonly sparkVertRange: number;
  /** Spark billboard size, tile units. size = (min + rand·range) · TILE_SIZE. */
  readonly sparkSizeMin: number;
  readonly sparkSizeRange: number;
  /** Smoke base radius (tiles) — actual puff size = baseRadius · TILE_SIZE · 2 · scale. */
  readonly smokeBaseRadius: number;
  /** Smoke rise speed, tile units/sec. speed = (base + puffIdx · step) · TILE_SIZE. */
  readonly smokeRiseBase: number;
  readonly smokeRiseStep: number;
  /** Per-puff staggered start delay (fraction of life). */
  readonly smokePuffDelay: number;
  /** Smoke initial scale (before growth) = base + puffIdx · 0.1. */
  readonly smokeBaseScaleStart: number;
  /** Smoke scale grows by this amount across the puff's visible window. */
  readonly smokeScaleGrowth: number;
  /** Flame palette — three layers (core, body, tuft) are expected. */
  readonly flameLayers: readonly FlameLayer[];
}

export interface FlameMesh {
  mesh: THREE.Mesh;
  /** Unlit basic material — flames are emissive bright surfaces and
   *  PBR's lighting math contributes nothing visible. Per-frame brightness
   *  flicker (was `emissiveIntensity` modulation) is now applied as a
   *  scalar multiply on the cached `baseColor`. */
  material: THREE.MeshBasicMaterial;
  baseRadius: number;
  baseHeight: number;
  /** Pre-baked color = layer.emissive × layer.emissiveIntensity, clamped
   *  in shader. Reused per frame as `material.color = baseColor × wob`. */
  baseColor: THREE.Color;
  phase: number;
}

export interface SmokePuff {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  delay: number;
  riseSpeed: number;
  baseScale: number;
  stretchX: number;
  stretchY: number;
  rot: number;
  originY: number;
  baseSize: number;
  scaleGrowth: number;
}

export interface SparkMesh {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  originY: number;
}

export interface FireBurstHost {
  group: THREE.Group;
  flames: FlameMesh[];
  smoke: SmokePuff[];
  sparks: SparkMesh[];
  flash: THREE.Mesh;
  flashMaterial: THREE.MeshBasicMaterial;
  flashBaseRadius: number;
}

const SMOKE_COLOR = 0x303036;
const SPARK_COLOR = 0xffd066;
const FLASH_COLOR = 0xffffcc;
const CRACKLE = 0.35;
const SPARK_GRAVITY = 15;
const FLASH_DURATION = 0.12;
const FLAME_PROFILE_SEGMENTS = 12;
const SMOKE_TEXTURE_SIZE = 128;
/** Default flame palette. Callers typically reuse this verbatim; the
 *  emissive intensities are scaled by a single multiplier through
 *  `makeFlameLayers` rather than authored per-caller. */
const DEFAULT_FLAME_LAYERS: readonly FlameLayer[] = [
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

let sharedFlameGeometry: THREE.LatheGeometry | undefined;
let sharedSmokeTexture: THREE.CanvasTexture | undefined;
let sharedFlashGeometry: THREE.CircleGeometry | undefined;

/** Factory for the 1×1 burst manager pattern. Reconciles the selected
 *  entries into per-tile fire-burst hosts, ages them via each entry's
 *  `.age` field, and disposes via `disposeFireBurstHost`. Per-burst
 *  variation derives deterministically from `tileSeed(row, col)`. */
export function createTileBurstManager<T extends TilePos & { age: number }>(
  scene: THREE.Scene,
  params: {
    name: string;
    config: FireBurstConfig;
    duration: number;
    /** Pull the current entries from the frame context's overlay.
     *  Returns `undefined` when battle isn't live — treated as empty. */
    selectEntries: (ctx: FrameCtx) => readonly T[] | undefined;
  },
): EffectManager {
  const root = new THREE.Group();
  root.name = params.name;
  scene.add(root);

  const reconciler = createReconciler<T, FireBurstHost>({
    build: (entry) =>
      createFireBurstHost(
        root,
        entry.col * TILE_SIZE + TILE_SIZE / 2,
        ELEVATION_STACK.WALL_BURNS,
        entry.row * TILE_SIZE + TILE_SIZE / 2,
        tileSeed(entry.row, entry.col),
        params.config,
      ),
    dispose: (host) => disposeFireBurstHost(root, host),
    animate: (host, entry) =>
      animateFireBurst(host, entry.age, params.duration),
  });

  return {
    update(ctx) {
      reconciler.update(params.selectEntries(ctx) ?? []);
    },
    dispose() {
      reconciler.disposeAll();
      scene.remove(root);
    },
  };
}

/** Produce a flame-layer palette that scales the default emissive
 *  intensities by a single multiplier. Cannon-burn wants ~1.15× the
 *  wall-burn glow; wall-burn passes 1.0. */
export function makeFlameLayers(
  emissiveMultiplier: number,
): readonly FlameLayer[] {
  return DEFAULT_FLAME_LAYERS.map((layer) => ({
    ...layer,
    emissiveIntensity: layer.emissiveIntensity * emissiveMultiplier,
  }));
}

/** Build a fire-burst host anchored at `(worldX, worldY, worldZ)`. The
 *  caller owns `parent` — this function adds the host group to it and
 *  returns handles for later animation / disposal. */
export function createFireBurstHost(
  parent: THREE.Group,
  worldX: number,
  worldY: number,
  worldZ: number,
  seed: number,
  config: FireBurstConfig,
): FireBurstHost {
  ensureFireBurstResources();
  const group = new THREE.Group();
  group.position.set(worldX, worldY, worldZ);
  parent.add(group);

  const flames = buildFlames(group, seed, config);
  const smoke = buildSmoke(group, seed, config);
  const sparks = buildSparks(group, seed, config);
  const flashMaterial = new THREE.MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const flash = new THREE.Mesh(sharedFlashGeometry, flashMaterial);
  flash.scale.setScalar(config.flashBaseRadius);
  flash.position.y = 0.02;
  group.add(flash);

  return {
    group,
    flames,
    smoke,
    sparks,
    flash,
    flashMaterial,
    flashBaseRadius: config.flashBaseRadius,
  };
}

/** Tear down a host's per-host resources and remove it from its parent. */
export function disposeFireBurstHost(
  parent: THREE.Group,
  host: FireBurstHost,
): void {
  for (const flame of host.flames) flame.material.dispose();
  for (const puff of host.smoke) puff.material.dispose();
  for (const spark of host.sparks) spark.material.dispose();
  host.flashMaterial.dispose();
  parent.remove(host.group);
}

/** Per-frame update. `age` is seconds since birth; `duration` is the
 *  burst's nominal life. Sets group visibility, animates each
 *  primitive, and updates the flash envelope. */
export function animateFireBurst(
  host: FireBurstHost,
  age: number,
  duration: number,
): void {
  const t = age / duration;
  if (t >= 1) {
    host.group.visible = false;
    return;
  }
  host.group.visible = true;

  const envelope = computeEnvelope(t);
  animateFlames(host.flames, age, envelope);
  animateSmoke(host.smoke, age, t, duration);
  animateSparks(host.sparks, age, t);

  if (t < FLASH_DURATION) {
    const flashT = t / FLASH_DURATION;
    host.flashMaterial.opacity = 1 - flashT;
    host.flash.scale.setScalar(host.flashBaseRadius * (1 + flashT * 0.6));
    host.flash.visible = true;
  } else {
    host.flash.visible = false;
  }
}

function ensureFireBurstResources(): void {
  if (!sharedFlameGeometry) sharedFlameGeometry = buildFlameGeometry();
  if (!sharedSmokeTexture) sharedSmokeTexture = buildSmokeTexture();
  if (!sharedFlashGeometry) {
    sharedFlashGeometry = new THREE.CircleGeometry(1, 24);
    sharedFlashGeometry.rotateX(-Math.PI / 2);
  }
}

function buildFlames(
  group: THREE.Group,
  seed: number,
  config: FireBurstConfig,
): FlameMesh[] {
  const flames: FlameMesh[] = [];
  const clusterMaxDist = config.halfSize * config.clusterSpread;
  for (let cluster = 0; cluster < config.clusterCount; cluster++) {
    const angle =
      (cluster / config.clusterCount) * Math.PI * 2 +
      pseudoRandom(seed, cluster, 11) * 0.8;
    const dist =
      (config.clusterOffsetBase +
        pseudoRandom(seed, cluster, 13) * config.clusterOffsetRange) *
      clusterMaxDist;
    const offsetX = Math.cos(angle) * dist;
    const offsetZ = Math.sin(angle) * dist;
    const heightMul =
      config.flameHeightMulBase +
      pseudoRandom(seed, cluster, 17) * config.flameHeightMulRange;
    const widthMul =
      config.flameWidthMulBase +
      pseudoRandom(seed, cluster, 19) * config.flameWidthMulRange;
    const phaseBase = pseudoRandom(seed, cluster, 23) * Math.PI * 2;
    for (const layer of config.flameLayers) {
      const radius = layer.rRatio * config.halfSize * widthMul;
      const height = config.flameHeight * layer.hMul * heightMul;
      // Bake `emissive × emissiveIntensity` into a single color. The
      // shader will clamp on output, so values >1 are fine for the
      // brightest flame layers.
      const baseColor = new THREE.Color(layer.emissive).multiplyScalar(
        layer.emissiveIntensity,
      );
      const material = new THREE.MeshBasicMaterial({
        color: baseColor.clone(),
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(sharedFlameGeometry, material);
      mesh.scale.set(radius, height, radius);
      mesh.position.set(offsetX, config.flameOriginY, offsetZ);
      mesh.rotation.y = pseudoRandom(seed, cluster, 29) * Math.PI * 2;
      group.add(mesh);
      flames.push({
        mesh,
        material,
        baseRadius: radius,
        baseHeight: height,
        baseColor,
        phase: phaseBase + layer.phaseOff,
      });
    }
  }
  return flames;
}

function buildSmoke(
  group: THREE.Group,
  seed: number,
  config: FireBurstConfig,
): SmokePuff[] {
  const puffs: SmokePuff[] = [];
  const originY = config.flameOriginY + config.flameHeight * 0.4;
  for (let i = 0; i < config.smokePuffCount; i++) {
    const material = new THREE.SpriteMaterial({
      color: SMOKE_COLOR,
      map: sharedSmokeTexture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const jitterX = (pseudoRandom(seed, i, 31) - 0.5) * config.smokeJitter * 2;
    const jitterZ = (pseudoRandom(seed, i, 37) - 0.5) * config.smokeJitter * 2;
    sprite.position.set(jitterX, originY, jitterZ);
    const stretchX = 0.8 + pseudoRandom(seed, i, 41) * 0.5;
    const stretchY = 0.8 + pseudoRandom(seed, i, 43) * 0.5;
    const rot = pseudoRandom(seed, i, 47) * Math.PI * 2;
    group.add(sprite);
    puffs.push({
      sprite,
      material,
      delay: i * config.smokePuffDelay,
      riseSpeed: (config.smokeRiseBase + i * config.smokeRiseStep) * TILE_SIZE,
      baseScale: config.smokeBaseScaleStart + i * 0.1,
      stretchX,
      stretchY,
      rot,
      originY,
      baseSize: config.smokeBaseRadius * TILE_SIZE * 2,
      scaleGrowth: config.smokeScaleGrowth,
    });
  }
  return puffs;
}

function buildSparks(
  group: THREE.Group,
  seed: number,
  config: FireBurstConfig,
): SparkMesh[] {
  const sparks: SparkMesh[] = [];
  const originY = config.flameOriginY + config.flameHeight * 0.3;
  for (let i = 0; i < config.sparkCount; i++) {
    const angle =
      (i / config.sparkCount) * Math.PI * 2 +
      (pseudoRandom(seed, i, 53) - 0.5) * 0.4;
    const horiz =
      (config.sparkHorizMin +
        pseudoRandom(seed, i, 59) * config.sparkHorizRange) *
      TILE_SIZE;
    const vert =
      (config.sparkVertMin +
        pseudoRandom(seed, i, 61) * config.sparkVertRange) *
      TILE_SIZE;
    const material = new THREE.SpriteMaterial({
      color: SPARK_COLOR,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const size =
      (config.sparkSizeMin +
        pseudoRandom(seed, i, 67) * config.sparkSizeRange) *
      TILE_SIZE;
    sprite.scale.set(size, size, 1);
    // When sparkSpawnRadius > 0, sparks spawn on a small ring around
    // the origin — gives larger bursts a non-point source. Walls use 0
    // so every spark starts from the same tile centre.
    const spawnRadius =
      config.sparkSpawnRadius > 0
        ? pseudoRandom(seed, i, 71) * config.sparkSpawnRadius
        : 0;
    sprite.position.set(
      Math.cos(angle) * spawnRadius,
      originY,
      Math.sin(angle) * spawnRadius,
    );
    group.add(sprite);
    sparks.push({
      sprite,
      material,
      velocityX: Math.cos(angle) * horiz,
      velocityY: vert,
      velocityZ: Math.sin(angle) * horiz,
      originY,
    });
  }
  return sparks;
}

/** Cheap deterministic hash → [0, 1). Mixing `seed` with a per-element
 *  `index` and a small co-prime `salt` gives independent values across
 *  every use site — no hidden per-burst random state needed. */
function pseudoRandom(seed: number, index: number, salt: number): number {
  const mixed =
    Math.sin(seed * 12.9898 + index * 78.233 + salt * 31.41) * 43758.5453;
  return mixed - Math.floor(mixed);
}

function animateFlames(
  flames: readonly FlameMesh[],
  age: number,
  envelope: number,
): void {
  for (const flame of flames) {
    const wob =
      Math.sin(age * 22 + flame.phase) * 0.5 +
      Math.sin(age * 37 + flame.phase * 2) * 0.5;
    const yScale = Math.max(0.05, envelope * (1 + wob * CRACKLE));
    const xzWob = 1 + wob * CRACKLE * 0.3;
    flame.mesh.scale.set(
      flame.baseRadius * xzWob,
      flame.baseHeight * yScale,
      flame.baseRadius * xzWob,
    );
    flame.material.opacity = envelope;
    // Per-frame brightness flicker: scale the pre-baked emissive color
    // by the same crackle envelope the PBR path applied to
    // `emissiveIntensity`. WebGL clamps on output so values >1 saturate
    // toward white, mimicking the over-bright PBR look.
    flame.material.color
      .copy(flame.baseColor)
      .multiplyScalar(0.85 + wob * CRACKLE * 0.6);
  }
}

function animateSmoke(
  puffs: readonly SmokePuff[],
  age: number,
  t: number,
  duration: number,
): void {
  for (const puff of puffs) {
    const localT = (t - puff.delay) / Math.max(0.01, 1 - puff.delay);
    if (localT <= 0) {
      puff.material.opacity = 0;
      continue;
    }
    const puffAge = Math.max(0, age - puff.delay * duration);
    puff.sprite.position.y = puff.originY + puff.riseSpeed * puffAge;
    const scale = puff.baseScale + localT * puff.scaleGrowth;
    puff.sprite.scale.set(
      puff.baseSize * scale * puff.stretchX,
      puff.baseSize * scale * puff.stretchY,
      1,
    );
    puff.material.rotation = puff.rot + localT * 0.4;
    let alpha: number;
    if (localT < 0.2) alpha = localT / 0.2;
    else if (localT > 0.6) alpha = Math.max(0, 1 - (localT - 0.6) / 0.4);
    else alpha = 1;
    puff.material.opacity = alpha * 0.85;
  }
}

function animateSparks(
  sparks: readonly SparkMesh[],
  age: number,
  t: number,
): void {
  for (const spark of sparks) {
    const posX = spark.velocityX * age;
    let posY =
      spark.originY +
      spark.velocityY * age -
      0.5 * SPARK_GRAVITY * TILE_SIZE * age * age;
    const posZ = spark.velocityZ * age;
    if (posY < 1) posY = 1;
    spark.sprite.position.set(posX, posY, posZ);
    spark.material.opacity = Math.max(0, 1 - t);
  }
}

function computeEnvelope(t: number): number {
  if (t < 0.15) return t / 0.15;
  if (t < 0.6) return 1;
  return 1 - (t - 0.6) / 0.4;
}

function buildFlameGeometry(): THREE.LatheGeometry {
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
  if (!ctx) throw new Error("fire-burst: 2D context unavailable for smoke");
  const center = SMOKE_TEXTURE_SIZE / 2;
  const grad = ctx.createRadialGradient(center, center, 0, center, center, 60);
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SMOKE_TEXTURE_SIZE, SMOKE_TEXTURE_SIZE);
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
