/**
 * Structured impact-tile classifier for battle metrics. Returns what sits at
 * an impact tile from the shooter's perspective as a tagged record
 * (`{ kind, ownerId? }`) — the structured sibling of the narrative observer's
 * display-string `identifyImpactTile`. The battle-metrics observer uses it to
 * bucket every shot's outcome (own-wall / enemy-wall / immune-tower / debris /
 * grunt / house / empty / …). Pure read over GameState; no mutation.
 *
 * Ordering matters: cannon (2×2/3×3 footprint) and tower (2×2) are checked
 * before single-tile wall/terrain so a wall ring around a tower never masks
 * the tower hit.
 */

import { isCannonAlive } from "../src/shared/core/battle-types.ts";
import { GRID_COLS, GRID_ROWS } from "../src/shared/core/grid.ts";
import {
  hasPitAt,
  isAtTile,
  isCannonTile,
  isGrass,
  isTowerTile,
  packTile,
} from "../src/shared/core/spatial.ts";
import type { GameState } from "../src/shared/core/types.ts";

export type ImpactKind = (typeof IMPACT)[keyof typeof IMPACT];

export interface ImpactInfo {
  kind: ImpactKind;
  /** Owner slot of the struck wall / cannon / tower. Undefined for terrain,
   *  grunts, houses, and off-map. "Own" vs "enemy" is already encoded in
   *  `kind` (from the shooter's effective-control perspective). */
  ownerId?: number;
}

export const IMPACT = {
  OFF_MAP: "off_map",
  OWN_WALL: "own_wall",
  ENEMY_WALL: "enemy_wall",
  OWN_CANNON: "own_cannon",
  ENEMY_CANNON: "enemy_cannon",
  DEBRIS: "debris",
  OWN_TOWER: "own_tower",
  ENEMY_TOWER: "enemy_tower",
  NEUTRAL_TOWER: "neutral_tower",
  GRUNT: "grunt",
  HOUSE: "house",
  PIT: "pit",
  ICE: "ice",
  GRASS: "grass",
  WATER: "water",
} as const;

/** Classify the impact tile from `shooterId`'s perspective. "Own" cannons
 *  include cannons the shooter has captured; a shooter's own cannon that an
 *  enemy has captured reads as ENEMY_CANNON (effective control, not original
 *  ownership) — mirrors the narrative observer's `identifyImpactTile`. */
export function classifyImpact(
  state: GameState,
  row: number,
  col: number,
  shooterId: number,
): ImpactInfo {
  if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
    return { kind: IMPACT.OFF_MAP };
  }
  for (let pid = 0; pid < state.players.length; pid++) {
    const player = state.players[pid]!;
    for (const cannon of player.cannons) {
      if (!isCannonTile(cannon, row, col)) continue;
      if (!isCannonAlive(cannon)) return { kind: IMPACT.DEBRIS, ownerId: pid };
      const capturedByShooter = state.capturedCannons.some(
        (cap) => cap.cannon === cannon && cap.capturerId === shooterId,
      );
      if (capturedByShooter) return { kind: IMPACT.OWN_CANNON, ownerId: pid };
      if (pid === shooterId) {
        const enemyCapture = state.capturedCannons.some(
          (cap) => cap.cannon === cannon && cap.capturerId !== shooterId,
        );
        return enemyCapture
          ? { kind: IMPACT.ENEMY_CANNON, ownerId: pid }
          : { kind: IMPACT.OWN_CANNON, ownerId: pid };
      }
      return { kind: IMPACT.ENEMY_CANNON, ownerId: pid };
    }
  }
  for (const tower of state.map.towers) {
    if (!isTowerTile(tower, row, col)) continue;
    const owner = state.players.find((player) =>
      player.enclosedTowers.some((owned) => owned.index === tower.index),
    );
    if (!owner) return { kind: IMPACT.NEUTRAL_TOWER };
    return owner.id === shooterId
      ? { kind: IMPACT.OWN_TOWER, ownerId: owner.id }
      : { kind: IMPACT.ENEMY_TOWER, ownerId: owner.id };
  }
  const key = packTile(row, col);
  for (let pid = 0; pid < state.players.length; pid++) {
    if (!state.players[pid]!.walls.has(key)) continue;
    return pid === shooterId
      ? { kind: IMPACT.OWN_WALL, ownerId: pid }
      : { kind: IMPACT.ENEMY_WALL, ownerId: pid };
  }
  if (state.grunts.some((grunt) => isAtTile(grunt, row, col))) {
    return { kind: IMPACT.GRUNT };
  }
  if (
    state.map.houses.some(
      (house) => house.alive && house.row === row && house.col === col,
    )
  ) {
    return { kind: IMPACT.HOUSE };
  }
  if (hasPitAt(state.burningPits, row, col)) return { kind: IMPACT.PIT };
  if (state.modern?.frozenTiles?.has(key)) return { kind: IMPACT.ICE };
  if (isGrass(state.map.tiles, row, col)) return { kind: IMPACT.GRASS };
  return { kind: IMPACT.WATER };
}
