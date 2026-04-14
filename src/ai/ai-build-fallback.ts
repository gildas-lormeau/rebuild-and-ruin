/**
 * AI build-phase fallback — discard placement, tower extension,
 * and ring-distance scoring when no territory gain is possible.
 *
 * Called by the build placement orchestrator (ai-strategy-build.ts).
 */

import { TOWER_SIZE } from "../shared/core/game-constants.ts";
import type { Tower } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "../shared/core/grid.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import {
  computeOutside,
  isCannonTile,
  isGrass,
  isTowerTile,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import {
  candidateObstacleHits,
  candidateToPlacement,
  createSimulatedWalls,
  isFatFreeCandidate,
} from "./ai-build-score.ts";
import type {
  AiPlacement,
  Candidate,
  FallbackContext,
  Scored,
} from "./ai-build-types.ts";
import { floodPocket } from "./ai-castle-rect.ts";
import { SMALL_POCKET_MAX_SIZE } from "./ai-constants.ts";

const MIN_FREE_INTERIOR = 6;

export function pickFallbackPlacement(
  scored: readonly Scored[],
  state: BuildViewState,
  buildCtx: FallbackContext,
): { placement: AiPlacement | null; reason: string } | null {
  const {
    walls,
    outside,
    playerInterior,
    castle,
    castleMargin,
    homeWasBroken,
    unenclosedTowers,
    caresAboutHouses,
    caresAboutBonuses,
  } = buildCtx;
  const placementResult = (
    candidate: Candidate,
    reason: string,
  ): { placement: AiPlacement; reason: string } => {
    return {
      placement: candidateToPlacement(candidate),
      reason,
    };
  };

  // Count free interior tiles — if territory is full, stop building
  let totalFree = 0;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const key = packTile(r, c);
      if (!playerInterior.has(key)) continue;
      if (walls.has(key)) continue;
      let blocked = false;
      for (const tower of state.map.towers) {
        if (isTowerTile(tower, r, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      for (const player of state.players) {
        for (const cannon of player.cannons) {
          if (isCannonTile(cannon, r, c)) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;
      }
      if (!blocked) totalFree++;
    }
  }
  if (totalFree < MIN_FREE_INTERIOR && unenclosedTowers.length === 0)
    return { placement: null, reason: "interior-full" };

  const createsSmallEnclosureCached = memoize((candidate: Candidate) =>
    createsSmallEnclosure(candidate, walls, outside, state),
  );

  const insideEnclosure = (candidate: Candidate): boolean => {
    for (const [dr, dc] of candidate.piece.offsets) {
      const key = packTile(candidate.row + dr, candidate.col + dc);
      for (const player of state.players) {
        if (getInterior(player).has(key)) return true;
      }
    }
    return false;
  };

  const fallbackTowers = homeWasBroken
    ? unenclosedTowers.filter((tower) => tower !== castle.tower)
    : unenclosedTowers;

  const isInsideOrFatCandidate = (candidate: Candidate): boolean => {
    return insideEnclosure(candidate) || !isFatFreeCandidate(walls, candidate);
  };

  if (fallbackTowers.length > 0) {
    const ringDistanceCache = new Map<
      Candidate,
      { distance: number; tooClose: boolean }
    >();
    const picked = pickTowerExtensionCandidate(
      scored,
      fallbackTowers,
      castleMargin,
      ringDistanceCache,
      createsSmallEnclosureCached,
      isInsideOrFatCandidate,
    );
    if (picked.candidate) {
      return placementResult(picked.candidate, picked.reason);
    }
    return { placement: null, reason: picked.reason };
  } else {
    const bestDiscard = pickDiscardCandidate(
      scored,
      caresAboutHouses,
      caresAboutBonuses,
      createsSmallEnclosureCached,
      isInsideOrFatCandidate,
    );
    if (bestDiscard) {
      return placementResult(bestDiscard, "discard");
    }
    return { placement: null, reason: "discard-all-fat" };
  }
}

/** Would placing this candidate create a new small (< 9 tile) pocket that
 *  has no tower, grunt, or terrain occupant? Used to reject wasteful placements
 *  in both the primary discard path and the fallback discard path. */
export function createsSmallEnclosure(
  candidate: Candidate,
  walls: ReadonlySet<number>,
  outside: ReadonlySet<number>,
  state: BuildViewState,
): boolean {
  const simulatedWalls = createSimulatedWalls(walls, candidate);
  const simulatedOutside = computeOutside(simulatedWalls);
  const visited = new Set<number>();
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const key = packTile(r, c);
      if (
        visited.has(key) ||
        simulatedOutside.has(key) ||
        simulatedWalls.has(key)
      )
        continue;
      const pocket = floodPocket(
        key,
        visited,
        simulatedWalls,
        simulatedOutside,
      );
      if (pocket.length >= SMALL_POCKET_MAX_SIZE) continue;
      let preExisting = true;
      for (const pocketKey of pocket) {
        if (outside.has(pocketKey)) {
          preExisting = false;
          break;
        }
      }
      if (preExisting) continue;
      let hasOccupant = false;
      for (const pocketKey of pocket) {
        const { r: pr, c: pc } = unpackTile(pocketKey);
        for (const tower of state.map.towers) {
          if (isTowerTile(tower, pr, pc)) {
            hasOccupant = true;
            break;
          }
        }
        if (!hasOccupant && !isGrass(state.map.tiles, pr, pc))
          hasOccupant = true;
        if (!hasOccupant) {
          for (const grunt of state.grunts) {
            if (grunt.row === pr && grunt.col === pc) {
              hasOccupant = true;
              break;
            }
          }
        }
        if (hasOccupant) break;
      }
      if (!hasOccupant) return true;
    }
  }
  return false;
}

