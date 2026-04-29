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

/** A single flame's per-instance state, decoupled from any specific
 *  Mesh. The owning `FireBurstHost` collects descriptors at build time;
 *  per frame, `animateFireBurst` composes `host worldPos × local
 *  transform × scale animation` and appends one entry per flame to the
 *  manager-shared `FlamePool`. No `THREE.Mesh` is created per flame —
 *  every flame across every active host on a manager renders in a
 *  single instanced draw. */
export interface FlameDescriptor {
  /** Local offset within the host group's frame. */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  /** Authored Y rotation per flame (was `mesh.rotation.y`). */
  rotationY: number;
  baseRadius: number;
  baseHeight: number;
  /** Pre-baked color = layer.emissive × layer.emissiveIntensity. The
   *  per-frame crackle scalar is applied as a fresh `Color × wob` write
   *  into the pool's per-instance color slot. */
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
  /** Flames live in the manager's shared `FlamePool` — only descriptors
   *  are stored here. */
  flames: FlameDescriptor[];
  smoke: SmokePuff[];
  sparks: SparkMesh[];
  /** Flash discs live in the manager's shared `FlashPool`; the host
   *  contributes one per frame while `t < FLASH_DURATION`. */
  flashBaseRadius: number;
}

/** Per-manager pool for flame instances. One `THREE.InstancedMesh` shared
 *  across every active host on the same manager — `animateFireBurst`
 *  appends one entry per flame each frame, advancing a cursor reset by
 *  `beginFrame()`. Per-instance color carries the (baseColor × crackle)
 *  product; per-instance opacity is plumbed through an `instanceOpacity`
 *  attribute via a small `onBeforeCompile` patch on `MeshBasicMaterial`
 *  (alpha is multiplied at fragment-output time). */
interface FlamePool {
  /** Owned by the caller — added under the manager's root group; freed
   *  on `dispose()`. */
  mesh: THREE.InstancedMesh;
  beginFrame(): void;
  /** Append one flame's transform + color + opacity to the next free
   *  instance slot. No-ops when the pool is at capacity (extra flames
   *  on rare overflow frames silently drop — capacity is sized for the
   *  realistic peak in `MAX_FLAMES`). */
  append(matrix: THREE.Matrix4, color: THREE.Color, opacity: number): void;
  commitFrame(): void;
  dispose(): void;
}

/** Per-manager pool for flash-disc instances. Same instancing pattern as
 *  the flame pool — shared `CircleGeometry`, per-instance matrix +
 *  opacity (color is uniform via the material). The flash is the brief
 *  bright burst at the start of each fire-burst (`t < FLASH_DURATION`). */
interface FlashPool {
  mesh: THREE.InstancedMesh;
  beginFrame(): void;
  append(matrix: THREE.Matrix4, opacity: number): void;
  commitFrame(): void;
  dispose(): void;
}

/** Bundle of every per-manager instanced pool used by the fire-burst
 *  pipeline. Each manager owns one bundle; `animateFireBurst` appends
 *  to whichever pools the host needs this frame. */
interface BurstPools {
  flame: FlamePool;
  flash: FlashPool;
  beginFrame(): void;
  commitFrame(): void;
  dispose(): void;
}

const SMOKE_COLOR = 0x303036;
const SPARK_COLOR = 0xffd066;
const FLASH_COLOR = 0xffffcc;
const CRACKLE = 0.35;
const SPARK_GRAVITY = 15;
const FLASH_DURATION = 0.12;
const FLAME_PROFILE_SEGMENTS = 12;
const SMOKE_TEXTURE_SIZE = 128;
/** Per-pool hard cap on simultaneous flame instances. Sized for the
 *  worst-case battle peak (e.g. 15 simultaneous bursts × ~9 flames
 *  each ≈ 135) with headroom; overflow flames silently drop, which
 *  the eye never notices in a frame this dense. */
const MAX_FLAMES = 256;
/** Flash discs are 1 per host and only fire during the first 12% of
 *  the burst's life — practical max is ~10 simultaneous. 32 covers it. */
const MAX_FLASHES = 32;
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
const FLAME_Y_AXIS = new THREE.Vector3(0, 1, 0);
const flameScratchMatrix = new THREE.Matrix4();
const flameScratchPos = new THREE.Vector3();
const flameScratchQuat = new THREE.Quaternion();
const flameScratchScale = new THREE.Vector3();
const flameScratchColor = new THREE.Color();
const flashScratchMatrix = new THREE.Matrix4();
const flashScratchPos = new THREE.Vector3();
const flashScratchScale = new THREE.Vector3();
const flashScratchIdentityQuat = new THREE.Quaternion();

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

  const pools = createBurstPools(root);

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
      animateFireBurst(pools, host, entry.age, params.duration),
  });

  return {
    update(ctx) {
      pools.beginFrame();
      reconciler.update(params.selectEntries(ctx) ?? []);
      pools.commitFrame();
    },
    dispose() {
      reconciler.disposeAll();
      pools.dispose();
      scene.remove(root);
    },
  };
}

