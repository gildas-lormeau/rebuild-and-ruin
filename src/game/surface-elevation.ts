/**
 * Sim-side surface altitude lookup — the highest standing thing at a
 * given world position, used by the cannonball trajectory at fire time
 * (`targetAltitude`) and during flight (impact detection).
 *
 * Mirrors the renderer's `targetTopAt` (render/3d/elevation.ts) but
 * reads directly from `GameState` instead of a render overlay snapshot.
 * Top-Y constants are shared via `elevation-constants.ts` so the two
 * code paths can't drift apart.
 *
 * Priority order matches the renderer: walls > towers > cannons >
 * houses > grunts > 0 (ground). Walls take precedence even when
 * overlapping a cannon footprint (which never happens today, but the
 * order matters if it ever does).
 *
 * Friendly-fire filter: when `opts.shooterId` is set, the shooter's
 * own walls and cannons are *transparent to the query* — except at the
 * `opts.target` tile, which always sees everything. This produces the
 * "ball arcs over your own stuff but lands on it if you aim at it"
 * behavior. Towers / houses / grunts are unowned by this rule (towers
 * aren't damaged by cannonballs anyway; houses and grunts have no
 * shooter affinity).
 */

import {
  CANNON_TOP_Y,
  GRUNT_TOP_Y,
  HOUSE_TOP_Y,
  TOWER_TOP_Y,
  WALL_TOP_Y,
} from "../shared/core/elevation-constants.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, TILE_SIZE } from "../shared/core/grid.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isCannonAlive, isCannonTile } from "../shared/core/spatial.ts";
import type { GameState } from "../shared/core/types.ts";

interface SurfaceQueryOpts {
  /** Owner of the in-flight ball — the query skips this player's walls
   *  and cannons (they're transparent to their own balls in flight),
   *  unless the queried tile is the explicit `target` below. */
  readonly shooterId?: ValidPlayerSlot;
  /** The original aim tile. At this exact tile the friendly-fire filter
   *  is disabled so the player can deliberately self-destruct on their
   *  own cannon or wall. */
  readonly target?: TilePos;
}

/** Top-Y of the tallest standing entity at world position (worldX, worldY)
 *  — where worldX/worldY are pixel coords in the top-down 2D plane (the
 *  same units `Cannonball.x` / `Cannonball.y` use). Returns 0 (ground)
 *  when nothing's there. */
export function surfaceAltitudeAt(
  state: GameState,
  worldX: number,
  worldY: number,
  opts?: SurfaceQueryOpts,
): number {
  const col = Math.floor(worldX / TILE_SIZE);
  const row = Math.floor(worldY / TILE_SIZE);
  if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return 0;

  const isTargetTile =
    opts?.target !== undefined &&
    opts.target.col === col &&
    opts.target.row === row;
  const filterShooter = opts?.shooterId !== undefined && !isTargetTile;
  const shooterId = opts?.shooterId;

  const key = row * GRID_COLS + col;
  for (const player of state.players) {
    if (filterShooter && player.id === shooterId) continue;
    if (player.walls.has(key)) return WALL_TOP_Y;
  }

  for (let index = 0; index < state.map.towers.length; index++) {
    const tower = state.map.towers[index]!;
    if (state.towerAlive[index] === false) continue;
    if (
      col >= tower.col &&
      col < tower.col + 2 &&
      row >= tower.row &&
      row < tower.row + 2
    )
      return TOWER_TOP_Y;
  }

  for (const player of state.players) {
    if (filterShooter && player.id === shooterId) continue;
    for (const cannon of player.cannons) {
      if (!isCannonAlive(cannon)) continue;
      if (isCannonTile(cannon, row, col)) return CANNON_TOP_Y;
    }
  }

  for (const house of state.map.houses) {
    if (!house.alive) continue;
    if (house.col === col && house.row === row) return HOUSE_TOP_Y;
  }

  for (const grunt of state.grunts) {
    if (grunt.col === col && grunt.row === row) return GRUNT_TOP_Y;
  }

  return 0;
}