/** Create a memoized version of a function (Map-based cache). */
export function memoize<K, V>(func: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>();
  return (key: K): V => {
    if (cache.has(key)) return cache.get(key)!;
    const computed = func(key);
    cache.set(key, computed);
    return computed;
  };
}

function pickTowerExtensionCandidate(
  scored: readonly Scored[],
  fallbackTowers: readonly Tower[],
  castleMargin: number,
  ringDistanceCache: Map<Candidate, { distance: number; tooClose: boolean }>,
  createsSmallEnclosureCached: (candidate: Candidate) => boolean,
  isInsideOrFatCandidate: (candidate: Candidate) => boolean,
): {
  candidate: Candidate | null;
  reason: "extend" | "extend-fallback" | "extend-all-fat";
} {
  const extending = scored.filter((score) =>
    isExtensionCandidateForFallback(
      score.candidate,
      fallbackTowers,
      castleMargin,
      ringDistanceCache,
      createsSmallEnclosureCached,
      isInsideOrFatCandidate,
    ),
  );

  if (extending.length > 0) {
    extending.sort(
      (a, b) =>
        compareByFallbackRingDistance(
          a.candidate,
          b.candidate,
          fallbackTowers,
          castleMargin,
          ringDistanceCache,
        ) || b.candidate.wallAdjacent - a.candidate.wallAdjacent,
    );
    return { candidate: extending[0]!.candidate, reason: "extend" };
  }

  const fallback = [...scored].filter((score) =>
    isExtensionFallbackCandidateForFallback(
      score.candidate,
      createsSmallEnclosureCached,
      isInsideOrFatCandidate,
    ),
  );
  fallback.sort((a, b) =>
    compareByFallbackRingDistance(
      a.candidate,
      b.candidate,
      fallbackTowers,
      castleMargin,
      ringDistanceCache,
    ),
  );
  if (fallback.length > 0) {
    return { candidate: fallback[0]!.candidate, reason: "extend-fallback" };
  }

  return { candidate: null, reason: "extend-all-fat" };
}

function compareByFallbackRingDistance(
  a: Candidate,
  b: Candidate,
  fallbackTowers: readonly Tower[],
  castleMargin: number,
  ringDistanceCache: Map<Candidate, { distance: number; tooClose: boolean }>,
): number {
  return (
    centerDistanceForFallbackTowers(
      a,
      fallbackTowers,
      castleMargin,
      ringDistanceCache,
    ).distance -
    centerDistanceForFallbackTowers(
      b,
      fallbackTowers,
      castleMargin,
      ringDistanceCache,
    ).distance
  );
}

