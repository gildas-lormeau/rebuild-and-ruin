/**
 * AI Strategy — castle rectangle geometry and gap analysis.
 *
 * Contains castle rect computation, wall ring gap detection,
 * and tower scoring used during the build phase.
 */

import type { BurningPit } from "../shared/battle-types.ts";
import {
  hasCannonAt,
  hasEnemyWallAt,
  hasGruntAt,
  hasTowerAt,
} from "../shared/board-occupancy.ts";
import type { TileRect, Tower } from "../shared/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type Tile } from "../shared/grid.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { FreshInterior } from "../shared/player-types.ts";
import {
  DIRS_4,
  DIRS_8,
  DIRS_DIAG,
  hasPitAt,
  inBounds,
  isGrass,
  isTowerTile,
  isWater,
  manhattanDistance,
  packTile,
  towerReachesOutsideCardinal,
  unpackTile,
} from "../shared/spatial.ts";
import type { BuildViewState } from "../shared/system-interfaces.ts";

// Scoring weights for scoreBuildTowerTarget — tower ranking during build targeting.
/** Weight given to wall-ring completion progress when ranking towers to build. */
const TOWER_PROGRESS_WEIGHT = 100;
/** Score penalty applied to dead towers — prefer live towers but still consider dead ones. */
const DEAD_TOWER_PENALTY = 50;
/** Max penalty for a fully obstructed castle rect (grunts, pits, enemy walls). */
const OBSTRUCTION_PENALTY = 60;

/**
 * Compute the fillable gap set for a castle rect: find ring gaps, remove
 * unfillable tiles, and optionally add bank-plug gaps for water ring tiles.
 */
export function computeFillableGaps(
  rect: TileRect,
  walls: ReadonlySet<number>,
  interior: FreshInterior,
  state: BuildViewState,
  bankHugging: boolean,
): Set<number> {
  const gaps = findGapTiles(rect, walls);
  filterUnfillableGaps(gaps, state, interior);
  // Pit plugs always needed; water plugs only when bankHugging
  addBankPlugGaps(
    gaps,
    rect,
    walls,
    state.map.tiles,
    state.burningPits,
    bankHugging,
  );
  return gaps;
}

export function scoreBuildTowerTarget(
  tower: Tower,
  state: BuildViewState,
  player: { id: ValidPlayerSlot; walls: ReadonlySet<number> },
  currentRow: number,
  currentCol: number,
  castleMargin: number,
  bankHugging: boolean,
): { tower: Tower; score: number } {
  const rect = castleRect(
    tower,
    state.map.tiles,
    state.map.towers,
    castleMargin,
    !bankHugging,
  );

  const ringGaps = findGapTiles(rect, player.walls);
  const ringTotal = countRingTiles(rect);
  const progress = ringTotal > 0 ? (ringTotal - ringGaps.size) / ringTotal : 0;
  const distance = manhattanDistance(
    tower.row + 0.5,
    tower.col + 0.5,
    currentRow,
    currentCol,
  );
  const dead = !state.towerAlive[tower.index];

  const { obstructions, area } = countCastleRectObstructions(
    rect,
    state,
    player,
  );
  const obstructionRatio = area > 0 ? obstructions / area : 0;

  return {
    tower,
    score:
      progress * TOWER_PROGRESS_WEIGHT -
      distance -
      (dead ? DEAD_TOWER_PENALTY : 0) -
      obstructionRatio * OBSTRUCTION_PENALTY * (1 - progress),
  };
}

export function hasMeaningfulHomeRingGaps(
  homeTowerEnclosed: boolean,
  castle: TileRect & { tower: Tower },
  walls: ReadonlySet<number>,
  outside: ReadonlySet<number>,
  state: BuildViewState,
  interior: ReadonlySet<number>,
): boolean {
  if (!homeTowerEnclosed) return true;
  if (castle.top > castle.bottom || castle.left > castle.right) return false;

  // Verify with 4-dir BFS: if the tower can't reach outside orthogonally,
  // ring gaps are cosmetic and not worth pursuing.
  if (!towerReachesOutsideCardinal(castle.tower, walls, outside)) return false;

  const gaps = findGapTiles(castle, walls);
  filterUnfillableGaps(gaps, state, interior);
  return gaps.size > 0;
}

