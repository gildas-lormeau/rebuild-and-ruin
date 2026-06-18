/**
 * AI tactic — structural hit. Find single (or two-tile fallback) wall
 * removals that breach 2+ large enclosures simultaneously. Heavier
 * analysis than the other tactics: simulates wall removal and re-floods.
 */

import type { GameMap, TilePos } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import {
  computeOutside,
  DIRS_4,
  DIRS_8,
  inBounds,
  isGrass,
  orderByNearest,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BattleViewState } from "../shared/core/system-interfaces.ts";
import { filterActiveEnemies } from "../shared/sim/board-occupancy.ts";
import {
  countBrokenEnclosures,
  DESTROY_POCKET_MAX_SIZE,
  findEnclosureComponents,
} from "./ai-strategy-battle.ts";

type StructuralHitCandidate = {
  tiles: TilePos[];
  enclosuresBroken: number;
};

/** Bound on `computeOutside` floods per enemy, shared across the single-tile
 *  pass and the pair fallback (sibling plans cap floods the same way —
 *  wall-demolition's MAX_SEED_ATTEMPTS, fat-breach's MAX_FLOODS). Higher than
 *  the siblings' 5 because candidates here are pre-gated (`bordered.size >= 2`
 *  — the wall must touch two distinct large enclosures), so each flood is a
 *  high-quality probe of a divider seam, not a random walk; the budget only
 *  exists to bound pathological maze layouts. */
const MAX_STRUCTURAL_FLOODS = 16;

/** Plan a structural hit: find 1–2 wall tiles whose removal breaks 2+ large
 *  enclosures simultaneously.  Analyses each enemy's wall layout, finds
 *  "outer-shell" wall tiles adjacent to the outside flood, and simulates
 *  removal to count how many enclosures would be breached.
 *  Falls back to 2-tile pairs when single-tile hits aren't available
 *  (thick walls).  Returns up to `maxHits` worth of targets, ordered by
 *  nearest-neighbor for chain execution. */
export function planStructuralHit(
  state: BattleViewState,
  playerId: ValidPlayerId,
  maxHits: number,
): TilePos[] | null {
  const enemies = filterActiveEnemies(state, playerId);
  const allHits: StructuralHitCandidate[] = [];

  for (const enemy of enemies) {
    if (enemy.walls.size === 0) continue;
    const hits = findStructuralHits(enemy.walls, state.map.tiles);
    for (const hit of hits) allHits.push(hit);
  }

  if (allHits.length === 0) return null;

  // Prioritize hits that break the most enclosures
  allHits.sort((a, b) => b.enclosuresBroken - a.enclosuresBroken);

  // Collect up to maxHits distinct opportunities (no overlapping tiles)
  const usedTiles = new Set<TileKey>();
  const targets: TilePos[] = [];
  let picked = 0;
  for (const hit of allHits) {
    if (picked >= maxHits) break;
    const overlaps = hit.tiles.some((tile) =>
      usedTiles.has(packTile(tile.row, tile.col)),
    );
    if (overlaps) continue;
    for (const tile of hit.tiles) {
      usedTiles.add(packTile(tile.row, tile.col));
      targets.push(tile);
    }
    picked++;
  }

  return targets.length > 0 ? orderByNearest(targets) : null;
}

/** Analyse a player's walls and find single- or double-tile removals that
 *  breach 2+ large enclosures at once.  Only enclosures larger than
 *  DESTROY_POCKET_MAX_SIZE are considered (smaller ones are pockets). */
function findStructuralHits(
  walls: ReadonlySet<TileKey>,
  mapTiles: GameMap["tiles"],
): StructuralHitCandidate[] {
  // 1. Compute outside and interior. Deliberate departure from the sibling
  //    planners (deny-enclosure, fat-breach, wall-demolition), which take the
  //    frozen build-time interior (getBattleInterior) and then filter out
  //    enclosures the live flood already breached. Deriving the interior LIVE
  //    here drops mid-battle-breached enclosures implicitly (a breach shrinks
  //    or removes the component), so no separate isEnclosureBroken pass is
  //    needed — and it stays a pure function of synced walls/map (parity-safe).
  const outside = computeOutside(walls);
  const interior = new Set<TileKey>();
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const key = packTile(row, col);
      if (!outside.has(key) && !walls.has(key) && isGrass(mapTiles, row, col)) {
        interior.add(key);
      }
    }
  }

  // 2. Connected components of interior (4-dir) — each is an enclosure
  const components = findEnclosureComponents(interior);

  // Only consider large enclosures (> DESTROY_POCKET_MAX_SIZE tiles)
  const large = components.filter(
    (comp) => comp.length > DESTROY_POCKET_MAX_SIZE,
  );
  if (large.length < 2) return [];

  // Label each interior tile with its large-enclosure index
  const labels = new Map<TileKey, number>();
  for (let idx = 0; idx < large.length; idx++) {
    for (const key of large[idx]!) labels.set(key, idx);
  }

  // 3. Find outer-shell walls (8-dir adjacent to outside)
  const outerWalls: TileKey[] = [];
  for (const wallKey of walls) {
    const { row, col } = unpackTile(wallKey);
    for (const [dr, dc] of DIRS_8) {
      const nr = row + dr;
      const nc = col + dc;
      if (inBounds(nr, nc) && outside.has(packTile(nr, nc))) {
        outerWalls.push(wallKey);
        break;
      }
    }
  }

  // 4. Single-tile structural hits; 5. two-tile pairs only when none exist.
  // Both passes draw from one shared flood budget.
  const budget = { floods: 0 };
  const hits = findSingleTileHits(walls, outerWalls, labels, large, budget);
  if (hits.length === 0) {
    hits.push(...findPairHits(walls, outerWalls, labels, large, budget));
  }
  return hits;
}

