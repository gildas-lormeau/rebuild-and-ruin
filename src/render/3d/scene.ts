/**
 * Three.js scene + camera + lights bootstrap for the 3D world renderer.
 *
 * Phase 1 of the 3D renderer migration (see docs/3d-renderer-migration.md):
 * the scene now holds an ortho camera driven by `runtime-camera.ts`'s
 * `Viewport`, a hemispheric+directional light rig, and a placeholder
 * debug ground plane so we can visually verify the camera at all zoom
 * levels. Phase 2 replaces the debug ground with the real terrain mesh
 * (the `debugGround` handle on `Render3dContext` is there so Phase 2 can
 * swap/remove it cleanly).
 *
 * Coordinate convention (see `camera.ts` header for the long version):
 *   origin at map top-left, 1 world unit = 1 game-1× pixel, Y up, camera
 *   looks -Y. `Viewport { x, y, w, h }` maps directly: `vp.x/y` is the
 *   top-left of the visible rectangle in world XZ, `vp.w/h` its size.
 *
 * Textures note for Phase 2: three.js defaults texture filtering to
 * linear, which blurs our pixel-art atlas. When Phase 2 loads textures
 * it MUST set `tex.magFilter = THREE.NearestFilter` and `tex.minFilter
 * = THREE.NearestFilter` per-texture (there is no global "nearest by
 * default" knob). The renderer here sets everything else up so Phase 2
 * only has to add geometry + textures.
 */

import * as THREE from "three";
import { createMapCamera } from "./camera.ts";
import {
  type BonusSquaresManager,
  createBonusSquaresManager,
} from "./effects/bonus-squares.ts";
import {
  type CannonBurnsManager,
  createCannonBurnsManager,
} from "./effects/cannon-burns.ts";
import {
  type CrosshairsManager,
  createCrosshairsManager,
} from "./effects/crosshairs.ts";
import { type EffectManager } from "./effects/fire-burst.ts";
import { createFogManager } from "./effects/fog.ts";
import {
  createGruntBurnsManager,
  type GruntBurnsManager,
} from "./effects/grunt-burns.ts";
import {
  createHouseBurnsManager,
  type HouseBurnsManager,
} from "./effects/house-burns.ts";
import {
  createImpactsManager,
  type ImpactsManager,
} from "./effects/impacts.ts";
import { MODIFIER_EFFECT_FACTORIES } from "./effects/modifier-effect-registry.ts";
import { type GetSinkholeOverlayBitmap } from "./effects/sinkhole-overlay.ts";
import {
  createTerrainBitmapManager,
  type GetTerrainBitmap,
  type TerrainBitmapManager,
} from "./effects/terrain-bitmap.ts";
import {
  createWallBurnsManager,
  type WallBurnsManager,
} from "./effects/wall-burns.ts";
import {
  createWaterWavesManager,
  type WaterWavesManager,
} from "./effects/water-waves.ts";
import {
  type BalloonsManager,
  createBalloonsManager,
} from "./entities/balloons.ts";
import {
  type CannonballsManager,
  createCannonballsManager,
} from "./entities/cannonballs.ts";
import {
  type CannonsManager,
  createCannonsManager,
  type GetCannonFacing,
} from "./entities/cannons.ts";
import { createDebrisManager, type DebrisManager } from "./entities/debris.ts";
import { createGruntsManager, type GruntsManager } from "./entities/grunts.ts";
import { createHousesManager, type HousesManager } from "./entities/houses.ts";
import {
  createPhantomsManager,
  type PhantomsManager,
} from "./entities/phantoms.ts";
import { createPitsManager, type PitsManager } from "./entities/pits.ts";
import {
  createTowerLabelsManager,
  type TowerLabelsManager,
} from "./entities/tower-labels.ts";
import { createTowersManager, type TowersManager } from "./entities/towers.ts";
import { createWallsManager, type WallsManager } from "./entities/walls.ts";
import { createWorldLights } from "./lights.ts";
import { createTerrain, type TerrainContext } from "./terrain.ts";

