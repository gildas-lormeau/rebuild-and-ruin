/**
 * AI build-phase scoring — territory gain evaluation, fat wall checks,
 * pocket analysis, and all compute* penalty/bonus functions.
 *
 * Called by the build placement orchestrator (ai-strategy-build.ts).
 */

import type { AiPlacement, Candidate, Scored } from "./ai-build-types.ts";
import { floodPocket } from "./ai-castle-rect.ts";
import { SMALL_POCKET_MAX_SIZE } from "./ai-constants.ts";
import { getCardinalObstacleMask } from "./board-occupancy.ts";
import type { TilePos, TileRect, Tower } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, Tile } from "./grid.ts";
import {
  CORNERS_2X2,
  DIRS_4,
  isWater,
  packTile,
  unpackTile,
} from "./spatial.ts";
import type { GameState } from "./types.ts";

/** Starting bonus for gap-filling placements before useful-gain reduction. */
const GAP_BONUS_BASE = 5;
/** Minimum gap bonus after useful-gain reduction (floor). */
const GAP_BONUS_MIN = 0.5;
/** How much each point of useful gain reduces the gap bonus. */
const GAP_BONUS_GAIN_FACTOR = 0.2;
/** Extra gap bonus per additional gap tile beyond the first. */
const GAP_BONUS_PER_EXTRA = 0.3;
/** Max Manhattan distance from cursor that still receives a proximity bonus. */
const CURSOR_PROXIMITY_MAX = 20;
/** Scales the cursor proximity bonus (higher = stronger cursor pull). */
const CURSOR_PROXIMITY_MULTIPLIER = 0.5;
/** Bonus per inner tile when placement fills gaps near water obstacles. */
const INNER_OBSTACLE_MULTIPLIER = 2;
/** Minimum penalty for a gap-closing placement that creates a 2x2 fat wall. */
const FAT_WALL_PENALTY_MIN = 5;
/** Fraction of useful gain used as penalty for gap-closing fat walls. */
const FAT_WALL_GAIN_FACTOR = 0.95;
/** Score bonus per obstacle around a 1x1 gap (prioritizes hard-to-fill gaps). */
const DIFFICULTY_MULTIPLIER = 3;
/** Score penalty per tile of new wasted pocket space created. */
const POCKET_DELTA_PENALTY = 3;
/** Score penalty for each house or bonus square tile covered by a placement. */
const OBSTACLE_HIT_PENALTY = 8;
/** Discard pieces if fewer free interior tiles remain (territory is full). */
const TOWER_PROXIMITY_RANGE = 8;
/** Score bonus per tile of proximity to an unowned zone tower (guides expansion). */
const TOWER_PROXIMITY_FACTOR = 0.3;
/** Bonus per gap tile that would survive the sweep (≥2 cardinal neighbors). */
const SWEEP_SAFE_BONUS = 2;
/** Penalty per tile that would create a 2x2 fat wall block. */
export const FAT_WALL_TILE_PENALTY = 5;

export function compareCandidatesByObstaclePreference(
  a: Pick<Candidate, "housesHit" | "bonusHit">,
  b: Pick<Candidate, "housesHit" | "bonusHit">,
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
): number {
  return (
    candidateObstacleHits(a, caresAboutHouses, caresAboutBonuses) -
    candidateObstacleHits(b, caresAboutHouses, caresAboutBonuses)
  );
}

export function compareScoredByScoreDesc(a: Scored, b: Scored): number {
  return b.score - a.score;
}

export function compareByNumericScoreDesc<T extends { score: number }>(a: T, b: T): number {
  return b.score - a.score;
}

export function computeGapBonus(gapsFilled: number, usefulGain: number): number {
  if (gapsFilled <= 0) return 0;
  const base = Math.max(
    GAP_BONUS_MIN,
    GAP_BONUS_BASE - usefulGain * GAP_BONUS_GAIN_FACTOR,
  );
  return base + (gapsFilled - 1) * GAP_BONUS_PER_EXTRA;
}