/** Remove gaps that can't be filled (non-grass, burning pit, cannon, tower, inside interior). */
export function filterUnfillableGaps(
  gaps: Set<number>,
  state: BuildViewState,
  interior?: ReadonlySet<number>,
): void {
  for (const key of gaps) {
    const { r, c } = unpackTile(key);
    if (
      !isGrass(state.map.tiles, r, c) ||
      hasPitAt(state.burningPits, r, c) ||
      hasCannonAt(state, r, c) ||
      hasTowerAt(state, r, c) ||
      (interior && interior.has(key))
    ) {
      gaps.delete(key);
    }
  }
}

/**
 * BFS to find a connected pocket of interior tiles starting from `startKey`.
 * Returns the array of tile keys in the pocket.
 */
export function floodPocket(
  startKey: number,
  visited: Set<number>,
  walls: ReadonlySet<number>,
  outside: ReadonlySet<number>,
): number[] {
  const pocket: number[] = [startKey];
  visited.add(startKey);
  for (let queueIndex = 0; queueIndex < pocket.length; queueIndex++) {
    const { r: pr, c: pc } = unpackTile(pocket[queueIndex]!);
    for (const [dr, dc] of DIRS_4) {
      const nr = pr + dr,
        nc = pc + dc;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      if (
        visited.has(neighborKey) ||
        outside.has(neighborKey) ||
        walls.has(neighborKey)
      )
        continue;
      visited.add(neighborKey);
      pocket.push(neighborKey);
    }
  }
  return pocket;
}

/**
 * Compute the set of "gap" tiles for a castle: positions on the wall ring
 * that are missing from walls, including diagonal leak plugs.
 */
export function findGapTiles(
  castle: TileRect,
  walls: ReadonlySet<number>,
): Set<number> {
  const gaps = new Set<number>();
  const wallTop = castle.top - 1;
  const wallBottom = castle.bottom + 1;
  const wallLeft = castle.left - 1;
  const wallRight = castle.right + 1;

  for (let r = wallTop; r <= wallBottom; r++) {
    for (let c = wallLeft; c <= wallRight; c++) {
      if (!inBounds(r, c)) continue;
      if (
        r >= castle.top &&
        r <= castle.bottom &&
        c >= castle.left &&
        c <= castle.right
      )
        continue;
      const key = packTile(r, c);
      if (!walls.has(key)) gaps.add(key);
    }
  }

  for (let r = wallTop - 1; r <= wallBottom + 1; r++) {
    for (let c = wallLeft - 1; c <= wallRight + 1; c++) {
      if (!inBounds(r, c)) continue;
      if (r >= wallTop && r <= wallBottom && c >= wallLeft && c <= wallRight)
        continue;
      const key = packTile(r, c);
      if (walls.has(key)) continue;
      for (const [dr, dc] of DIRS_DIAG) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < wallTop || nr > wallBottom || nc < wallLeft || nc > wallRight)
          continue;
        const neighborKey = packTile(nr, nc);
        if (walls.has(neighborKey)) continue;
        const key1 = packTile(r, nc);
        const key2 = packTile(nr, c);
        if (walls.has(key1) && walls.has(key2)) {
          gaps.add(key);
          gaps.add(neighborKey);
        }
      }
    }
  }

  return gaps;
}

/**
 * Compute the castle interior rectangle for a secondary tower.
 * Tries the given margin per side; shrinks sides that hit water or map edges and
 * shifts the rectangle away from the obstacle so the opposite side absorbs
 * the lost space, preserving interior area for super gun placement.
 */
