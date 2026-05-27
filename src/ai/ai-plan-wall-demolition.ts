/**
 * AI tactic — wall demolition. Pick a random enemy with enough walls,
 * grow a connected wall segment via random 4-dir walk, and chain-fire
 * a slice of it within the usable-cannon budget.
 */

import {
  filterActiveEnemies,
  getBattleInterior,
} from "../shared/core/board-occupancy.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  DIRS_4,
  inBounds,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import {
  countBrokenEnclosures,
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
} from "./ai-strategy-battle.ts";

/** Minimum connected wall tiles needed to start a wall demolition run. */
const MIN_WALL_SEGMENT_LENGTH = 4;
/** Maximum wall tiles targeted in a single wall demolition chain. */
const MAX_WALL_DEMOLITION_TARGETS = 10;
/** Random-seed retry budget per enemy when an evaluated segment would
 *  breach no large enclosure. Keeps cost bounded — each retry runs one
 *  computeOutside flood. Five matches the empirical observation that the
 *  first useful seed is usually within the first few picks; pushing higher
 *  costs more without finding new wins (a fully-edge-walled enemy returns
 *  null past this budget, and the cascade falls through to super-attack
 *  / per-shot dispatch). */
const MAX_SEED_ATTEMPTS = 5;

/** Plan a wall demolition run: find connected enemy wall segment whose
 *  removal would actually breach a large enclosure. Segments that touch
 *  nothing (e.g. map-edge walls bounding no interior) are rejected and
 *  the planner retries with a new random seed up to MAX_SEED_ATTEMPTS
 *  per enemy. Enemies with no large enclosures (all-pocket interior or
 *  already fully exposed) are skipped entirely. */
export function planWallDemolition(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  rng.shuffle(enemies);
  for (const enemy of enemies) {
    if (enemy.walls.size < MIN_WALL_SEGMENT_LENGTH) continue;
    const interior = getBattleInterior(enemy);
    const largeEnclosures = findEnclosureComponents(interior).filter(
      (comp) => comp.length > DESTROY_POCKET_MAX_SIZE,
    );
    if (largeEnclosures.length === 0) continue;
    const wallKeys = [...enemy.walls];
    let segment: TileKey[] | undefined;
    for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt++) {
      const startKey = rng.pick(wallKeys);
      const candidate = findConnectedWalls(
        enemy.walls,
        startKey,
        usableCannonCount,
        rng,
      );
      if (candidate.length < MIN_WALL_SEGMENT_LENGTH) continue;
      const modWalls = new Set(enemy.walls);
      for (const tile of candidate) modWalls.delete(tile);
      if (countBrokenEnclosures(modWalls, largeEnclosures) > 0) {
        segment = candidate;
        break;
      }
    }
    if (segment === undefined) continue;
    const maxLength = Math.min(
      segment.length,
      usableCannonCount,
      MAX_WALL_DEMOLITION_TARGETS,
    );
    const length = rng.int(MIN_WALL_SEGMENT_LENGTH, maxLength);
    return segment.slice(0, length).map((k) => {
      const { row, col } = unpackTile(k);
      return { row: row, col: col };
    });
  }
  return null;
}

/** Random walk to find up to maxLength connected wall tiles. */
function findConnectedWalls(
  walls: ReadonlySet<TileKey>,
  startKey: TileKey,
  maxLength: number,
  rng: Rng,
): TileKey[] {
  const visited = new Set<TileKey>();
  visited.add(startKey);
  const result: TileKey[] = [startKey];
  let current = startKey;
  while (result.length < maxLength) {
    const { row, col } = unpackTile(current);
    const neighbors: TileKey[] = [];
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      if (!visited.has(neighborKey) && walls.has(neighborKey))
        neighbors.push(neighborKey);
    }
    if (neighbors.length === 0) break;
    current = rng.pick(neighbors);
    visited.add(current);
    result.push(current);
  }
  return result;
}
