/**
 * Static registry of every sprite-scene the build-sprite-3d.html debug
 * page can load. Explicit named imports document each scene's public
 * pipeline-API surface; helpers in the scene modules stay invisible to
 * knip and are flagged when no longer used. Adding a new scene means
 * adding one entry here — no per-export `@public` tagging required.
 *
 * The HTML loads this registry once, then dispatches by scene key. No
 * lazy loading: 10 small modules eagerly imported is fine for a debug
 * page that's never on the production path.
 */

import {
  PALETTE as balloonPalette,
  VARIANTS as balloonVariants,
  buildBalloon,
} from "../src/render/3d/sprites/balloon-scene.ts";
import {
  buildCannon,
  PALETTE as cannonPalette,
  VARIANTS as cannonVariants,
} from "../src/render/3d/sprites/cannon-scene.ts";
import {
  buildCannonball,
  PALETTE as cannonballPalette,
  VARIANTS as cannonballVariants,
} from "../src/render/3d/sprites/cannonball-scene.ts";
import {
  buildDebris,
  PALETTE as debrisPalette,
  VARIANTS as debrisVariants,
} from "../src/render/3d/sprites/debris-scene.ts";
import {
  buildGrunt,
  PALETTE as gruntPalette,
  VARIANTS as gruntVariants,
} from "../src/render/3d/sprites/grunt-scene.ts";
import {
  buildHouse,
  PALETTE as housePalette,
  VARIANTS as houseVariants,
} from "../src/render/3d/sprites/house-scene.ts";
import {
  buildPit,
  PALETTE as pitPalette,
  VARIANTS as pitVariants,
} from "../src/render/3d/sprites/pit-scene.ts";
import {
  buildRampart,
  PALETTE as rampartPalette,
  VARIANTS as rampartVariants,
} from "../src/render/3d/sprites/rampart-scene.ts";
import {
  buildTower,
  PALETTE as towerPalette,
  VARIANTS as towerVariants,
} from "../src/render/3d/sprites/tower-scene.ts";
import {
  buildWall,
  PALETTE as wallPalette,
  VARIANTS as wallVariants,
} from "../src/render/3d/sprites/wall-scene.ts";

export type SceneKind = keyof typeof SPRITE_SCENES;

export const SPRITE_SCENES = {
  balloon: {
    VARIANTS: balloonVariants,
    PALETTE: balloonPalette,
    build: buildBalloon,
  },
  cannon: {
    VARIANTS: cannonVariants,
    PALETTE: cannonPalette,
    build: buildCannon,
  },
  cannonball: {
    VARIANTS: cannonballVariants,
    PALETTE: cannonballPalette,
    build: buildCannonball,
  },
  debris: {
    VARIANTS: debrisVariants,
    PALETTE: debrisPalette,
    build: buildDebris,
  },
  grunt: {
    VARIANTS: gruntVariants,
    PALETTE: gruntPalette,
    build: buildGrunt,
  },
  house: {
    VARIANTS: houseVariants,
    PALETTE: housePalette,
    build: buildHouse,
  },
  pit: {
    VARIANTS: pitVariants,
    PALETTE: pitPalette,
    build: buildPit,
  },
  rampart: {
    VARIANTS: rampartVariants,
    PALETTE: rampartPalette,
    build: buildRampart,
  },
  tower: {
    VARIANTS: towerVariants,
    PALETTE: towerPalette,
    build: buildTower,
  },
  wall: {
    VARIANTS: wallVariants,
    PALETTE: wallPalette,
    build: buildWall,
  },
} as const;
