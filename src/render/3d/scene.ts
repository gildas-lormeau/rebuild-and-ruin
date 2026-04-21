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
  type CrosshairsManager,
  createCrosshairsManager,
} from "./effects/crosshairs.ts";
import { createFogManager, type FogManager } from "./effects/fog.ts";
import {
  createImpactsManager,
  type ImpactsManager,
} from "./effects/impacts.ts";
import {
  createSinkholeOverlayManager,
  type GetSinkholeOverlayBitmap,
  type SinkholeOverlayManager,
} from "./effects/sinkhole-overlay.ts";
import {
  createTerrainBitmapManager,
  type GetTerrainBitmap,
  type TerrainBitmapManager,
} from "./effects/terrain-bitmap.ts";
import {
  createThawingManager,
  type ThawingManager,
} from "./effects/thawing.ts";
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
} from "./entities/cannons.ts";
import { createDebrisManager, type DebrisManager } from "./entities/debris.ts";
import { createGruntsManager, type GruntsManager } from "./entities/grunts.ts";
import { createHousesManager, type HousesManager } from "./entities/houses.ts";
import {
  createPhantomsManager,
  type PhantomsManager,
} from "./entities/phantoms.ts";
import { createPitsManager, type PitsManager } from "./entities/pits.ts";
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
  /** Crosshair manager — Phase 6. Eight-arm flat meshes per crosshair
   *  anchored at `overlay.battle.crosshairs[].x/y` (pixel units). Arm
   *  length / alpha pulse with the 2D-parity `cannonReady` timeline. */
  readonly crosshairs: CrosshairsManager;
  /** Fog-of-war manager — Phase 6. One flat tile + drifting highlight
   *  per fogged tile in `overlay.battle.fogOfWar` castle dilations. */
  readonly fog: FogManager;
  /** Thawing-tile manager — Phase 6. Fade + crack-burst animation on
   *  `overlay.entities.thawingTiles`. Base frozen-tile ICE_COLOR is
   *  owned by `terrain` (Phase 2). */
  readonly thawing: ThawingManager;
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
  /** Owned-sinkhole bank recoloring overlay — uploads the 2D renderer's
   *  `getSinkholeOverlayBitmap` per-cluster owner-tinted patches as a
   *  CanvasTexture on a plane above the terrain mesh. Parity with the
   *  2D `drawSinkholeOverlays` bank-fade pass. */
  readonly sinkholeOverlay: SinkholeOverlayManager;
}

/** Build the scene graph used by `createRender3d`. */
export function createRender3dScene(
  canvas: HTMLCanvasElement,
  getTerrainBitmap: GetTerrainBitmap,
  getSinkholeOverlayBitmap: GetSinkholeOverlayBitmap,
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
  const houses = createHousesManager(scene);
  const debris = createDebrisManager(scene);
  const cannons = createCannonsManager(scene);
  const grunts = createGruntsManager(scene);
  const cannonballs = createCannonballsManager(scene);
  const pits = createPitsManager(scene);
  const balloons = createBalloonsManager(scene);
  const phantoms = createPhantomsManager(scene);
  const impacts = createImpactsManager(scene);
  const crosshairs = createCrosshairsManager(scene);
  const fog = createFogManager(scene);
  const thawing = createThawingManager(scene);
  const waterWaves = createWaterWavesManager(scene);
  const terrainBitmap = createTerrainBitmapManager(scene, getTerrainBitmap);
  const sinkholeOverlay = createSinkholeOverlayManager(
    scene,
    getSinkholeOverlayBitmap,
  );

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    // `preserveDrawingBuffer` keeps the WebGL framebuffer readable between
    // the end of a frame and the next draw. The banner prev-scene snapshot
    // (`captureScene` in renderer.ts) runs during a phase-mutate callback
    // outside the rAF tick, so without preservation `drawImage(worldCanvas)`
    // would sample a cleared buffer. Minor perf cost, but this only matters
    // once per phase transition.
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;

  return {
    scene,
    camera,
    renderer,
    terrain,
    walls,
    towers,
    houses,
    debris,
    cannons,
    grunts,
    cannonballs,
    pits,
    balloons,
    phantoms,
    impacts,
    crosshairs,
    fog,
    thawing,
    waterWaves,
    terrainBitmap,
    sinkholeOverlay,
  };
}