export function computeFatWallPenalty(
  gapClosingFat: boolean,
  hasFatWall: boolean,
  usefulGain: number,
  fatPenaltyScale: number,
): number {
  if (gapClosingFat) {
    return Math.max(
      FAT_WALL_PENALTY_MIN,
      usefulGain * FAT_WALL_GAIN_FACTOR,
    ) * fatPenaltyScale;
  }
  if (hasFatWall) {
    return FAT_WALL_TILE_PENALTY * fatPenaltyScale;
  }
  return 0;
}

export function computePocketPenalty(
  pocketDelta: number,
  pocketScale: number,
): number {
  return Math.max(0, pocketDelta) * POCKET_DELTA_PENALTY * pocketScale;
}

export function computeObstacleHitPenalty(
  candidate: Pick<Candidate, "housesHit" | "bonusHit">,
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
): number {
  return (caresAboutHouses ? candidate.housesHit * OBSTACLE_HIT_PENALTY : 0) +
    (caresAboutBonuses ? candidate.bonusHit * OBSTACLE_HIT_PENALTY : 0);
}

export function computeTowerProximityBonus(
  candidate: Candidate,
  targetGaps: Set<number>,
  zoneTowers: readonly Tower[],
  ownedTowers: readonly Tower[],
): number {
  if (targetGaps.size !== 0) return 0;

  let towerProximityBonus = 0;
  for (const t of zoneTowers) {
    if (ownedTowers.includes(t)) continue;
    for (const [dr, dc] of candidate.rotation.offsets) {
      const d =
        Math.abs(candidate.row + dr - (t.row + 0.5)) +
        Math.abs(candidate.col + dc - (t.col + 0.5));
      towerProximityBonus = Math.max(
        towerProximityBonus,
        Math.max(0, TOWER_PROXIMITY_RANGE - d) * TOWER_PROXIMITY_FACTOR,
      );
    }
  }

  return towerProximityBonus;
}

export function computeSweepSafeBonus(
  candidate: Candidate,
  targetGaps: Set<number>,
  simulatedWalls: Set<number>,
): number {
  if (candidate.gapsFilled <= 0) return 0;

  let sweepSafeBonus = 0;
  for (const [dr, dc] of candidate.rotation.offsets) {
    const key = packTile(candidate.row + dr, candidate.col + dc);
    if (!targetGaps.has(key)) continue;
    let cardinalCount = 0;
    for (const [ar, ac] of DIRS_4) {
      if (simulatedWalls.has(packTile(candidate.row + dr + ar, candidate.col + dc + ac))) {
        cardinalCount++;
      }
    }
    if (cardinalCount >= 2) sweepSafeBonus += SWEEP_SAFE_BONUS;
  }

  return sweepSafeBonus;
}

export function computeCursorProximityBonus(
  candidate: Candidate,
  anyHasWallAdjacent: boolean,
  cursorPos?: TilePos,
): number {
  if (anyHasWallAdjacent || candidate.gapsFilled <= 0 || !cursorPos) return 0;

  let avgDistance = 0;
  for (const [dr, dc] of candidate.rotation.offsets) {
    avgDistance +=
      Math.abs(candidate.row + dr - cursorPos.row) +
      Math.abs(candidate.col + dc - cursorPos.col);
  }
  avgDistance /= candidate.rotation.offsets.length;
  return Math.max(0, CURSOR_PROXIMITY_MAX - avgDistance) * CURSOR_PROXIMITY_MULTIPLIER;
}