export function castleRect(
  tower: Tower,
  tiles: readonly (readonly Tile[])[],
  towers: readonly Tower[],
  margin: number,
  shrinkCorners = true,
): TileRect {
  // Max margin a side can expand to before hitting water, map edge, or another tower.
  // The wall ring is 1 tile beyond interior, so the ring must stay on-map
  // (border tiles are flood-fill start points — they can't be interior).
  const maxMarginForSide = (
    base: number,
    direction: 1 | -1,
    gridSize: number,
    crossA: number,
    crossB: number,
    vertical: boolean,
  ): number => {
    for (let step = 1; step <= margin; step++) {
      const interior = base + direction * step;
      const ring = interior + direction;
      if (ring < 0 || ring >= gridSize) return step - 1;
      const crossLimit = vertical ? GRID_COLS : GRID_ROWS;
      for (const cross of [crossA, crossB]) {
        if (cross < 0 || cross >= crossLimit) continue;
        const iRow = vertical ? interior : cross;
        const iCol = vertical ? cross : interior;
        if (isWater(tiles, iRow, iCol)) return step - 1;
        // Also check the ring tile — walls are placed there
        const rRow = vertical ? ring : cross;
        const rCol = vertical ? cross : ring;
        if (isWater(tiles, rRow, rCol)) return step - 1;
      }
      for (const other of towers) {
        if (other === tower) continue;
        // Check both interior and ring lines for tower collisions
        for (const line of [interior, ring]) {
          const hitA = vertical
            ? isTowerTile(other, line, crossA)
            : isTowerTile(other, crossA, line);
          const hitB = vertical
            ? isTowerTile(other, line, crossB)
            : isTowerTile(other, crossB, line);
          if (hitA || hitB) return step - 1;
        }
      }
    }
    return margin;
  };

  // Per-side max before obstacle
  const capTop = maxMarginForSide(
    tower.row,
    -1,
    GRID_ROWS,
    tower.col,
    tower.col + 1,
    true,
  );
  const capBottom = maxMarginForSide(
    tower.row + 1,
    1,
    GRID_ROWS,
    tower.col,
    tower.col + 1,
    true,
  );
  const capLeft = maxMarginForSide(
    tower.col,
    -1,
    GRID_COLS,
    tower.row,
    tower.row + 1,
    false,
  );
  const capRight = maxMarginForSide(
    tower.col + 1,
    1,
    GRID_COLS,
    tower.row,
    tower.row + 1,
    false,
  );

  // For each axis, distribute margin per side. If one side is constrained,
  // shift the surplus to the opposite side (capped by its own limit).
  const distribute = (
    capBefore: number,
    capAfter: number,
  ): [number, number] => {
    if (capBefore >= margin && capAfter >= margin) return [margin, margin];
    const before = Math.min(margin, capBefore);
    const after = Math.min(capAfter, margin + (margin - before));
    const beforeFinal = Math.min(capBefore, margin + (margin - after));
    return [beforeFinal, after];
  };

  let [growthTop, growthBottom] = distribute(capTop, capBottom);
  let [growthLeft, growthRight] = distribute(capLeft, capRight);

  // When not bank-hugging, shrink sides whose ring corners land on water.
  // maxMarginForSide only samples the tower's columns/rows, missing diagonal
  // corners where two ring edges meet a stepped bank.
  if (shrinkCorners) {
    [growthTop, growthBottom, growthLeft, growthRight] = shrinkCornersForWater(
      tower,
      growthTop,
      growthBottom,
      growthLeft,
      growthRight,
      tiles,
    );
  }

  // Return interior bounds — wall ring is one tile outside these bounds.
  return {
    top: tower.row - growthTop,
    bottom: tower.row + 1 + growthBottom,
    left: tower.col - growthLeft,
    right: tower.col + 1 + growthRight,
  };
}

/** Shrink growth values when ring corners land on water tiles.
 *  Iterates up to 3 passes; each pass shrinks whichever side is longer
 *  (preferring to keep the rect balanced). Returns updated growths. */
function shrinkCornersForWater(
  tower: Tower,
  growthTop: number,
  growthBottom: number,
  growthLeft: number,
  growthRight: number,
  tiles: readonly (readonly Tile[])[],
): [number, number, number, number] {
  for (let pass = 0; pass < 3; pass++) {
    const rTop = tower.row - growthTop - 1;
    const rBot = tower.row + 1 + growthBottom + 1;
    const rLeft = tower.col - growthLeft - 1;
    const rRight = tower.col + 1 + growthRight + 1;
    let shrunk = false;
    if (rTop >= 0 && rLeft >= 0 && isWater(tiles, rTop, rLeft)) {
      if (growthTop >= growthLeft && growthTop > 0) {
        growthTop--;
        shrunk = true;
      } else if (growthLeft > 0) {
        growthLeft--;
        shrunk = true;
      }
    }
    if (rTop >= 0 && rRight < GRID_COLS && isWater(tiles, rTop, rRight)) {
      if (growthTop >= growthRight && growthTop > 0) {
        growthTop--;
        shrunk = true;
      } else if (growthRight > 0) {
        growthRight--;
        shrunk = true;
      }
    }
    if (rBot < GRID_ROWS && rLeft >= 0 && isWater(tiles, rBot, rLeft)) {
      if (growthBottom >= growthLeft && growthBottom > 0) {
        growthBottom--;
        shrunk = true;
      } else if (growthLeft > 0) {
        growthLeft--;
        shrunk = true;
      }
    }
    if (
      rBot < GRID_ROWS &&
      rRight < GRID_COLS &&
      isWater(tiles, rBot, rRight)
    ) {
      if (growthBottom >= growthRight && growthBottom > 0) {
        growthBottom--;
        shrunk = true;
      } else if (growthRight > 0) {
        growthRight--;
        shrunk = true;
      }
    }
    if (!shrunk) break;
  }
  return [growthTop, growthBottom, growthLeft, growthRight];
}