/** Build the full bundle of per-manager pools the fire-burst pipeline
 *  uses. Each manager calls this once at init, then `pools.beginFrame()`
 *  / `pools.commitFrame()` brackets the per-frame reconciler.update,
 *  and `pools.dispose()` tears everything down. */
export function createBurstPools(parent: THREE.Group): BurstPools {
  const flame = createFlamePool(parent);
  const flash = createFlashPool(parent);
  return {
    flame,
    flash,
    beginFrame() {
      flame.beginFrame();
      flash.beginFrame();
    },
    commitFrame() {
      flame.commitFrame();
      flash.commitFrame();
    },
    dispose() {
      flame.dispose();
      flash.dispose();
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

  const flames = buildFlames(seed, config);
  const smoke = buildSmoke(group, seed, config);
  const sparks = buildSparks(group, seed, config);

  return {
    group,
    flames,
    smoke,
    sparks,
    flashBaseRadius: config.flashBaseRadius,
  };
}

/** Tear down a host's per-host resources and remove it from its parent.
 *  Flames + flash have no per-host resources — they live in the
 *  manager-shared pools and stop rendering as soon as the host is
 *  dropped from the reconciler's entry list (no animate call → no
 *  append → instance slot reused next frame). */
export function disposeFireBurstHost(
  parent: THREE.Group,
  host: FireBurstHost,
): void {
  for (const puff of host.smoke) puff.material.dispose();
  for (const spark of host.sparks) spark.material.dispose();
  parent.remove(host.group);
}

/** Per-frame update. `age` is seconds since birth; `duration` is the
 *  burst's nominal life. Sets group visibility, animates each
 *  primitive, and updates the flash envelope. Flames + flash are
 *  appended to the manager-shared `pools` — every flame and flash
 *  across every active host on the same manager renders in two
 *  instanced draws (one per primitive type) at `pools.commitFrame()`
 *  time. Smoke + sparks remain per-host (Phase 2b). */
export function animateFireBurst(
  pools: BurstPools,
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
  animateFlames(
    pools.flame,
    host.flames,
    host.group.position.x,
    host.group.position.y,
    host.group.position.z,
    age,
    envelope,
  );
  animateSmoke(host.smoke, age, t, duration);
  animateSparks(host.sparks, age, t);

  if (t < FLASH_DURATION) {
    const flashT = t / FLASH_DURATION;
    const flashOpacity = 1 - flashT;
    const flashScale = host.flashBaseRadius * (1 + flashT * 0.6);
    flashScratchPos.set(
      host.group.position.x,
      host.group.position.y + 0.02,
      host.group.position.z,
    );
    flashScratchScale.set(flashScale, flashScale, flashScale);
    flashScratchMatrix.compose(
      flashScratchPos,
      flashScratchIdentityQuat,
      flashScratchScale,
    );
    pools.flash.append(flashScratchMatrix, flashOpacity);
  }
}

/** Build a manager-shared flash pool. Same instancing shape as
 *  `createFlamePool`, but uses the shared circle geometry, no
 *  per-instance color (flash is uniformly bright cream), and a smaller
 *  capacity (one flash per host, brief lifetime). */
function createFlashPool(
  parent: THREE.Group,
  capacity: number = MAX_FLASHES,
): FlashPool {
  ensureFireBurstResources();
  const geometry = sharedFlashGeometry!.clone();
  const opacityArray = new Float32Array(capacity);
  const opacityAttribute = new THREE.InstancedBufferAttribute(opacityArray, 1);
  opacityAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("instanceOpacity", opacityAttribute);

  const material = new THREE.MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  material.onBeforeCompile = patchFlameInstanceOpacity;

  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = "flashes";
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  parent.add(mesh);

  let cursor = 0;

  return {
    mesh,
    beginFrame() {
      cursor = 0;
    },
    append(matrix, opacity) {
      if (cursor >= capacity) return;
      mesh.setMatrixAt(cursor, matrix);
      opacityArray[cursor] = opacity;
      cursor++;
    },
    commitFrame() {
      mesh.count = cursor;
      mesh.instanceMatrix.needsUpdate = true;
      opacityAttribute.needsUpdate = true;
    },
    dispose() {
      parent.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Build a manager-shared flame pool. The pool's `InstancedMesh` is
 *  parented under `parent` (typically the manager's root group) and
 *  cleared on `dispose()`. The shared lathe geometry is cloned so the
 *  pool can attach its own `instanceOpacity` attribute without mutating
 *  the global. The fragment shader is patched to multiply final alpha
 *  by `instanceOpacity` — three.js doesn't expose per-instance opacity
 *  natively, so we plumb it through `onBeforeCompile` injection points
 *  (`<common>` for the varying, `<alphamap_fragment>` for the multiply
 *  — runs after `alphamap` so an alpha map combined with our opacity
 *  multiplies correctly even though flames don't currently use one). */
function createFlamePool(
  parent: THREE.Group,
  capacity: number = MAX_FLAMES,
): FlamePool {
  ensureFireBurstResources();
  const geometry = sharedFlameGeometry!.clone();
  const opacityArray = new Float32Array(capacity);
  const opacityAttribute = new THREE.InstancedBufferAttribute(opacityArray, 1);
  opacityAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("instanceOpacity", opacityAttribute);

  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  material.onBeforeCompile = patchFlameInstanceOpacity;

  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = "flames";
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Pre-allocate instanceColor with DynamicDrawUsage so per-frame
  // setColorAt writes don't trigger reallocation.
  const colorArray = new Float32Array(capacity * 3);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(colorArray, 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  // Bursts can be anywhere on the map; cheaper to render-then-cull than
  // walk the (already small) instance bounds per frame.
  mesh.frustumCulled = false;
  parent.add(mesh);

  let cursor = 0;

  return {
    mesh,
    beginFrame() {
      cursor = 0;
    },
    append(matrix, color, opacity) {
      if (cursor >= capacity) return;
      mesh.setMatrixAt(cursor, matrix);
      mesh.setColorAt(cursor, color);
      opacityArray[cursor] = opacity;
      cursor++;
    },
    commitFrame() {
      mesh.count = cursor;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      opacityAttribute.needsUpdate = true;
    },
    dispose() {
      parent.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Module-level shader patcher shared across every pool. Three.js's
 *  program cache keys on the patcher's function identity — defining it
 *  inline per pool would compile a new program per pool. */
function patchFlameInstanceOpacity(
  shader: THREE.WebGLProgramParametersWithUniforms,
): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\nattribute float instanceOpacity;\nvarying float vInstanceOpacity;",
    )
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvInstanceOpacity = instanceOpacity;",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      "#include <common>\nvarying float vInstanceOpacity;",
    )
    .replace(
      "#include <alphamap_fragment>",
      "#include <alphamap_fragment>\ndiffuseColor.a *= vInstanceOpacity;",
    );
}

function ensureFireBurstResources(): void {
  if (!sharedFlameGeometry) sharedFlameGeometry = buildFlameGeometry();
  if (!sharedSmokeTexture) sharedSmokeTexture = buildSmokeTexture();
  if (!sharedFlashGeometry) {
    sharedFlashGeometry = new THREE.CircleGeometry(1, 24);
    sharedFlashGeometry.rotateX(-Math.PI / 2);
  }
}

function buildFlames(seed: number, config: FireBurstConfig): FlameDescriptor[] {
  const flames: FlameDescriptor[] = [];
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
    const rotationY = pseudoRandom(seed, cluster, 29) * Math.PI * 2;
    for (const layer of config.flameLayers) {
      const radius = layer.rRatio * config.halfSize * widthMul;
      const height = config.flameHeight * layer.hMul * heightMul;
      // Bake `emissive × emissiveIntensity` into a single color; per-frame
      // crackle is applied by the pool's animate path. WebGL clamps on
      // output so values >1 saturate toward white.
      const baseColor = new THREE.Color(layer.emissive).multiplyScalar(
        layer.emissiveIntensity,
      );
      flames.push({
        offsetX,
        offsetY: config.flameOriginY,
        offsetZ,
        rotationY,
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

/** Compose host-world × flame-local × scale into the pool's next free
 *  instance slot. Per-flame state (offsets, rotation, baseColor, phase)
 *  lives on the descriptor; the per-frame envelope drives Y-scale +
 *  opacity, the wob drives the brightness flicker that used to live on
 *  `material.emissiveIntensity`. */
function animateFlames(
  pool: FlamePool,
  flames: readonly FlameDescriptor[],
  hostX: number,
  hostY: number,
  hostZ: number,
  age: number,
  envelope: number,
): void {
  for (const flame of flames) {
    const wob =
      Math.sin(age * 22 + flame.phase) * 0.5 +
      Math.sin(age * 37 + flame.phase * 2) * 0.5;
    const yScale = Math.max(0.05, envelope * (1 + wob * CRACKLE));
    const xzWob = 1 + wob * CRACKLE * 0.3;
    flameScratchPos.set(
      hostX + flame.offsetX,
      hostY + flame.offsetY,
      hostZ + flame.offsetZ,
    );
    flameScratchQuat.setFromAxisAngle(FLAME_Y_AXIS, flame.rotationY);
    flameScratchScale.set(
      flame.baseRadius * xzWob,
      flame.baseHeight * yScale,
      flame.baseRadius * xzWob,
    );
    flameScratchMatrix.compose(
      flameScratchPos,
      flameScratchQuat,
      flameScratchScale,
    );
    flameScratchColor
      .copy(flame.baseColor)
      .multiplyScalar(0.85 + wob * CRACKLE * 0.6);
    pool.append(flameScratchMatrix, flameScratchColor, envelope);
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
