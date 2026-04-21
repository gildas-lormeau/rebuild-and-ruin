/**
 * Ground elevation helpers for the 3D renderer.
 *
 * Cannonballs and crosshair cursors treat the world as a flat Y=0 ground
 * plane by default, but the 3D scene has real geometric height for walls.
 * Players aim at the tops of walls (and expect balls to land there), so
 * sprites whose tile happens to sit on a wall need to be lifted to that
 * wall's top — otherwise they visually pass through the wall and hit the
 * ground below.
 *
 * This module keeps the elevation constants + per-(x,y) lookup in one
 * place so both `crosshairs` and `cannonballs` read the same numbers.
 * Walls, towers, cannons, houses, and grunts are each modelled with a
 * tuned top-Y; `targetTopAt` picks the tallest one at a given tile.
 */

import type { GameMap } from "../../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../../shared/core/grid.ts";
import { isCannonAlive, isSuperCannon } from "../../shared/core/spatial.ts";
import type {
  CastleData,
  RenderOverlay,
} from "../../shared/ui/overlay-types.ts";
import { boundsYOf as cannonBoundsYOf } from "./sprites/cannon-scene.ts";
import { boundsYOf as gruntBoundsYOf } from "./sprites/grunt-scene.ts";
import { boundsYOf as houseBoundsYOf } from "./sprites/house-scene.ts";
import { boundsYOf as towerBoundsYOf } from "./sprites/tower-scene.ts";

/** Wall body top in world units. wall-scene.ts authors walls with body
 *  height `H = 3.22` sprite units; `entities/walls.ts` scales each cell
 *  by `TILE_SIZE / 2 = 8`, so the body's top sits at 3.22 × 8 ≈ 25.76
 *  world units. We aim at the BODY top (the walk surface), not the
 *  decorative merlon tops, because balls & crosshairs should land on
 *  the battlement walk. */
const WALL_TOP_Y = 3.22 * (TILE_SIZE / 2);
/** Top-Y of entity variants in world units, derived at module load from
 *  each scene file's authored geometry via `boundsYOf`. We pick one
 *  canonical variant per entity kind (home_tower for towers, tier_1 for
 *  cannons, house for houses, grunt_n for grunts) and multiply the
 *  authored maxY by the entity manager's uniform scale (see
 *  `entities/*.ts`): towers & cannons scale by TILE_SIZE, houses &
 *  grunts by TILE_SIZE / 2. The fallback values are the pre-derivation
 *  hand-tuned constants — only used if a scene's builder fails (e.g.
 *  missing variant, or running where THREE can't instantiate). */
const TOWER_TOP_Y = deriveTopY(towerBoundsYOf("home_tower"), TILE_SIZE, 56);
const CANNON_TOP_Y = deriveTopY(cannonBoundsYOf("tier_1"), TILE_SIZE, 14);
const HOUSE_TOP_Y = deriveTopY(houseBoundsYOf("house"), TILE_SIZE / 2, 16);
const GRUNT_TOP_Y = deriveTopY(gruntBoundsYOf("grunt_n"), TILE_SIZE / 2, 10);
/** Global lift applied on top of the aim-elevation so the crosshair
 *  doesn't get buried under the terrain mesh's opaque interior /
 *  bonus / frozen tiles (which sit at Y=0.01). 2 world units = 2
 *  game-1× pixels. */
const CROSSHAIR_MARGIN_Y = 2;
/** Y-layer stack for ground-plane meshes, from bottom up. The order
 *  fixes composition (raw grass/water in the bitmap → terrain mesh
 *  adds interior/frozen/owned-sinkhole tints → sinkhole bank recolour
 *  → water-wave highlights → bonus pickups → crosshairs → fog). */
export const ELEVATION_STACK = {
  TERRAIN_BITMAP: 0,
  TERRAIN_MESH: 0.01,
  SINKHOLE_OVERLAY: 0.02,
  WATER_WAVES: 0.1,
  BONUS_DISCS: 0.3,
  PIECE_PHANTOM: 0.5,
  IMPACTS: 0.5,
  THAWING: 0.5,
  CROSSHAIRS: 0.8,
  FOG: 1.2,
} as const;
/** Draw-order ladder for effect meshes. Higher values render later
 *  (on top). These are intentionally sparse so new layers can be
 *  inserted without renumbering. */
