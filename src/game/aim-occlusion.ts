/**
 * Aim-occlusion: the sim-side, deterministic twin of the renderer's crosshair
 * pick (`render/3d/elevation.ts` `pickHitWorld`). AI/assisted controllers pick
 * targets in tile-space; this snaps that aim onto a nearer camera-side occluder
 * exactly as the human pointer pick would, so they can't hit a tile a human
 * couldn't see. Reads the FIXED battle pitch + GameState heights (never the
 * live, per-peer camera), so AI fire stays identical across host / watcher.
 */

import { aliveCannons } from "../shared/core/battle-types.ts";
import {
  BATTLE_TILT_PITCH_RAD,
  CANNON_TOP_Y,
  GRUNT_TOP_Y,
  HOUSE_TOP_Y,
  TOWER_TOP_Y,
  WALL_TOP_Y,
} from "../shared/core/elevation-constants.ts";
import type { WorldPos } from "../shared/core/geometry-types.ts";
import { TILE_SIZE } from "../shared/core/grid.ts";
import { rayWalkOccluder } from "../shared/core/occlusion.ts";
import {
  isAtTile,
  isCannonTile,
  isTowerTile,
  packTile,
  pxToTile,
  tileCenterPx,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";

/** How many tiles toward the camera to probe for an occluder. The tallest
 *  modelled obstacle (TOWER_TOP_Y) projects ~2 tiles under the battle
 *  pitch; 4 gives margin without walking the whole column. Mirrors
 *  `pickHitWorld`'s `maxLookback`. */
const AIM_OCCLUSION_LOOKBACK = 4;

/** World-pixel form of `occludedAimTile`, shaped as an `AimResolver` for the
 *  AI controller's `aim()` seam: takes a world-px aim point, snaps it through
 *  the occlusion model, and returns the occluded world position. When nothing
 *  occludes the target the input point is returned verbatim (preserving any
 *  sub-tile aim precision); when occluded it returns the occluder tile's
 *  center. Camera-independent (fixed pitch + GameState) — safe for AI parity. */
export function occludedAimWorld(
  state: BattleViewState,
  wx: number,
  wy: number,
): WorldPos {
  const row = pxToTile(wy);
  const col = pxToTile(wx);
  const snapped = occludedAimTile(state, row, col);
  if (snapped.row === row && snapped.col === col) return { wx, wy };
  const center = tileCenterPx(snapped.row, snapped.col);
  return { wx: center.x, wy: center.y };
}

/** True when an aim at `(row, col)` lands on that exact tile — i.e. no taller
 *  camera-near obstacle hides it under the battle tilt. Lets target SELECTION
 *  skip tiles the aim seam would only redirect onto an occluder (e.g. a grunt
 *  hidden behind a wall). Camera-independent (fixed pitch + GameState), so it's
 *  safe to consult from the mirror-simulated AI strategy. */
export function aimReachesTile(
  state: BattleViewState,
  row: number,
  col: number,
): boolean {
  const snapped = occludedAimTile(state, row, col);
  return snapped.row === row && snapped.col === col;
}

/** True when aiming at `(row, col)` would only redirect the shot onto a TOWER
 *  under the battle tilt — an unconditionally wasted shot, since towers are
 *  cannonball-invulnerable (only grunts kill them). Standard target SELECTION
 *  uses this to skip an enemy wall hidden behind a tower: the aim seam would
 *  snap the crosshair onto that tower, so no cannon could ever land the shot on
 *  the wall. A WALL occluder is deliberately NOT rejected — the redirected shot
 *  still damages a wall, a useful (if imprecise) hit. Camera-independent (fixed
 *  pitch + GameState), so it's parity-safe for the mirror-simulated AI. */
export function aimRedirectsOntoTower(
  state: BattleViewState,
  row: number,
  col: number,
): boolean {
  const snapped = occludedAimTile(state, row, col);
  if (snapped.row === row && snapped.col === col) return false;
  // The crosshair snapped onto a nearer occluder; it's a wasted shot only when
  // that occluder is a tower (cannonball-invulnerable). `visualTopAt` returns
  // TOWER_TOP_Y exactly for an alive tower (the tallest obstacle), so reuse it
  // rather than a separate occupancy query (no new same-layer import edge).
  return visualTopAt(state, snapped.row, snapped.col) === TOWER_TOP_Y;
}

/** The tile a controller's crosshair would actually land on when aiming at
 *  `(row, col)` under the battle camera tilt. If a taller obstacle sits on
 *  the camera-near side and visually occludes the target, returns that
 *  occluder's tile (the crosshair snaps onto it); otherwise returns the
 *  target unchanged. Deterministic — fixed pitch + GameState only.
 *  Internal: callers use the `AimResolver`-shaped `occludedAimWorld`. */
function occludedAimTile(
  state: BattleViewState,
  row: number,
  col: number,
): { row: number; col: number } {
  const groundY = (row + 0.5) * TILE_SIZE;
  // Walk from the camera-near side back toward the target; the first tile
  // whose elevated top the sight-ray crosses is the occluder. The snapped
  // world-Y is where the lifted sight-ray meets that top (matches the
  // renderer pick's `wy = groundY + h·tan(pitch)` → `pxToTile`). The target's
  // own top is passed so only obstacles TALLER than it occlude — an
  // equal-height neighbour (wall behind wall, cannon behind cannon) leaves
  // the target's top visible and is correctly not an occluder.
  const occludedY = rayWalkOccluder(
    groundY,
    col,
    BATTLE_TILT_PITCH_RAD,
    (probeRow) => visualTopAt(state, probeRow, col),
    AIM_OCCLUSION_LOOKBACK,
    visualTopAt(state, row, col),
  );
  if (occludedY === null) return { row, col };
  return { row: pxToTile(occludedY), col };
}

/** Top-Y of the tallest occupant at `(row, col)` for *visual* occlusion —
 *  shooter-agnostic (every wall / cannon blocks line of sight, even your
 *  own) and live towers count. The sim-state mirror of the renderer's
 *  `targetTopAt`. Returns 0 for open ground. */
function visualTopAt(state: BattleViewState, row: number, col: number): number {
  const key = packTile(row, col);
  for (const player of state.players) {
    if (player.walls.has(key)) return WALL_TOP_Y;
  }
  for (let towerIdx = 0; towerIdx < state.map.towers.length; towerIdx++) {
    if (state.towerAlive[towerIdx] === false) continue;
    if (isTowerTile(state.map.towers[towerIdx]!, row, col)) return TOWER_TOP_Y;
  }
  for (const player of state.players) {
    for (const cannon of aliveCannons(player.cannons)) {
      if (isCannonTile(cannon, row, col)) return CANNON_TOP_Y;
    }
  }
  for (const house of state.map.houses) {
    if (house.alive && isAtTile(house, row, col)) return HOUSE_TOP_Y;
  }
  for (const grunt of state.grunts) {
    if (isAtTile(grunt, row, col)) return GRUNT_TOP_Y;
  }
  return 0;
}