/** Single-tile pass: outer-shell walls bordering 2+ large enclosures,
 *  flood-validated against the shared budget. */
function findSingleTileHits(
  walls: ReadonlySet<TileKey>,
  outerWalls: readonly TileKey[],
  labels: ReadonlyMap<TileKey, number>,
  large: readonly (readonly TileKey[])[],
  budget: { floods: number },
): StructuralHitCandidate[] {
  const hits: StructuralHitCandidate[] = [];
  for (const wallKey of outerWalls) {
    if (budget.floods >= MAX_STRUCTURAL_FLOODS) return hits;
    const bordered = borderedEnclosures(wallKey, labels);
    if (bordered.size < 2) continue;

    const modWalls = new Set(walls);
    modWalls.delete(wallKey);
    budget.floods++;
    const broken = countBrokenEnclosures(modWalls, large);
    if (broken >= 2) {
      const { row, col } = unpackTile(wallKey);
      hits.push({ tiles: [{ row: row, col: col }], enclosuresBroken: broken });
    }
  }
  return hits;
}

/** Pair fallback for thick walls: adjacent wall pairs whose combined border
 *  spans 2+ large enclosures, flood-validated against the shared budget. */
function findPairHits(
  walls: ReadonlySet<TileKey>,
  outerWalls: readonly TileKey[],
  labels: ReadonlyMap<TileKey, number>,
  large: readonly (readonly TileKey[])[],
  budget: { floods: number },
): StructuralHitCandidate[] {
  const hits: StructuralHitCandidate[] = [];
  for (const wallKey of outerWalls) {
    const { row, col } = unpackTile(wallKey);
    for (const [dr, dc] of DIRS_4) {
      if (budget.floods >= MAX_STRUCTURAL_FLOODS) return hits;
      const nr = row + dr;
      const nc = col + dc;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      // Deduplicate pairs and ensure neighbor is also a wall
      if (!walls.has(neighborKey) || neighborKey <= wallKey) continue;

      const bordered = borderedEnclosuresPair(wallKey, neighborKey, labels);
      if (bordered.size < 2) continue;

      const modWalls = new Set(walls);
      modWalls.delete(wallKey);
      modWalls.delete(neighborKey);
      budget.floods++;
      const broken = countBrokenEnclosures(modWalls, large);
      if (broken >= 2) {
        const { row: nr2, col: nc2 } = unpackTile(neighborKey);
        hits.push({
          tiles: [
            { row: row, col: col },
            { row: nr2, col: nc2 },
          ],
          enclosuresBroken: broken,
        });
      }
    }
  }
  return hits;
}

/** Which large-enclosure indices does a pair of wall tiles border? (8-dir) */
function borderedEnclosuresPair(
  keyA: TileKey,
  keyB: TileKey,
  labels: ReadonlyMap<TileKey, number>,
): Set<number> {
  const result = borderedEnclosures(keyA, labels);
  for (const label of borderedEnclosures(keyB, labels)) result.add(label);
  return result;
}

/** Which large-enclosure indices does a wall tile border? (8-dir) */
function borderedEnclosures(
  wallKey: TileKey,
  labels: ReadonlyMap<TileKey, number>,
): Set<number> {
  const { row, col } = unpackTile(wallKey);
  const result = new Set<number>();
  for (const [dr, dc] of DIRS_8) {
    const nr = row + dr;
    const nc = col + dc;
    if (!inBounds(nr, nc)) continue;
    const label = labels.get(packTile(nr, nc));
    if (label !== undefined) result.add(label);
  }
  return result;
}
