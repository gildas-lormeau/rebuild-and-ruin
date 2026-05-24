/**
 * AI Strategy — castle rectangle geometry and gap analysis.
 * Contains castle rect computation, wall ring gap detection,
 * and tower scoring used during the build phase. `tower.row +
 * TOWER_SIZE - 1` / `tower.col + TOWER_SIZE - 1` reach the
 * bottom-right corner of the tower's footprint.
 */

import {
  hasAliveHouseAt,
  hasEnemyWallAt,
  hasGruntAt,
} from "../shared/core/board-occupancy.ts";
import { TOWER_SIZE } from "../shared/core/game-constants.ts";
import type { TileRect, Tower } from "../shared/core/geometry-types.ts";
import {
  GRID_COLS,
  GRID_ROWS,
  type Tile,
  type TileKey,
} from "../shared/core/grid.ts";
import { hasCannonAt, hasTowerAt } from "../shared/core/occupancy-queries.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { FreshInterior } from "../shared/core/player-types.ts";
import {
  computeOutside,
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
} from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";

interface MarginCtx {
  readonly margin: number;
  readonly tiles: readonly (readonly Tile[])[];
  readonly towers: readonly Tower[];
  readonly self: Tower;
}

// Scoring weights for scoreBuildTowerTarget — tower ranking during build targeting.
/** Weight given to wall-ring completion progress when ranking towers to build. */
const TOWER_PROGRESS_WEIGHT = 100;
/** Identify the real breach points in the player's wall ring by scanning
 *  for short non-wall runs between paired walls — works regardless of
 *  whether the ring is rectangular or stair-stepped, and catches holes
 *  inside the bounding box that the perimeter-only findGapTiles can't see.
 *  K_HOLE = max width of a closeable gap (1-tile, 2-tile, or 3-tile holes). */
const HOLE_MAX_WIDTH = 3;
/** Score penalty applied to dead towers — prefer live towers but still consider dead ones. */
const DEAD_TOWER_PENALTY = 50;
/** Max penalty for a fully obstructed castle rect (grunts, pits, enemy walls). */
const OBSTRUCTION_PENALTY = 60;

/**
 * Compute the fillable gap set for a castle rect: reachable ring gaps plus
 * bank/pit/house plug gaps for diagonal-leak sealing.
 */
export function computeFillableGaps(
  rect: TileRect,
  walls: ReadonlySet<TileKey>,
  interior: FreshInterior,
  state: BuildViewState,
  bankHugging: boolean,
): Set<TileKey> {
  const gaps = findReachableRingGaps(rect, walls, state, interior);
  // Pit and alive-house plugs always needed; water plugs only when bankHugging
  addBankPlugGaps(gaps, rect, walls, state, bankHugging);
  return gaps;
}

export function scoreBuildTowerTarget(
  tower: Tower,
  state: BuildViewState,
  player: { id: ValidPlayerId; walls: ReadonlySet<TileKey> },
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
  walls: ReadonlySet<TileKey>,
  outside: ReadonlySet<TileKey>,
  state: BuildViewState,
  interior: ReadonlySet<TileKey>,
): boolean {
  if (!homeTowerEnclosed) return true;
  if (castle.top > castle.bottom || castle.left > castle.right) return false;

  // Verify with 4-dir BFS: if the tower can't reach outside orthogonally,
  // ring gaps are cosmetic and not worth pursuing.
  if (!towerReachesOutsideCardinal(castle.tower, walls, outside)) return false;

  return findReachableRingGaps(castle, walls, state, interior).size > 0;
}

/**
 * Ring gaps reachable by some piece: `findGapTiles + filterUnfillableGaps`,
 * without the bank/pit plug step. Use this when a caller wants "real" gaps
 * to repair (no diagonal-leak plugs added). Use `computeFillableGaps` when
 * a placement target needs the plug seal too.
 */
export function findReachableRingGaps(
  rect: TileRect,
  walls: ReadonlySet<TileKey>,
  state: BuildViewState,
  interior: ReadonlySet<TileKey>,
): Set<TileKey> {
  const gaps = findGapTiles(rect, walls);
  filterUnfillableGaps(gaps, state, interior);
  return gaps;
}

/** Remove gaps that can't be filled (non-grass, burning pit, alive house,
 *  cannon, tower, inside interior). Alive house tiles are excluded because
 *  placing a wall on a house tile spawns a grunt instead of a wall — the
 *  ring gap doesn't actually close. */
export function filterUnfillableGaps(
  gaps: Set<TileKey>,
  state: BuildViewState,
  interior: ReadonlySet<TileKey>,
): void {
  for (const key of gaps) {
    const { row, col } = unpackTile(key);
    if (
      !isGrass(state.map.tiles, row, col) ||
      hasPitAt(state.burningPits, row, col) ||
      hasAliveHouseAt(state, row, col) ||
      hasCannonAt(state, row, col) ||
      hasTowerAt(state, row, col) ||
      interior.has(key)
    ) {
      gaps.delete(key);
    }
  }
}