export function computeInnerObstacleBonus(
  candidate: Candidate,
  targetGaps: Set<number>,
  castle: TileRect,
  tiles: readonly (readonly Tile[])[],
): number {
  if (candidate.gapsFilled < 2) return 0;

  let hasInnerObstacle = false;
  for (const [dr, dc] of candidate.rotation.offsets) {
    const pr = candidate.row + dr;
    const pc = candidate.col + dc;
    const key = packTile(pr, pc);
    if (!targetGaps.has(key)) continue;
    for (const [ar, ac] of DIRS_4) {
      const nr = pr + ar;
      const nc = pc + ac;
      if (
        nr >= castle.top &&
        nr <= castle.bottom &&
        nc >= castle.left &&
        nc <= castle.right &&
        isWater(tiles, nr, nc)
      ) {
        hasInnerObstacle = true;
      }
    }
  }

  if (!hasInnerObstacle) return 0;

  const { inside: innerTiles } = countNonGapTilesInCastle(candidate, targetGaps, castle);

  return innerTiles * INNER_OBSTACLE_MULTIPLIER;
}

export function computeDifficultyBonus(
  state: GameState,
  candidate: Candidate,
): number {
  if (candidate.rotation.offsets.length !== 1 || candidate.gapsFilled !== 1) return 0;

  const pr = candidate.row + candidate.rotation.offsets[0]![0];
  const pc = candidate.col + candidate.rotation.offsets[0]![1];
  // Track obstacle directions: [north, south, west, east]
  const obstacles = getCardinalObstacleMask(state, pr, pc);
  const total = obstacles.filter(Boolean).length;
  const hasOpposite =
    (obstacles[0] && obstacles[1]) || (obstacles[2] && obstacles[3]);
  if (total >= 2 && hasOpposite) return total * DIFFICULTY_MULTIPLIER;
  if (total >= 1) return total;
  return 0;
}

export function computeWastefulClosureAdjustment(
  candidate: Candidate,
  targetGaps: Set<number>,
  castle: TileRect,
  usefulGain: number,
  baseGapBonus: number,
): { gapBonus: number; wastefulClosurePenalty: number } {
  if (candidate.gapsFilled <= 0 || castle.top > castle.bottom) {
    return { gapBonus: baseGapBonus, wastefulClosurePenalty: 0 };
  }

  const { inside: insideNonGap, outside: outsideNonGap } = countNonGapTilesInCastle(candidate, targetGaps, castle);

  if (outsideNonGap === 0 && insideNonGap > candidate.gapsFilled) {
    return {
      gapBonus: 0,
      wastefulClosurePenalty: usefulGain + insideNonGap,
    };
  }

  return { gapBonus: baseGapBonus, wastefulClosurePenalty: 0 };
}

export function shouldRejectForFatWalls(
  rawFatBlocks: number,
  fatGainPerBlock: number,
  usefulGain: number,
  fatExempt: boolean,
): boolean {
  return (
    rawFatBlocks > 0 &&
    fatGainPerBlock > 0 &&
    usefulGain < rawFatBlocks * fatGainPerBlock &&
    !fatExempt
  );
}

export function countSmallPocketTiles(
  walls: Set<number>,
  outsideSet: Set<number>,
): { wasted: number; smallestPocket: number } {
  let wasted = 0;
  let smallestPocket = Infinity;
  const visited = new Set<number>();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const k = packTile(r, c);
      if (visited.has(k) || outsideSet.has(k) || walls.has(k)) continue;
      const pocket = floodPocket(k, visited, walls, outsideSet);
      if (pocket.length < SMALL_POCKET_MAX_SIZE) {
        wasted += pocket.length;
        if (pocket.length < smallestPocket) smallestPocket = pocket.length;
      }
    }
  }
  return { wasted, smallestPocket };
}

export function candidateObstacleHits(
  candidate: Pick<Candidate, "housesHit" | "bonusHit">,
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
): number {
  return (caresAboutHouses ? candidate.housesHit : 0) +
    (caresAboutBonuses ? candidate.bonusHit : 0);
}

export function candidateToPlacement(candidate: Candidate): AiPlacement {
  return {
    piece: candidate.rotation,
    row: candidate.row,
    col: candidate.col,
  };
}