function isExtensionCandidateForFallback(
  candidate: Candidate,
  fallbackTowers: readonly Tower[],
  castleMargin: number,
  ringDistanceCache: Map<Candidate, { distance: number; tooClose: boolean }>,
  createsSmallEnclosureCached: (candidate: Candidate) => boolean,
  isInsideOrFatCandidate: (candidate: Candidate) => boolean,
): boolean {
  const ringDistance = centerDistanceForFallbackTowers(
    candidate,
    fallbackTowers,
    castleMargin,
    ringDistanceCache,
  );
  if (ringDistance.tooClose) return false;
  if (createsSmallEnclosureCached(candidate)) return false;
  if (isInsideOrFatCandidate(candidate)) return false;
  return true;
}

function centerDistanceForFallbackTowers(
  candidate: Candidate,
  fallbackTowers: readonly Tower[],
  castleMargin: number,
  ringDistanceCache: Map<Candidate, { distance: number; tooClose: boolean }>,
): { distance: number; tooClose: boolean } {
  const cached = ringDistanceCache.get(candidate);
  if (cached) return cached;

  let bestDistance = Infinity;
  let tooClose = false;
  for (const tower of fallbackTowers) {
    const towerDistance = candidateRingDistanceForTower(
      candidate,
      tower,
      castleMargin,
    );
    if (towerDistance.tooClose) tooClose = true;
    if (towerDistance.distance < bestDistance)
      bestDistance = towerDistance.distance;
  }

  const result = { distance: bestDistance, tooClose };
  ringDistanceCache.set(candidate, result);
  return result;
}

function candidateRingDistanceForTower(
  candidate: Candidate,
  tower: Tower,
  castleMargin: number,
): { distance: number; tooClose: boolean } {
  const lastRow = tower.row + TOWER_SIZE - 1;
  const lastCol = tower.col + TOWER_SIZE - 1;
  const ringTop = tower.row - castleMargin - 1;
  const ringBot = lastRow + castleMargin + 1;
  const ringLeft = tower.col - castleMargin - 1;
  const ringRight = lastCol + castleMargin + 1;

  let tooClose = false;
  for (const [dr, dc] of candidate.piece.offsets) {
    const pr = candidate.row + dr;
    const pc = candidate.col + dc;
    if (
      pr >= tower.row - castleMargin &&
      pr <= lastRow + castleMargin &&
      pc >= tower.col - castleMargin &&
      pc <= lastCol + castleMargin
    ) {
      if (pr > ringTop && pr < ringBot && pc > ringLeft && pc < ringRight) {
        tooClose = true;
      }
    }
  }

  const centerR = tower.row + 0.5;
  const centerC = tower.col + 0.5;
  const distance =
    Math.abs(candidate.row - centerR) + Math.abs(candidate.col - centerC);

  return { distance, tooClose };
}

function isExtensionFallbackCandidateForFallback(
  candidate: Candidate,
  createsSmallEnclosureCached: (candidate: Candidate) => boolean,
  isInsideOrFatCandidate: (candidate: Candidate) => boolean,
): boolean {
  return (
    !createsSmallEnclosureCached(candidate) &&
    !isInsideOrFatCandidate(candidate)
  );
}

function pickDiscardCandidate(
  scored: readonly Scored[],
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
  createsSmallEnclosureCached: (candidate: Candidate) => boolean,
  isInsideOrFatCandidate: (candidate: Candidate) => boolean,
): Candidate | null {
  const throwAway = [...scored].filter(
    (score) => !isInsideOrFatCandidate(score.candidate),
  );
  if (throwAway.length === 0) return null;
  throwAway.sort((a, b) =>
    compareDiscardCandidatesForFallback(
      a,
      b,
      caresAboutHouses,
      caresAboutBonuses,
      createsSmallEnclosureCached,
    ),
  );
  return throwAway[0]!.candidate;
}

function compareDiscardCandidatesForFallback(
  a: Scored,
  b: Scored,
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
  createsSmallEnclosureCached: (candidate: Candidate) => boolean,
): number {
  const aHit = candidateObstacleHits(
    a.candidate,
    caresAboutHouses,
    caresAboutBonuses,
  );
  const bHit = candidateObstacleHits(
    b.candidate,
    caresAboutHouses,
    caresAboutBonuses,
  );
  if (aHit !== bHit) return aHit - bHit;
  const aEncloses = createsSmallEnclosureCached(a.candidate) ? 0 : 1;
  const bEncloses = createsSmallEnclosureCached(b.candidate) ? 0 : 1;
  if (aEncloses !== bEncloses) return aEncloses - bEncloses;
  return Number(a.hasFatWall) - Number(b.hasFatWall);
}