/**
 * BFS to find a connected pocket of interior tiles starting from `startKey`.
 * Returns the array of tile keys in the pocket.
 *
 * When `sizeLimit` is set, the BFS stops once the pocket grows past the
 * limit. The returned array contains `sizeLimit + 1` tiles, signalling "at
 * least one tile beyond the limit." Unvisited tiles of an oversized pocket
 * remain unvisited — callers that need full grid coverage must not pass
 * `sizeLimit`.
 */
export function floodPocket(
  startKey: TileKey,
  visited: Set<TileKey>,
  walls: ReadonlySet<TileKey>,
  outside: ReadonlySet<TileKey>,
  sizeLimit?: number,
): TileKey[] {
  const pocket: TileKey[] = [startKey];
  visited.add(startKey);
  for (let queueIndex = 0; queueIndex < pocket.length; queueIndex++) {
    if (sizeLimit !== undefined && pocket.length > sizeLimit) break;
    const { row: pr, col: pc } = unpackTile(pocket[queueIndex]!);
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
  walls: ReadonlySet<TileKey>,
): Set<TileKey> {
  const gaps = new Set<TileKey>();
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
  shrinkCorners: boolean,
): TileRect {
  const ctx: MarginCtx = { margin, tiles, towers, self: tower };
  // Per-side max before obstacle
  const capTop = maxMarginForSide(
    ctx,
    tower.row,
    -1,
    GRID_ROWS,
    tower.col,
    tower.col + TOWER_SIZE - 1,
    true,
  );
  const capBottom = maxMarginForSide(
    ctx,
    tower.row + TOWER_SIZE - 1,
    1,
    GRID_ROWS,
    tower.col,
    tower.col + TOWER_SIZE - 1,
    true,
  );
  const capLeft = maxMarginForSide(
    ctx,
    tower.col,
    -1,
    GRID_COLS,
    tower.row,
    tower.row + TOWER_SIZE - 1,
    false,
  );
  const capRight = maxMarginForSide(
    ctx,
    tower.col + TOWER_SIZE - 1,
    1,
    GRID_COLS,
    tower.row,
    tower.row + TOWER_SIZE - 1,
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
    bottom: tower.row + TOWER_SIZE - 1 + growthBottom,
    left: tower.col - growthLeft,
    right: tower.col + TOWER_SIZE - 1 + growthRight,
  };
}

/** Identify real breach points by scanning for short non-wall runs between
 *  paired *ring* walls. A "ring wall" is a wall whose outer face touches the
 *  exterior — i.e. has at least one 4-dir neighbor in computeOutside. The
 *  ring-wall filter prevents the pair-scan from inventing pseudo-gaps
 *  between newly-placed walls inside the enclosure as the AI fills holes. */
export function findOuterRingHoles(
  walls: ReadonlySet<TileKey>,
  state: BuildViewState,
  interior: ReadonlySet<TileKey>,
): Set<TileKey> {
  const outside = computeOutside(walls);
  const isRingWall = (key: TileKey): boolean => {
    const { row, col } = unpackTile(key);
    for (const [dr, dc] of DIRS_4) {
      const nr = row + dr;
      const nc = col + dc;
      if (!inBounds(nr, nc)) continue;
      if (outside.has(packTile(nr, nc))) return true;
    }
    return false;
  };
  const holes = new Set<TileKey>();
  for (const wallKey of walls) {
    if (!isRingWall(wallKey)) continue;
    const { row: wr, col: wc } = unpackTile(wallKey);
    for (const [dr, dc] of DIRS_4) {
      for (let step = 2; step <= HOLE_MAX_WIDTH + 1; step++) {
        const nr = wr + dr * step;
        const nc = wc + dc * step;
        if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) break;
        let allFillable = true;
        for (let inner = 1; inner < step; inner++) {
          const ir = wr + dr * inner;
          const ic = wc + dc * inner;
          if (walls.has(packTile(ir, ic))) {
            allFillable = false;
            break;
          }
          if (
            !isGrass(state.map.tiles, ir, ic) ||
            hasPitAt(state.burningPits, ir, ic) ||
            hasAliveHouseAt(state, ir, ic) ||
            interior.has(packTile(ir, ic))
          ) {
            allFillable = false;
            break;
          }
        }
        if (!allFillable) continue;
        const farKey = packTile(nr, nc);
        if (walls.has(farKey) && isRingWall(farKey)) {
          for (let inner = 1; inner < step; inner++) {
            holes.add(packTile(wr + dr * inner, wc + dc * inner));
          }
          break;
        }
      }
    }
  }
  return holes;
}

/** Max margin a side can expand to before hitting water, map edge, or another
 *  tower. The wall ring is 1 tile beyond interior, so the ring must stay
 *  on-map (border tiles are flood-fill start points — they can't be interior). */