export interface Render3dContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  /** Terrain mesh holder — Phase 2's replacement for the Phase 1 debug ground.
   *  Owns the tile-grid geometry and the per-frame color update. */
  readonly terrain: TerrainContext;
  /** Wall mesh manager — Phase 3. Reconciles per-tile wall meshes with
   *  the overlay's castle wall sets. */
  readonly walls: WallsManager;
  /** Tower mesh manager — Phase 3. Reconciles 2×2 tower meshes with the
   *  map's tower list + overlay ownership. */
  readonly towers: TowersManager;
  /** Per-player name labels floating above owned home towers during
   *  battle. Mirrors the 2D `drawTowers` label pass that's skipped in
   *  3D (towers layer off). */
  readonly towerLabels: TowerLabelsManager;
  /** House mesh manager — Phase 3. Reconciles 1×1 house meshes with the
   *  map's house list (filters out destroyed houses). */
  readonly houses: HousesManager;
  /** Debris mesh manager — Phase 3. Reconciles wall / cannon / tower
   *  rubble meshes with the overlay. Single manager covers all three
   *  rubble kinds because they share a sprite scene + lifecycle. */
  readonly debris: DebrisManager;
  /** Cannon mesh manager — Phase 4. Reconciles live cannon meshes
   *  (normal/super/mortar/rampart) across every castle. Dead cannons
   *  are still owned by `debris`; balloon cannons are owned by the
   *  balloons entity manager. */
  readonly cannons: CannonsManager;
  /** Balloon mesh manager — Phase 4. Reconciles balloon cannon
   *  meshes in both states: grounded `balloon_base` sprites on every
   *  live balloon cannon, and `balloon_flight` envelopes for active
   *  in-flight captures (`overlay.battle.balloons`). Flight positions
   *  are rewritten per frame (sub-tile motion), base positions are
   *  static per round. */
  readonly balloons: BalloonsManager;
  /** Grunt mesh manager — Phase 4. Reconciles 1×1 grunt meshes with
   *  `overlay.entities.grunts`. Grunts are ownerless; facing drives
   *  continuous Y-rotation on a single base variant. */
  readonly grunts: GruntsManager;
  /** Cannonball mesh manager — Phase 4. Reconciles in-flight
   *  projectile meshes with `overlay.battle.cannonballs`. Variant by
   *  type flags (mortar / incendiary / iron); positions & scales
   *  updated per frame (sub-tile motion during flight). */
  readonly cannonballs: CannonballsManager;
  /** Burning-pit mesh manager — Phase 4. Reconciles 1×1 pit meshes
   *  with `overlay.entities.burningPits`. Variant chosen from the
   *  pit's `roundsLeft` counter (3 → fresh, 2 → dim, 1 → embers);
   *  round decrements flip the fingerprint and trigger a rebuild. */
  readonly pits: PitsManager;
  /** Placement phantom manager — ghost previews of tetris-piece cells
   *  during `WALL_BUILD` and cannon footprints during `CANNON_PLACE`.
   *  Rebuilds every frame (tiny counts, high pointer churn); validity
   *  picks a green vs red tint. */
  readonly phantoms: PhantomsManager;
  /** Impact flash/ring/spark/smoke manager — Phase 6. Reconciles
   *  `overlay.battle.impacts` into a fixed pool of flat meshes anchored
   *  on the ground plane; material opacity + scale drive the 2D-parity
   *  phase timeline per frame. */
  readonly impacts: ImpactsManager;
  /** Wall-burn manager — fire / smoke / sparks burst when a wall is
   *  destroyed. Reconciles `overlay.battle.wallBurns` into per-tile
   *  hosts of flame cones + smoke sprites + spark sprites + a brief
   *  flash. Per-frame animation reads the burn's `age` field for envelope
   *  + crackle math; deterministic per-tile variation derives from
   *  `tileSeed`. */
  readonly wallBurns: WallBurnsManager;
  /** Cannon-burn manager — heavier sibling of `wallBurns`, fired when a
   *  cannon is destroyed. Reconciles `overlay.battle.cannonDestroys`
   *  into per-cannon hosts sized to the 2×2 / 3×3 footprint with ~1.5×
   *  the flames / sparks / smoke of a wall burst. */
  readonly cannonBurns: CannonBurnsManager;
  /** Grunt-kill burst manager — 1×1 cousin of `wallBurns`, fired when a
   *  grunt (tank) is killed. Slightly heavier emissive / spark profile
   *  than a wall burn to read as "tank brewed up". */
  readonly gruntBurns: GruntBurnsManager;
  /** House-destroy burst manager — 1×1 cousin of `wallBurns`, fired
   *  when a house is destroyed. Longer life + taller flame + extra
   *  smoke puffs to read as a wooden building collapsing. */
  readonly houseBurns: HouseBurnsManager;
  /** Crosshair manager — Phase 6. Eight-arm flat meshes per crosshair
   *  anchored at `overlay.battle.crosshairs[].x/y` (pixel units). Arm
   *  length / alpha pulse with the 2D-parity `cannonReady` timeline. */
  readonly crosshairs: CrosshairsManager;
  /** All per-modifier 3D effects — one EffectManager per entry in
   *  `MODIFIER_EFFECT_FACTORIES`. Mixes one-shot reveal bursts,
   *  persistent overlays (fog, sinkhole owner bank tinting), and
   *  event-driven bursts (thawing). Each owns its own lifecycle and
   *  activation gating from `FrameCtx.overlay`. Adding a new modifier
   *  effect (any lifecycle) touches only the registry, not this file. */
  readonly modifierEffects: readonly EffectManager[];
  /** Fine water-wave highlight overlay — polish pass paired with the
   *  terrain mesh's per-tile shimmer. Paints the 2D `drawWaterAnimation`
   *  pattern onto a shared canvas each frame and composites it over the
   *  terrain. Only active during battle. */
  readonly waterWaves: WaterWavesManager;
  /** Terrain bitmap overlay — uploads the 2D renderer's baked terrain
   *  ImageData (grass + water + SDF bank) as a CanvasTexture so water /
   *  grass / shoreline visuals stay pixel-identical across backends.
   *  Sits at ground plane Y=0; the terrain mesh at Y=0.01 composites
   *  overlay tiles (interiors, bonus, frozen, owned sinkholes) on top. */
  readonly terrainBitmap: TerrainBitmapManager;
  /** Flashing gold-disc bonus-square indicators. Rendered as flat
   *  circles on the ground plane outside of battle; pulse matches the
   *  2D `drawBonusSquares` alpha timeline. */
  readonly bonusSquares: BonusSquaresManager;
  /** Off-screen framebuffer the scene is rendered into on each frame.
   *  Readable via `renderer.readRenderTargetPixels` whenever the banner
   *  system wants a snapshot (outside the rAF tick). Replaces the old
   *  `preserveDrawingBuffer: true` workaround — without a render target,
   *  the default framebuffer's contents are undefined after the frame's
   *  swap, so drawImage(worldCanvas) outside rAF sampled a cleared or
   *  stale buffer. */
  readonly captureTarget: THREE.WebGLRenderTarget;
  /** One-mesh scene containing a fullscreen quad whose material samples
   *  `captureTarget.texture`. Rendering this scene to the default
   *  framebuffer copies the FBO contents to the canvas — a single
   *  fragment-shader pass is cheaper than re-rendering the full scene
   *  twice per frame. */
  readonly blitScene: THREE.Scene;
  /** Ortho camera paired with {@link blitScene}: frustum is exactly
   *  [-1, 1] × [-1, 1], matching the authored quad's extent so the
   *  quad fills the whole viewport. */
  readonly blitCamera: THREE.OrthographicCamera;
}