export function isFatFreeCandidate(
  walls: Set<number>,
  candidate: Candidate,
): boolean {
  return countFatBlocks(walls, candidate) === 0;
}

/** Count 2×2 all-wall blocks a candidate would create (no exemptions). */
export function countFatBlocks(
  walls: Set<number>,
  candidate: Candidate,
): number {
  const { addedKeys, addedSet: _, isWall } = buildCandidateWallInfo(walls, candidate.rotation.offsets, candidate.row, candidate.col);
  let blocks = 0;
  for (const key of addedKeys) {
    const { r, c } = unpackTile(key);
    if (tileCreatesFatBlock(r, c, isWall)) blocks++;
  }
  return blocks;
}

/** Cheap fat-wall check — no Set copy, just checks if placing creates 2×2 blocks. */
export function checkFatWall(
  walls: Set<number>,
  candidate: Candidate,
): { hasFatWall: boolean; gapClosingFat: boolean } {
  const { addedKeys, addedSet: _, isWall } = buildCandidateWallInfo(walls, candidate.rotation.offsets, candidate.row, candidate.col);
  let hasFatWall = false;
  let gapClosingFat = false;
  for (const key of addedKeys) {
    const { r, c } = unpackTile(key);
    if (!tileCreatesFatBlock(r, c, isWall)) continue;
    if (candidate.gapsFilled > 0) {
      gapClosingFat = true;
      continue;
    }
    hasFatWall = true;
    break;
  }
  return { hasFatWall, gapClosingFat };
}

/** Build the simulated wall set for a candidate. */
export function buildSimulatedWalls(
  walls: Set<number>,
  candidate: Candidate,
): Set<number> {
  const simulatedWalls = new Set(walls);
  for (const [dr, dc] of candidate.rotation.offsets) {
    simulatedWalls.add(packTile(candidate.row + dr, candidate.col + dc));
  }
  return simulatedWalls;
}

/** Build the added-key set and wall predicate for a candidate placement. */
function buildCandidateWallInfo(
  walls: Set<number>,
  offsets: readonly (readonly [number, number])[],
  row: number,
  col: number,
): { addedKeys: number[]; addedSet: Set<number>; isWall: (k: number) => boolean } {
  const addedKeys: number[] = [];
  for (const [dr, dc] of offsets) {
    addedKeys.push(packTile(row + dr, col + dc));
  }
  const addedSet = new Set(addedKeys);
  const isWall = (k: number) => walls.has(k) || addedSet.has(k);
  return { addedKeys, addedSet, isWall };
}

/** Check if a tile creates any 2x2 all-wall block when added to existing walls. */
function tileCreatesFatBlock(
  r: number,
  c: number,
  isWall: (k: number) => boolean,
): boolean {
  for (const [cr, cc] of CORNERS_2X2) {
    const tr = r + cr, tc = c + cc;
    if (tr < 0 || tr + 1 >= GRID_ROWS || tc < 0 || tc + 1 >= GRID_COLS) continue;
    if (isWall(packTile(tr, tc)) && isWall(packTile(tr, tc + 1)) &&
        isWall(packTile(tr + 1, tc)) && isWall(packTile(tr + 1, tc + 1))) {
      return true;
    }
  }
  return false;
}

/** Count non-gap candidate tiles inside vs outside the castle rect. */
function countNonGapTilesInCastle(
  candidate: Candidate,
  targetGaps: Set<number>,
  castle: TileRect,
): { inside: number; outside: number } {
  let inside = 0;
  let outside = 0;
  for (const [dr, dc] of candidate.rotation.offsets) {
    const pr = candidate.row + dr;
    const pc = candidate.col + dc;
    if (targetGaps.has(packTile(pr, pc))) continue;
    if (
      pr >= castle.top &&
      pr <= castle.bottom &&
      pc >= castle.left &&
      pc <= castle.right
    ) {
      inside++;
    } else {
      outside++;
    }
  }
  return { inside, outside };
}