function maxMarginForSide(
  ctx: MarginCtx,
  base: number,
  direction: 1 | -1,
  gridSize: number,
  crossA: number,
  crossB: number,
  vertical: boolean,
): number {
  for (let step = 1; step <= ctx.margin; step++) {
    if (
      stepBlocksMargin(
        ctx,
        base,
        direction,
        step,
        gridSize,
        crossA,
        crossB,
        vertical,
      )
    ) {
      return step - 1;
    }
  }
  return ctx.margin;
}

/** True iff extending one more step would cross the map edge, hit water on
 *  either the interior or wall-ring tile, or collide with another tower. */
function stepBlocksMargin(
  ctx: MarginCtx,
  base: number,
  direction: 1 | -1,
  step: number,
  gridSize: number,
  crossA: number,
  crossB: number,
  vertical: boolean,
): boolean {
  const interior = base + direction * step;
  const ring = interior + direction;
  if (ring < 0 || ring >= gridSize) return true;
  const crossLimit = vertical ? GRID_COLS : GRID_ROWS;
  for (const cross of [crossA, crossB]) {
    if (cross < 0 || cross >= crossLimit) continue;
    const [iRow, iCol] = cellAt(interior, cross, vertical);
    if (isWater(ctx.tiles, iRow, iCol)) return true;
    const [rRow, rCol] = cellAt(ring, cross, vertical);
    if (isWater(ctx.tiles, rRow, rCol)) return true;
  }
  for (const other of ctx.towers) {
    if (other === ctx.self) continue;
    for (const line of [interior, ring]) {
      const [aRow, aCol] = cellAt(line, crossA, vertical);
      const [bRow, bCol] = cellAt(line, crossB, vertical);
      if (isTowerTile(other, aRow, aCol) || isTowerTile(other, bRow, bCol)) {
        return true;
      }
    }
  }
  return false;
}

/** Project a (line, cross) pair onto (row, col) based on axis. With `vertical`,
 *  the line varies along rows; otherwise along cols. */
function cellAt(
  line: number,
  cross: number,
  vertical: boolean,
): readonly [number, number] {
  return vertical ? [line, cross] : [cross, line];
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
    const rBot = tower.row + TOWER_SIZE - 1 + growthBottom + 1;
    const rLeft = tower.col - growthLeft - 1;
    const rRight = tower.col + TOWER_SIZE - 1 + growthRight + 1;
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
 * When a ring gap is unfillable (water, burning pit, or alive house), the
 * 8-dir flood can still leak through it diagonally into the rect interior.
 * Add "plug" gaps — grass tiles just inside the rect that, once walled, seal
 * the diagonal leak. Houses don't block flood-fill (only walls/cannons/towers
 * do), and a wall placed on a house tile spawns a grunt instead of a wall,
 * so houses leak diagonally the same way pits do.
 */
function addBankPlugGaps(
  gaps: Set<TileKey>,
  rect: TileRect,
  walls: ReadonlySet<TileKey>,
  state: BuildViewState,
  includeWater = true,
): void {
  const ringTop = rect.top - 1,
    ringBot = rect.bottom + 1;
  const ringLeft = rect.left - 1,
    ringRight = rect.right + 1;
  const unfillableRing: TileKey[] = [];
  const tiles = state.map.tiles;
  for (let r = ringTop; r <= ringBot; r++) {
    for (let c = ringLeft; c <= ringRight; c++) {
      if (!inBounds(r, c)) continue;
      // Only ring tiles (not interior)
      if (r > ringTop && r < ringBot && c > ringLeft && c < ringRight) continue;
      const key = packTile(r, c);
      if (walls.has(key)) continue;
      const onWater = includeWater && isWater(tiles, r, c);
      const onPit = hasPitAt(state.burningPits, r, c);
      const onHouse = hasAliveHouseAt(state, r, c);
      if (onWater || onPit || onHouse) {
        unfillableRing.push(key);
      }
    }
  }
  addInteriorPlugGaps(gaps, unfillableRing, rect, walls, tiles);
}

/**
 * Add interior-facing grass neighbors of each `sourceTile` as plug gaps —
 * a single 8-dir step from each source, staying inside `rect`, skipping
 * walls and non-grass tiles. Seals diagonal flood-fill leaks both at
 * bank/pit ring gaps (`addBankPlugGaps`) and at interior unreachable gaps
 * (`plugUnreachableGaps` in ai-build-target.ts).
 */
export function addInteriorPlugGaps(
  gaps: Set<TileKey>,
  sourceTiles: Iterable<TileKey>,
  rect: TileRect,
  walls: ReadonlySet<TileKey>,
  tiles: readonly (readonly Tile[])[],
): void {
  for (const sourceKey of sourceTiles) {
    const { row: sr, col: sc } = unpackTile(sourceKey);
    for (const [dr, dc] of DIRS_8) {
      const nr = sr + dr;
      const nc = sc + dc;
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
  player: { id: ValidPlayerId; walls: ReadonlySet<TileKey> },
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
      if (hasAliveHouseAt(state, r, c)) {
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
