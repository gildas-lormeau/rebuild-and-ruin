/**
 * AI build-phase shared infrastructure: pickFallbackPlacement (tower
 * extension + ring-distance fallback), createsSmallEnclosure (small-pocket
 * trap check shared with scoring pipeline), memoize (kept at this layer
 * so closures may reference L≤10 symbols — see lint:callback-inversion).
 * Called by the build placement orchestrator (ai-strategy-build.ts).
 */

import { TOWER_SIZE } from "../shared/core/game-constants.ts";
import type { Tower } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import {
  computeTrappedAfterAdd,
  isCannonTile,
  isGrass,
  isTowerTile,
  manhattanDistance,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import { getInterior } from "../shared/sim/player-interior.ts";
import {
  candidateObstacleHits,
  candidateToPlacement,
  countFatBlocks,
  packCandidateTiles,
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

/** Would placing this candidate create a new small (< SMALL_POCKET_MAX_SIZE)
 *  pocket that has no tower, grunt, or terrain occupant? Used to reject
 *  wasteful placements in both the primary discard path and the fallback
 *  discard path.
 *
 *  Only walls that *newly trap* a previously-outside tile can create a
 *  fresh enclosure — interior-only subdivisions ("subdivision pockets")
 *  don't count. So we flood from each newly-trapped tile (outside before,
 *  inside after) rather than scanning the whole grid. The `floodPocket`
 *  `sizeLimit` short-circuits the BFS once we know a pocket is too large
 *  to qualify. */
export function pickFallbackPlacement(
  scored: readonly Scored[],
  state: BuildViewState,
  buildCtx: FallbackContext,
): { placement: AiPlacement | null; reason: string } {
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
    aliveHouseKeys,
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

  if (
    unenclosedTowers.length === 0 &&
    !hasMinFreeInterior(state, walls, playerInterior, MIN_FREE_INTERIOR)
  ) {
    return { placement: null, reason: "interior-full" };
  }

  const createsSmallEnclosureCached = memoize((candidate: Candidate) =>
    createsSmallEnclosure(candidate, walls, outside, state, aliveHouseKeys),
  );

  // Union once instead of probing each player's interior per offset.
  const anyInterior = new Set<TileKey>();
  for (const player of state.players) {
    for (const key of getInterior(player)) anyInterior.add(key);
  }
  const insideEnclosure = (candidate: Candidate): boolean => {
    for (const [dr, dc] of candidate.piece.offsets) {
      if (anyInterior.has(packTile(candidate.row + dr, candidate.col + dc)))
        return true;
    }
    return false;
  };

  const fallbackTowers = homeWasBroken
    ? unenclosedTowers.filter((tower) => tower !== castle.tower)
    : unenclosedTowers;

  const insideEnclosureCached = memoize(insideEnclosure);
  const fatBlocksCached = memoize((candidate: Candidate): number =>
    countFatBlocks(walls, candidate, aliveHouseKeys),
  );
  const isInsideOrFatCandidate = (candidate: Candidate): boolean =>
    insideEnclosureCached(candidate) || fatBlocksCached(candidate) > 0;

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
      insideEnclosureCached,
      fatBlocksCached,
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

/** Map-based memoize for per-candidate predicates. Lives at this layer
 *  (rather than ai-constants L0) so closures passed to it may reference
 *  L≤10 symbols — see lint:callback-inversion. */
export function memoize<K, V>(func: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>();
  return (key: K): V => {
    if (cache.has(key)) return cache.get(key)!;
    const computed = func(key);
    cache.set(key, computed);
    return computed;
  };
}

export function createsSmallEnclosure(
  candidate: Candidate,
  walls: ReadonlySet<TileKey>,
  outside: ReadonlySet<TileKey>,
  state: BuildViewState,
  aliveHouseKeys: ReadonlySet<TileKey>,
): boolean {
  const candidateWallTiles = packCandidateTiles(candidate, aliveHouseKeys);
  // Cheap path: detect traps without cloning the outside set. The bulk of
  // calls during build phase (~99%) don't trap anything; this lets them
  // bail before paying the O(outside.size) clone that dominated the prior
  // implementation's cost.
  const trapped = computeTrappedAfterAdd(outside, candidateWallTiles);
  if (trapped.length === 0) return false;
  // Rare path: traps exist. Build simulatedOutside so floodPocket can
  // treat outside tiles as barriers.
  const simulatedOutside = new Set<TileKey>(outside);
  for (let i = 0; i < candidateWallTiles.length; i++) {
    simulatedOutside.delete(candidateWallTiles[i]!);
  }
  for (let i = 0; i < trapped.length; i++) {
    simulatedOutside.delete(trapped[i]!);
  }
  // Pre-seeding `visited` with the candidate's new wall tiles makes the
  // flood-pocket BFS treat them as barriers (visited == skip), so we pass
  // the original `walls` set instead of paying another clone here.
  const visited = new Set<TileKey>(candidateWallTiles);
  for (const seed of trapped) {
    if (visited.has(seed)) continue;
    const pocket = floodPocket(
      seed,
      visited,
      walls,
      simulatedOutside,
      SMALL_POCKET_MAX_SIZE,
    );
    if (pocket.length >= SMALL_POCKET_MAX_SIZE) continue;
    if (!hasOccupantInPocket(pocket, state)) return true;
  }
  return false;
}

/** True if any tile in `pocket` is occupied (tower, non-grass terrain, or
 *  grunt). A pocket with an occupant has a use, so it's not a "wasted"
 *  small enclosure — only fully empty grass pockets reject the candidate. */
function hasOccupantInPocket(
  pocket: readonly TileKey[],
  state: BuildViewState,
): boolean {
  for (const pocketKey of pocket) {
    const { row: pr, col: pc } = unpackTile(pocketKey);
    for (const tower of state.map.towers) {
      if (isTowerTile(tower, pr, pc)) return true;
    }
    if (!isGrass(state.map.tiles, pr, pc)) return true;
    for (const grunt of state.grunts) {
      if (grunt.row === pr && grunt.col === pc) return true;
    }
  }
  return false;
}

/** True if the player has at least `limit` non-blocked interior tiles. Scans
 *  the grid and returns early once the count is reached — the caller only
 *  cares about the threshold, not the exact tally. */
function hasMinFreeInterior(
  state: BuildViewState,
  walls: ReadonlySet<TileKey>,
  playerInterior: ReadonlySet<TileKey>,
  limit: number,
): boolean {
  let count = 0;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const key = packTile(r, c);
      if (!playerInterior.has(key)) continue;
      if (walls.has(key)) continue;
      if (isTileBlockedByEntities(state, r, c)) continue;
      count++;
      if (count >= limit) return true;
    }
  }
  return false;
}

function isTileBlockedByEntities(
  state: BuildViewState,
  row: number,
  col: number,
): boolean {
  for (const tower of state.map.towers) {
    if (isTowerTile(tower, row, col)) return true;
  }
  for (const player of state.players) {
    for (const cannon of player.cannons) {
      if (isCannonTile(cannon, row, col)) return true;
    }
  }
  return false;
}

function pickTowerExtensionCandidate(
  scored: readonly Scored[],
  fallbackTowers: readonly Tower[],
  castleMargin: number,
  ringDistanceCache: Map<Candidate, { distance: number; tooClose: boolean }>,
  createsSmallEnclosureCached: (candidate: Candidate) => boolean,
  isInsideOrFatCandidate: (candidate: Candidate) => boolean,
  insideEnclosureCached: (candidate: Candidate) => boolean,
  fatBlocksCached: (candidate: Candidate) => number,
): {
  candidate: Candidate | null;
  reason: "extend" | "extend-fallback" | "extend-least-bad" | "extend-all-fat";
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

  const fallback = scored.filter((score) =>
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

  // Deadlock escape: this branch only runs while a tower still needs
  // enclosing, and bag cycling is load-bearing — the phase loop holds the
  // SAME piece until it is committed, so returning null here every tick
  // forfeits the rest of the build INCLUDING the queued pieces that could
  // close the ring (seed 992367 r12 BLUE: a builder-skill AI held the C
  // piece for 31 ticks because every legal placement was fat or
  // pocket-trapping, while 1x3/1x2/1x1 sat next in the bag). Burn the
  // piece on the least-bad exterior spot instead: prefer no trapped
  // pocket, then fewest 2×2 fat blocks, then outside the ring margin,
  // then nearest to a fallback tower's ring. Interior placements stay
  // excluded — wasting closed interior is the desperate-discard path's
  // call, not this one's.
  const leastBad = scored.filter(
    (score) => !insideEnclosureCached(score.candidate),
  );
  if (leastBad.length > 0) {
    leastBad.sort((a, b) => {
      const pocketDelta =
        Number(createsSmallEnclosureCached(a.candidate)) -
        Number(createsSmallEnclosureCached(b.candidate));
      if (pocketDelta !== 0) return pocketDelta;
      const fatDelta =
        fatBlocksCached(a.candidate) - fatBlocksCached(b.candidate);
      if (fatDelta !== 0) return fatDelta;
      const ringA = centerDistanceForFallbackTowers(
        a.candidate,
        fallbackTowers,
        castleMargin,
        ringDistanceCache,
      );
      const ringB = centerDistanceForFallbackTowers(
        b.candidate,
        fallbackTowers,
        castleMargin,
        ringDistanceCache,
      );
      return (
        Number(ringA.tooClose) - Number(ringB.tooClose) ||
        ringA.distance - ringB.distance
      );
    });
    return { candidate: leastBad[0]!.candidate, reason: "extend-least-bad" };
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
  const distance = manhattanDistance(
    candidate.row,
    candidate.col,
    centerR,
    centerC,
  );

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
  const throwAway = scored.filter(
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
