/**
 * Three.js scene + camera + lights bootstrap. Coordinate convention
 * (see `camera.ts`): origin at map top-left, 1 world unit = 1 game-1×
 * pixel, Y up, camera looks -Y; `Viewport { x, y, w, h }` maps directly
 * to ortho XZ. Pixel-art atlases need per-texture
 * `mag/minFilter = NearestFilter` since three.js defaults to linear.
 */

import * as THREE from "three";
import { MAP_PX_H, MAP_PX_W } from "../../shared/core/grid.ts";
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
import {
  createCobblestonePatternTexture,
  createGrassPatternTexture,
} from "./effects/terrain-pattern-textures.ts";
import {
  createTerrainSdfTextureManager,
  type GetBlurredSdf,
  type TerrainSdfTextureManager,
} from "./effects/terrain-sdf-texture.ts";
import {
  createTerrainTileDataManager,
  type TerrainTileDataManager,
} from "./effects/terrain-tile-data.ts";
import {
  createWallBurnsManager,
  type WallBurnsManager,
} from "./effects/wall-burns.ts";
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
  /** SDF DataTexture (R32F, MAP_PX × MAP_PX) the terrain mesh's shader
   *  samples for the per-pixel grass→bank→water gradient (default branch
   *  + owned-sinkhole branch). Rebuilt on `mapVersion` change (freeze/thaw,
   *  sinkhole modifier mutation); sourced from the 2D renderer's cached
   *  blurred SDF. */
  readonly terrainSdfTexture: TerrainSdfTextureManager;
  /** Per-tile owner + flag DataTexture (RGBA8, GRID × GRID) the terrain
   *  shader looks up to gate the bank-gradient override. Refreshed only
   *  when interior refs / sinkhole tiles / frozen tiles / battle flag
   *  change — same fingerprint shape the 2D second-plane sinkhole overlay
   *  relied on. */
  readonly terrainTileData: TerrainTileDataManager;
  /** Flashing gold-disc bonus-square indicators. Rendered as flat
   *  circles on the ground plane outside of battle; pulse matches the
   *  2D `drawBonusSquares` alpha timeline. */
  readonly bonusSquares: BonusSquaresManager;
  /** Ambient light. Exposed so the per-frame renderer can lerp its
   *  intensity between battle (lower, to let shadows show) and non-
   *  battle (full strength, palette-preserving) — see `setSunBlend`
   *  in `lights.ts`. */
  readonly ambient: THREE.AmbientLight;
  /** Directional sun light. Exposed so the per-frame renderer can
   *  arc its position from `sunT` (battle elapsed) and toggle shadow
   *  casting on/off — see `setSunBlend` and `updateSunDirection` in
   *  `lights.ts`. */
  readonly sun: THREE.DirectionalLight;
  /** Shadow-only overlay plane that sits coplanar with the terrain
   *  and renders projected shadows. Exposed so the renderer can fade
   *  its opacity in lockstep with the lighting intensity blend, giving
   *  a smooth show/hide at battle entry / exit. */
  readonly groundShadowOverlay: THREE.Mesh;
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

const SHADOW_CASTER_GROUPS: ReadonlySet<string> = new Set([
  "walls",
  "towers",
  "houses",
  "cannons",
  "balloons",
  "debris",
  "grunts",
  "cannonballs",
]);
const SHADOW_RECEIVER_GROUPS: ReadonlySet<string> = new Set(["pits"]);

/** Build the scene graph used by `createRender3d`. */
export function createRender3dScene(
  canvas: HTMLCanvasElement,
  getBlurredSdf: GetBlurredSdf,
  getCannonFacing: GetCannonFacing,
): Render3dContext {
  const scene = new THREE.Scene();

  const camera = createMapCamera();

  const { ambient, sun } = createWorldLights();
  scene.add(ambient);
  scene.add(sun);
  // Three.js only updates a directional light's `target.matrixWorld`
  // when the target is part of the scene graph. Without this, the sun's
  // direction (computed from position − target.position) silently uses
  // the target's identity transform, defeating the per-round rotation.
  scene.add(sun.target);

  const terrainSdfTexture = createTerrainSdfTextureManager(getBlurredSdf);
  const terrainTileData = createTerrainTileDataManager();
  const grassPatternTexture = createGrassPatternTexture();
  const cobblestonePatternTexture = createCobblestonePatternTexture();
  const terrain = createTerrain({
    sdfTexture: terrainSdfTexture.texture,
    tileDataTexture: terrainTileData.texture,
    grassPatternTexture,
    cobblestonePatternTexture,
  });
  scene.add(terrain.mesh);
  // Terrain itself uses `MeshBasicMaterial` (unlit), which CANNOT
  // receive shadows — its fragment shader has no lighting math at all.
  // We therefore layer a separate `ShadowMaterial` plane on top of the
  // terrain that renders only shadow contribution (transparent
  // everywhere except where shadows fall). The terrain stays fully in
  // charge of color / SDF / pattern; this overlay just darkens the
  // pixels where the shadow map says occlusion happened. One extra
  // draw call per frame.
  const groundShadowOverlay = createGroundShadowOverlay();
  scene.add(groundShadowOverlay);

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
  const modifierEffects: readonly EffectManager[] =
    MODIFIER_EFFECT_FACTORIES.map((factory) => factory(scene));
  const bonusSquares = createBonusSquaresManager(scene);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  // Enable shadow casting from the directional sun. PCFSoftShadowMap
  // gives a small percentage-closer filter pass for soft edges — the
  // alternative `BasicShadowMap` produces very stair-stepped shadow
  // boundaries that fight the pixel-art tile grid even harder than the
  // softened version. Cost on the integrated GPUs the game targets is
  // dominated by the shadow-map render pass itself, not the filter
  // kernel.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
    ambient,
    sun,
    groundShadowOverlay,
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
    terrainSdfTexture,
    terrainTileData,
    bonusSquares,
  };
}

