/**
 * Dev-only page driven by `scripts/sprite-view.ts`: builds one sprite
 * scene from URL params, frames it via the projected AABB so pitched
 * views fit exactly, renders one frame, exposes `__SPRITE_VIEWER_READY`.
 * Query params: sprite, variant, pitch (deg), rotation (deg yaw applied
 * to the subject before framing), scale (integer upscale of the
 * variant's canvasPx). See the CLI's --help for valid values.
 */

import * as THREE from "three";
import { createWorldLights, setSunBlend } from "../src/render/3d/lights.ts";
import {
  buildBalloon,
  getBalloonVariant,
} from "../src/render/3d/sprites/balloon-scene.ts";
import {
  buildCannon,
  getCannonVariant,
} from "../src/render/3d/sprites/cannon-scene.ts";
import {
  buildCannonball,
  getCannonballVariant,
} from "../src/render/3d/sprites/cannonball-scene.ts";
import {
  buildDebris,
  getDebrisVariant,
} from "../src/render/3d/sprites/debris-scene.ts";
import {
  buildGrunt,
  getGruntVariant,
} from "../src/render/3d/sprites/grunt-scene.ts";
import {
  buildHouse,
  getHouseVariant,
} from "../src/render/3d/sprites/house-scene.ts";
import { buildPit, getPitVariant } from "../src/render/3d/sprites/pit-scene.ts";
import {
  buildRampart,
  getRampartVariant,
} from "../src/render/3d/sprites/rampart-scene.ts";
import {
  buildSupplyShip,
  getSupplyShipVariant,
} from "../src/render/3d/sprites/supply-ship-scene.ts";
import {
  buildTower,
  getTowerVariant,
} from "../src/render/3d/sprites/tower-scene.ts";
import {
  buildWall,
  VARIANTS as WALL_VARIANTS,
} from "../src/render/3d/sprites/wall-scene.ts";

type SpriteKind =
  | "cannon"
  | "grunt"
  | "tower"
  | "house"
  | "wall"
  | "pit"
  | "balloon"
  | "supply-ship"
  | "cannonball"
  | "debris"
  | "rampart";

interface VariantSize {
  canvasPx: number;
  canvasPxH: number;
}

interface ViewerGlobals {
  __SPRITE_VIEWER_READY?: boolean;
  __SPRITE_VIEWER_ERROR?: string;
}

const PARAMS = new URLSearchParams(globalThis.location.search);
const KIND = (PARAMS.get("sprite") ?? "cannon") as SpriteKind;
const VARIANT = PARAMS.get("variant") ?? defaultVariantFor(KIND);
const PITCH_DEG = Number(PARAMS.get("pitch") ?? "30");
const ROTATION_DEG = Number(PARAMS.get("rotation") ?? "0");
const SCALE = Math.max(1, Math.floor(Number(PARAMS.get("scale") ?? "12")));

main().catch((error: unknown) => {
  (globalThis as unknown as ViewerGlobals).__SPRITE_VIEWER_ERROR =
    error instanceof Error ? error.message : String(error);
});

async function main(): Promise<void> {
  const subject = new THREE.Group();
  const size = buildSprite(KIND, VARIANT, subject);
  subject.rotation.y = (ROTATION_DEG * Math.PI) / 180;
  subject.updateMatrixWorld();

  const canvas = document.getElementById("sprite-canvas") as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x202428, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const lights = createWorldLights();
  scene.add(lights.ambient);
  scene.add(lights.sun);
  scene.add(lights.sun.target);
  setSunBlend(lights.ambient, lights.sun, PITCH_DEG > 0 ? 1 : 0);
  scene.add(subject);

  // Ground disc so shadows have something to land on. Sized larger than
  // the sprite's footprint so off-angle shadows don't fall off the edge.
  // `frustumCulled = false` keeps it from contributing to the subject's
  // AABB when we compute framing below.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshLambertMaterial({ color: 0x3a4040 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const camera = frameSprite(subject, PITCH_DEG, size);
  const frustumW = camera.right - camera.left;
  const frustumH = camera.top - camera.bottom;
  // Square pixels: same world-units-per-pixel horizontally and
  // vertically. Anchor width to canvasPx*scale (the game's atlas
  // width), derive height to match the frustum aspect.
  const canvasW = Math.round(size.canvasPx * SCALE);
  const canvasH = Math.round(canvasW * (frustumH / frustumW));
  canvas.width = canvasW;
  canvas.height = canvasH;
  renderer.setSize(canvasW, canvasH, false);

  renderer.render(scene, camera);
  // Wait one rAF for the GPU to settle before signaling ready.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  renderer.render(scene, camera);
  (globalThis as unknown as ViewerGlobals).__SPRITE_VIEWER_READY = true;
}

/**
 * Frame the camera so the subject's projected silhouette fills the
 * frustum. Horizontal extent is anchored to the game's atlas convention
 * (frustum-X spans [-1, 1] — the build* factories author sprites to fit
 * exactly in this range). Vertical extent is computed by projecting the
 * subject's AABB into camera-local space, so pitched views grow vertically
 * by exactly as much as the tilted silhouette demands — no magic padding,
 * no cropping.
 */