/**
 * When a ring gap is unfillable (water or burning pit), the 8-dir flood can
 * still leak through it diagonally into the rect interior.  Add "plug" gaps —
 * grass tiles just inside the rect that, once walled, seal the diagonal leak.
 */
function addBankPlugGaps(
  gaps: Set<number>,
  rect: TileRect,
  walls: ReadonlySet<number>,
  tiles: readonly (readonly Tile[])[],
  burningPits?: readonly BurningPit[],
  includeWater = true,
): void {
  const ringTop = rect.top - 1,
    ringBot = rect.bottom + 1;
  const ringLeft = rect.left - 1,
    ringRight = rect.right + 1;
  // Find unfillable tiles on the ring (water and/or burning pits)
  const unfillableRing: number[] = [];
  for (let r = ringTop; r <= ringBot; r++) {
    for (let c = ringLeft; c <= ringRight; c++) {
      if (!inBounds(r, c)) continue;
      // Only ring tiles (not interior)
      if (r > ringTop && r < ringBot && c > ringLeft && c < ringRight) continue;
      const key = packTile(r, c);
      if (walls.has(key)) continue;
      const onWater = includeWater && isWater(tiles, r, c);
      const onPit = burningPits != null && hasPitAt(burningPits, r, c);
      if (onWater || onPit) {
        unfillableRing.push(key);
      }
    }
  }
  // For each unfillable ring tile, add interior-facing grass neighbors as plug gaps
  for (const wallKey of unfillableRing) {
    const { r: wr, c: wc } = unpackTile(wallKey);
    for (const [dr, dc] of DIRS_8) {
      const nr = wr + dr,
        nc = wc + dc;
      // Only add tiles inside the rect (not on the ring itself)
      if (
        nr < rect.top ||
        nr > rect.bottom ||
        nc < rect.left ||
        nc > rect.right
      )
        continue;
      const neighborKey = packTile(nr, nc);
      if (walls.has(neighborKey)) continue;
      if (!isGrass(tiles, nr, nc)) continue;
      gaps.add(neighborKey);
    }
  }
}

/**
 * Count total ring tile positions for a castle rect (tiles on the 1-wide
 * perimeter just outside the rect, within map bounds).
 */
function countRingTiles(rect: TileRect): number {
  let count = 0;
  for (let r = rect.top - 1; r <= rect.bottom + 1; r++) {
    for (let c = rect.left - 1; c <= rect.right + 1; c++) {
      if (!inBounds(r, c)) continue;
      if (
        r >= rect.top &&
        r <= rect.bottom &&
        c >= rect.left &&
        c <= rect.right
      )
        continue;
      count++;
    }
  }
  return count;
}

function countCastleRectObstructions(
  rect: TileRect,
  state: BuildViewState,
  player: { id: ValidPlayerSlot; walls: ReadonlySet<number> },
): { obstructions: number; area: number } {
  let obstructions = 0;
  const rTop = rect.top - 1;
  const rBot = rect.bottom + 1;
  const rLeft = rect.left - 1;
  const rRight = rect.right + 1;
  for (let r = rTop; r <= rBot; r++) {
    for (let c = rLeft; c <= rRight; c++) {
      if (!inBounds(r, c)) continue;
      const key = packTile(r, c);
      if (player.walls.has(key)) continue;
      if (hasGruntAt(state.grunts, r, c)) {
        obstructions++;
        continue;
      }
      if (hasPitAt(state.burningPits, r, c)) {
        obstructions++;
        continue;
      }
      if (hasEnemyWallAt(state, player.id, r, c)) {
        obstructions++;
        continue;
      }
      if (hasCannonAt(state, r, c)) {
        obstructions++;
        continue;
      }
    }
  }

  const area = (rBot - rTop + 1) * (rRight - rLeft + 1);
  return { obstructions, area };
}