export const RENDER_ORDER = {
  EFFECT: 900, // bonus discs, crosshair (roughly equivalent visibility)
  PHANTOM: 1000, // placement previews — always on top
} as const;
/** Small Y offset added on top of ELEVATION_STACK levels when two
 *  effect meshes share a nominal Y but one must composite on top. */
export const Z_FIGHT_MARGIN = 0.1;

/** Top-Y of the tallest thing at `(x, y)` — for the crosshair cursor
 *  to sit on top of its target (wall, tower, cannon, house, grunt).
 *  Unlike `elevationAt`, this considers entity geometry (not just
 *  walls) and falls back to the flat ground plane when nothing is
 *  there. Dead towers resolve to ground (their debris piles are
 *  flat-ish). */
export function aimElevationAt(
  x: number,
  y: number,
  overlay: RenderOverlay | undefined,
  map: GameMap | undefined,
): number {
  return targetTopAt(x, y, overlay, map) + CROSSHAIR_MARGIN_Y;
}

/** Top-Y of any targetable entity (wall, tower, cannon, house, grunt)
 *  at `(x, y)`, or 0 if nothing is there. Used by cannonballs so the
 *  landing floor matches the top of the thing the ball is aimed at —
 *  otherwise a ball aimed at a tower or cannon would fly past its top
 *  and hit the ground. Unlike `aimElevationAt`, no crosshair margin
 *  is added; the ball should disappear at the exact top of the target
 *  geometry, not a few units above it. */
export function targetTopAt(
  x: number,
  y: number,
  overlay: RenderOverlay | undefined,
  map: GameMap | undefined,
): number {
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return 0;

  const wallY = elevationAt(x, y, overlay?.castles);
  if (wallY > 0) return wallY;

  if (map?.towers) {
    const aliveMask = overlay?.entities?.towerAlive;
    for (let index = 0; index < map.towers.length; index++) {
      const tower = map.towers[index]!;
      if (aliveMask && aliveMask[index] === false) continue;
      if (
        col >= tower.col &&
        col < tower.col + 2 &&
        row >= tower.row &&
        row < tower.row + 2
      )
        return TOWER_TOP_Y;
    }
  }

  if (overlay?.castles) {
    for (const castle of overlay.castles) {
      for (const cannon of castle.cannons) {
        if (!isCannonAlive(cannon)) continue;
        const size = isSuperCannon(cannon) ? 3 : 2;
        if (
          col >= cannon.col &&
          col < cannon.col + size &&
          row >= cannon.row &&
          row < cannon.row + size
        )
          return CANNON_TOP_Y;
      }
    }
  }

  if (map?.houses) {
    for (const house of map.houses) {
      if (!house.alive) continue;
      if (house.col === col && house.row === row) return HOUSE_TOP_Y;
    }
  }

  const grunts = overlay?.entities?.grunts;
  if (grunts) {
    for (const grunt of grunts) {
      if (grunt.col === col && grunt.row === row) return GRUNT_TOP_Y;
    }
  }

  return 0;
}

/** Multiply a scene's authored Y-bounds by its entity-manager scale to
 *  get the world-Y apex, or fall back to the hand-tuned value when the
 *  scene's builder couldn't resolve a variant. */
function deriveTopY(
  bounds: { minY: number; maxY: number } | undefined,
  sceneScale: number,
  fallback: number,
): number {
  if (!bounds) return fallback;
  return bounds.maxY * sceneScale;
}

/** Wall-only elevation: returns `WALL_TOP_Y` when `(x, y)` lands on a
 *  wall tile of any castle in `castles`, otherwise 0. Used as the
 *  first-priority check inside `targetTopAt` (walls beat other
 *  overlapping entities for aim purposes). */
function elevationAt(
  x: number,
  y: number,
  castles: readonly CastleData[] | undefined,
): number {
  if (!castles || castles.length === 0) return 0;
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return 0;
  const key = row * GRID_COLS + col;
  for (const castle of castles) {
    if (castle.walls.has(key)) return WALL_TOP_Y;
  }
  return 0;
}