function frameSprite(
  subject: THREE.Object3D,
  pitchDeg: number,
  size: VariantSize,
): THREE.OrthographicCamera {
  const pitch = (pitchDeg * Math.PI) / 180;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  if (pitchDeg === 0) {
    // Top-down: gimbal-safe up vector. `(0, 0, -1)` makes world +Z
    // (south in game convention) point toward screen-bottom.
    camera.up.set(0, 0, -1);
    camera.position.set(0, 100, 0);
  } else {
    camera.up.set(0, 1, 0);
    camera.position.set(0, cosP * 100, sinP * 100);
  }
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  // Project the subject's AABB into camera-local space. For an
  // orthographic camera, local-X and local-Y are exactly the frustum
  // axes.
  const bbox = new THREE.Box3().setFromObject(subject);
  const localBox = bbox.clone().applyMatrix4(camera.matrixWorldInverse);

  // Horizontal: anchor to [-1, 1] (game atlas convention). This trusts
  // the sprite factories' authored extent — they're designed to fit
  // exactly. Vertical: fit the projected silhouette with a small margin
  // (1 game-2x pixel = 2/canvasPx world units, so a 1-pixel margin =
  // 1/canvasPx world units).
  const margin = 1 / size.canvasPx;
  camera.left = -1;
  camera.right = 1;
  camera.top = localBox.max.y + margin;
  camera.bottom = localBox.min.y - margin;
  camera.updateProjectionMatrix();
  return camera;
}

function buildSprite(
  kind: SpriteKind,
  variantName: string,
  target: THREE.Group,
): VariantSize {
  switch (kind) {
    case "cannon": {
      const variant = getCannonVariant(variantName);
      if (!variant) throw new Error(`Unknown cannon variant: ${variantName}`);
      buildCannon(THREE, target, variant.params);
      return sizeOf(variant);
    }
    case "grunt": {
      const variant = getGruntVariant(variantName);
      if (!variant) throw new Error(`Unknown grunt variant: ${variantName}`);
      buildGrunt(THREE, target, variant.params);
      return sizeOf(variant);
    }
    case "tower": {
      const variant = getTowerVariant(variantName);
      if (!variant) throw new Error(`Unknown tower variant: ${variantName}`);
      buildTower(THREE, target, variant.params);
      return sizeOf(variant);
    }
    case "house": {
      const variant = getHouseVariant(variantName);
      if (!variant) throw new Error(`Unknown house variant: ${variantName}`);
      buildHouse(THREE, target, variant.params);
      return sizeOf(variant);
    }
    case "wall": {
      const variant = WALL_VARIANTS.find((wall) => wall.name === variantName);
      if (!variant) throw new Error(`Unknown wall variant: ${variantName}`);
      buildWall(THREE, target, variant.params);
      return sizeOf(variant);
    }
    case "pit": {
      const variant = getPitVariant(variantName);
      if (!variant) throw new Error(`Unknown pit variant: ${variantName}`);
      buildPit(THREE, target, variant.params);
      return sizeOf(variant);
    }
    case "balloon": {
      const variant = getBalloonVariant(variantName);
      if (!variant) throw new Error(`Unknown balloon variant: ${variantName}`);
      buildBalloon(THREE, target, variant);
      return sizeOf(variant);
    }
    case "supply-ship": {
      const variant = getSupplyShipVariant();
      buildSupplyShip(THREE, target, variant.params);
      return sizeOf(variant);
    }
    case "cannonball": {
      const variant = getCannonballVariant(variantName);
      if (!variant) {
        throw new Error(`Unknown cannonball variant: ${variantName}`);
      }
      buildCannonball(THREE, target, variant.params);
      return sizeOf(variant);
    }
    case "debris": {
      const variant = getDebrisVariant(variantName);
      if (!variant) throw new Error(`Unknown debris variant: ${variantName}`);
      buildDebris(THREE, target, variant);
      return sizeOf(variant);
    }
    case "rampart": {
      const variant = getRampartVariant(variantName);
      if (!variant) throw new Error(`Unknown rampart variant: ${variantName}`);
      buildRampart(THREE, target, variant.params);
      return sizeOf(variant);
    }
  }
}

function sizeOf(variant: {
  canvasPx: number;
  canvasPxH?: number;
}): VariantSize {
  return {
    canvasPx: variant.canvasPx,
    canvasPxH: variant.canvasPxH ?? variant.canvasPx,
  };
}

function defaultVariantFor(kind: SpriteKind): string {
  switch (kind) {
    case "cannon":
      return "tier_1";
    case "grunt":
      return "grunt_n";
    case "tower":
      return "secondary_tower";
    case "house":
      return "house";
    case "wall":
      return "wall_isolated";
    case "pit":
      return "pit_fresh";
    case "balloon":
      return "balloon_flight";
    case "supply-ship":
      return "supply-ship";
    case "cannonball":
      return "cannonball_iron";
    case "debris":
      return "tier_1_debris";
    case "rampart":
      return "rampart_cannon";
  }
}