/** Build the scene graph used by `createRender3d`. */
export function createRender3dScene(
  canvas: HTMLCanvasElement,
  getTerrainBitmap: GetTerrainBitmap,
  getSinkholeOverlayBitmap: GetSinkholeOverlayBitmap,
  getCannonFacing: GetCannonFacing,
): Render3dContext {
  const scene = new THREE.Scene();

  const camera = createMapCamera();

  for (const light of createWorldLights()) {
    scene.add(light);
  }

  const terrain = createTerrain();
  scene.add(terrain.mesh);

  const walls = createWallsManager(scene);
  const towers = createTowersManager(scene);
  const towerLabels = createTowerLabelsManager(scene);
  const houses = createHousesManager(scene);
  const debris = createDebrisManager(scene);
  const cannons = createCannonsManager(scene, getCannonFacing);
  const grunts = createGruntsManager(scene);
  const cannonballs = createCannonballsManager(scene);
  const pits = createPitsManager(scene);
  const balloons = createBalloonsManager(scene);
  const phantoms = createPhantomsManager(scene);
  const impacts = createImpactsManager(scene);
  const wallBurns = createWallBurnsManager(scene);
  const cannonBurns = createCannonBurnsManager(scene);
  const gruntBurns = createGruntBurnsManager(scene);
  const houseBurns = createHouseBurnsManager(scene);
  const crosshairs = createCrosshairsManager(scene);
  // Service-style managers used by registry effects: created here so
  // modifier effects can drive them via small APIs (`fogManager.set...`)
  // without owning the rendering. Included alongside registry effects
  // in `modifierEffects` so they're ticked + disposed uniformly.
  const fog = createFogManager(scene);
  const modifierEffects: readonly EffectManager[] = [
    fog,
    ...MODIFIER_EFFECT_FACTORIES.map((factory) =>
      factory(scene, { getSinkholeOverlayBitmap, fogManager: fog }),
    ),
  ];
  const waterWaves = createWaterWavesManager(scene);
  const terrainBitmap = createTerrainBitmapManager(scene, getTerrainBitmap);
  const bonusSquares = createBonusSquaresManager(scene);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;

  // FBO that mirrors the on-screen render each frame. Capture reads
  // back from here via `renderer.readRenderTargetPixels` — works
  // outside the rAF tick (unlike `drawImage(worldCanvas)`, which
  // requires `preserveDrawingBuffer: true` to keep the default
  // framebuffer readable after swap). Sized to the same backing-store
  // resolution as the canvas so pixels line up 1:1.
  const captureTarget = new THREE.WebGLRenderTarget(
    canvas.width,
    canvas.height,
    {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      // sRGB-encoded FBO so `readRenderTargetPixels` returns display-ready
      // sRGB bytes (for the banner B-snapshot capture). Three.js's default
      // `renderer.outputColorSpace = SRGBColorSpace` only converts
      // linear→sRGB when writing to the default framebuffer, so a plain
      // FBO holds LINEAR values; reading those straight into ImageData
      // produced a visibly darker B than A (which goes via the blit to
      // the default framebuffer and therefore gets the sRGB conversion).
      // Declaring the target sRGB makes three.js convert on write; the
      // blit shader's sampler then converts sRGB→linear on read and the
      // default-framebuffer output converts linear→sRGB — net identity
      // for the visible path, but the direct readback now matches.
      colorSpace: THREE.SRGBColorSpace,
    },
  );

  // Blit quad — renders `captureTarget.texture` fullscreen to whichever
  // framebuffer the renderer is currently pointed at. Three.js runs the
  // WebGL context with `premultipliedAlpha: true` by default, so the
  // FBO's RGB is already multiplied by its alpha. Standard NormalBlending
  // (srcAlpha, 1-srcAlpha) would multiply by alpha a second time — the
  // classic "semi-transparent layers go darker" symptom. `CustomBlending`
  // with src=One / dst=OneMinusSrcAlpha is the canonical premultiplied-
  // alpha blend and produces output that the default premultiplied-alpha
  // backbuffer (and the browser compositor reading it) expects.
  // `depthTest/Write: false` skips depth work irrelevant to a fullscreen
  // blit. `transparent: true` is still required so three.js treats the
  // material as non-opaque and respects the blending factors.
  const blitScene = new THREE.Scene();
  const blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blitMaterial = new THREE.MeshBasicMaterial({
    map: captureTarget.texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });
  const blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMaterial);
  blitScene.add(blitQuad);

  return {
    scene,
    camera,
    renderer,
    captureTarget,
    blitScene,
    blitCamera,
    terrain,
    walls,
    towers,
    towerLabels,
    houses,
    debris,
    cannons,
    grunts,
    cannonballs,
    pits,
    balloons,
    phantoms,
    impacts,
    wallBurns,
    cannonBurns,
    gruntBurns,
    houseBurns,
    crosshairs,
    modifierEffects,
    waterWaves,
    terrainBitmap,
    bonusSquares,
  };
}