/** Mark every mesh under a recognized "solid entity" group as a shadow
 *  caster + receiver, and meshes under "ground-flat" groups as
 *  receivers only. Idempotent and cheap (a single scene traverse with
 *  early skips per top-level group), so the renderer can call it every
 *  frame without bookkeeping which managers rebuilt their meshes. New
 *  groups (added by future entity managers) are silently skipped — add
 *  the group name to `SHADOW_CASTER_GROUPS` or `SHADOW_RECEIVER_GROUPS`
 *  to opt them in. Effects (impacts, burns, fog, modifier-reveal,
 *  crosshairs, phantoms, labels, bonus pulses) are intentionally
 *  excluded: they're flat billboards or particle emitters whose
 *  silhouettes don't read sensibly when projected onto the ground. */
export function applyShadowFlags(scene: THREE.Scene): void {
  for (const child of scene.children) {
    if (!(child instanceof THREE.Group)) continue;
    if (SHADOW_CASTER_GROUPS.has(child.name)) {
      child.traverse(markCastAndReceive);
    } else if (SHADOW_RECEIVER_GROUPS.has(child.name)) {
      child.traverse(markReceiveOnly);
    }
  }
}

/** Build the shadow-only overlay plane that sits on the ground plane
 *  and shows projected shadows from every caster. The terrain mesh
 *  itself is unlit (`MeshBasicMaterial`) so it can't receive shadows;
 *  this plane uses `ShadowMaterial`, which renders nothing where the
 *  shadow map says "lit" and a translucent dark patch where the shadow
 *  map says "occluded". `polygonOffset` keeps it from z-fighting with
 *  the coplanar terrain mesh. Sized to the full map; covers the same
 *  XZ extent as the terrain. */
function createGroundShadowOverlay(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(MAP_PX_W, MAP_PX_H);
  // PlaneGeometry is authored in the XY plane facing +Z; rotate so it
  // lies flat on the ground (XZ plane facing +Y).
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.ShadowMaterial({
    // Opacity is rewritten every frame by the renderer (faded between
    // 0 and `SHADOW_OVERLAY_PEAK_OPACITY` based on the battle blend
    // factor), so the initial value just controls the pre-first-frame
    // look — start at 0 so any frame rendered before the runtime
    // installs state is shadow-free.
    opacity: 0,
    transparent: true,
    // Don't contribute to the depth buffer. Without this, the overlay
    // (drawn in the transparent pass before higher-Y debris because
    // it's further from the camera) writes its depth and competes
    // with thin transparent surfaces sitting just above ground —
    // notably the wall-debris base plate at world Y≈0.08 that fills
    // the tile so grass doesn't show through gaps in the rubble. With
    // depthWrite off, the overlay just alpha-blends onto whatever the
    // opaque pass already drew (terrain) and never blocks subsequent
    // transparent geometry.
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(MAP_PX_W / 2, 0, MAP_PX_H / 2);
  mesh.receiveShadow = true;
  // The shadow overlay is NOT a regular entity group — name it
  // explicitly so anyone walking the scene tree understands its role.
  // `applyShadowFlags` skips non-Group scene children, so this Mesh's
  // `castShadow` stays at its default (false) — the overlay must not
  // contribute to the shadow map itself.
  mesh.name = "ground-shadow-overlay";
  return mesh;
}

function markCastAndReceive(obj: THREE.Object3D): void {
  if ((obj as THREE.Mesh).isMesh) {
    obj.castShadow = true;
    obj.receiveShadow = true;
  }
}

function markReceiveOnly(obj: THREE.Object3D): void {
  if ((obj as THREE.Mesh).isMesh) {
    obj.receiveShadow = true;
  }
}
