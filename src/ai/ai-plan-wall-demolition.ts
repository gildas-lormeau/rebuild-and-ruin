/**
 * AI tactic — wall demolition. Pick a random enemy with enough walls,
 * grow a connected wall segment via random 4-dir walk, and chain-fire
 * a slice of it within the usable-cannon budget.
 */

import type { TilePos } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  computeOutside,
  DIRS_4,
  inBounds,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import type { Rng } from "../shared/platform/rng.ts";
import {
  filterActiveEnemies,
  getBattleInterior,
} from "../shared/sim/board-occupancy.ts";
import {
  componentHoldsTower,
  countBrokenEnclosures,
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
  isEnclosureBroken,
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
 *  removal would actually breach a STILL-INTACT large enclosure. The random
 *  length draw and the optional stride (super attack) are applied BEFORE the
 *  flood validation, so the set that validates is exactly the set that gets
 *  fired — validating the full walk and then slicing a random prefix could
 *  drop the very tiles that produced the breach. Already-breached enclosures
 *  are filtered out up front (the flood reaches them whatever the candidate
 *  is, which made any segment "validate" on mid-battle re-plans). Failed
 *  candidates retry with a new random seed up to MAX_SEED_ATTEMPTS per
 *  enemy; enemies with no intact large enclosures are skipped entirely. */
export function planWallDemolition(
  state: BattleViewState,
  playerId: ValidPlayerId,
  usableCannonCount: number,
  rng: Rng,
  stride = 1,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  rng.shuffle(enemies);
  for (const enemy of enemies) {
    if (enemy.walls.size < MIN_WALL_SEGMENT_LENGTH) continue;
    const interior = getBattleInterior(enemy);
    const liveOutside = computeOutside(enemy.walls);
    const targetEnclosures = findEnclosureComponents(interior)
      .filter(
        (comp) =>
          comp.length > DESTROY_POCKET_MAX_SIZE ||
          componentHoldsTower(comp, enemy),
      )
      .filter((comp) => !isEnclosureBroken(comp, liveOutside));
    if (targetEnclosures.length === 0) continue;
    const wallKeys = [...enemy.walls];
    for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt++) {
      const startKey = rng.pick(wallKeys);
      const candidate = findConnectedWalls(
        enemy.walls,
        startKey,
        usableCannonCount,
        rng,
      );
      if (candidate.length < MIN_WALL_SEGMENT_LENGTH) continue;
      const maxLength = Math.min(
        candidate.length,
        usableCannonCount,
        MAX_WALL_DEMOLITION_TARGETS,
      );
      const length = rng.int(MIN_WALL_SEGMENT_LENGTH, maxLength);
      const fired = candidate
        .slice(0, length)
        .filter((_, i) => i % stride === 0);
      const modWalls = new Set(enemy.walls);
      for (const tile of fired) modWalls.delete(tile);
      if (countBrokenEnclosures(modWalls, targetEnclosures) > 0) {
        return fired.map((k) => {
          const { row, col } = unpackTile(k);
          return { row: row, col: col };
        });
      }
    }
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
