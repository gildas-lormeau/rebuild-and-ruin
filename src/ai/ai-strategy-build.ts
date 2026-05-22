/**
 * AI build-phase placement orchestrator: target ring (ai-build-target),
 * enumerate candidates, score (ai-build-score), fall back (ai-build-shared).
 * Castle rectangle + gap analysis live in ai-castle-rect.
 */

import {
  buildPlacementContext,
  canPlacePiece,
  createCastle,
  effectivePlanTiles,
} from "../game/index.ts";
import {
  buildOccupancyCache,
  collectAliveHouseKeys,
  hasAliveHouseAt,
  hasGruntAt,
} from "../shared/core/board-occupancy.ts";
import type {
  Castle,
  TileBounds,
  TileRect,
  Tower,
} from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import { hasCannonAt, hasTowerAt } from "../shared/core/occupancy-queries.ts";
import { type PieceShape, rotateCW } from "../shared/core/pieces.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  computeOutside,
  DIRS_4,
  hasPitAt,
  inBounds,
  isGrass,
  packTile,
  towerReachesOutsideCardinal,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import {
  candidateObstacleHits,
  candidateToPlacement,
  checkFatWall,
  compareByNumericScoreDesc,
  countFatBlocks,
  countSmallPocketTiles,
  FAT_WALL_TILE_PENALTY,
  scoreTopCandidates,
} from "./ai-build-score.ts";
import {
  createsSmallEnclosure,
  memoize,
  pickFallbackPlacement,
} from "./ai-build-shared.ts";
import {
  adjustInterior,
  canPieceFillAnyGap,
  plugUnreachableGaps,
} from "./ai-build-target.ts";
import type {
  AiPlacement,
  Candidate,
  EnclosureAnalysis,
  PlacementOptions,
  Scored,
  ScoringContext,
  TargetContext,
  TargetResult,
} from "./ai-build-types.ts";
import {
  castleRect,
  computeFillableGaps,
  findGapTiles,
  findReachableRingGaps,
  hasMeaningfulHomeRingGaps,
  scoreBuildTowerTarget,
} from "./ai-castle-rect.ts";

type BuildSkillConfig = (typeof BUILD_SKILL_TABLE)[number];

/** Max gap tiles before AI deprioritizes home tower in favor of other unenclosed towers. */
const HOME_GAP_REPAIR_THRESHOLD = 5;
/** Score weight per gap tile filled by a placement. */
const GAP_FILLED_WEIGHT = 100;
/** Score weight per tile adjacent to a gap (supports gap closure). */
const GAP_ADJACENT_WEIGHT = 20;
/** Score weight per tile connected to existing walls. */
const CONNECTED_TILES_WEIGHT = 10;
/** Max gap tiles the AI considers evaluable in a single build turn. Beyond this, the target is skipped. */
const MANAGEABLE_GAP_LIMIT = 8;
/** How far the castle rect can expand to route around blocked tiles.
 *  Indexed by interior utilization: >60% → 2, >30% → 3, >10% → 4, else 5. */
const EXPANSION_TIERS: readonly { minFreeRatio: number; maxExpand: number }[] =
  [
    { minFreeRatio: 0.6, maxExpand: 2 },
    { minFreeRatio: 0.3, maxExpand: 3 },
    { minFreeRatio: 0.1, maxExpand: 4 },
  ];
const EXPANSION_DEFAULT_MAX = 5;
/** Tiles the territory-expansion ring extends past the existing wall bbox
 *  when all towers are already enclosed (`tryExpandTerritory`). One ring of
 *  walls is the bbox itself; this is the *outward* growth budget on top. */
const TERRITORY_EXPAND_RING = 2;
const BUILD_SKILL_TABLE = [
  /*1*/ {
    topCandidates: 12,
    fatGainPerBlock: 0,
    pocketScale: 0.25,
    fatPenaltyScale: 0.25,
    tinyPocketReject: false,
  },
  /*2*/ {
    topCandidates: 20,
    fatGainPerBlock: 1,
    pocketScale: 0.5,
    fatPenaltyScale: 0.5,
    tinyPocketReject: false,
  },
  /*3*/ {
    topCandidates: 30,
    fatGainPerBlock: 2,
    pocketScale: 0.75,
    fatPenaltyScale: 0.75,
    tinyPocketReject: true,
  },
  /*4*/ {
    topCandidates: 36,
    fatGainPerBlock: 2,
    pocketScale: 1.0,
    fatPenaltyScale: 1.0,
    tinyPocketReject: true,
  },
  /*5*/ {
    topCandidates: 40,
    fatGainPerBlock: 3,
    pocketScale: 1.25,
    fatPenaltyScale: 1.25,
    tinyPocketReject: true,
  },
] as const;
const NO_TARGET: TargetResult = { targetGaps: new Set(), targetRect: null };
/** Identify the real breach points in the player's wall ring by scanning
 *  for short non-wall runs between paired walls — works regardless of
 *  whether the ring is rectangular or stair-stepped, and catches holes
 *  inside the bounding box that the perimeter-only findGapTiles can't see.
 *  K_HOLE = max width of a closeable gap (1-tile, 2-tile, or 3-tile holes). */
const HOLE_MAX_WIDTH = 3;

export function pickPlacement(
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  options: PlacementOptions,
): AiPlacement | null {
  const {
    cursorPos,
    homeWasBroken,
    castleMargin,
    bankHugging,
    caresAboutHouses,
    caresAboutBonuses,
    buildSkill,
    outerRingHolesSnapshot,
  } = options;
  const maybePlayer = state.players[playerId];
  if (!maybePlayer || maybePlayer.castleWallTiles.size === 0) return null;
  const player = maybePlayer;
  // Recompute the home castle rect on demand. Selection used the same
  // algorithm against the modifier-projected tiles; passing
  // `effectivePlanTiles(state)` here keeps AI scoring aligned with the
  // actual walls while the same modifier is active. After a modifier
  // clears between selection and now, the recomputed rect drifts to the
  // natural-shoreline shape — bounded suboptimality, never desync.
  if (!player.homeTower) return null;
  const castle = createCastle(
    player.homeTower,
    effectivePlanTiles(state),
    state.map.towers,
  );

  // Skill-derived parameters (level 1 = clumsy, 5 = clean builder)
  //   topCandidates:    how many placements get full territory-gain evaluation
  //   fatGainPerBlock:  useful-gain required per 2×2 fat block to pass hard reject
  //   pocketScale:      multiplier on pocket delta penalty
  //   fatPenaltyScale:  multiplier on fat wall scoring penalty
  //   tinyPocketReject: whether tiny-pocket hard reject is active
  const skill = getBuildSkillConfig(buildSkill);
  const {
    outside,
    homeTowerEnclosed,
    zoneTowers,
    unenclosedTowers,
    otherUnenclosed,
    allCastlesEnclosed,
    effectiveSkipHome,
    homeHasRingGaps,
  } = analyzeEnclosures(
    state,
    player,
    castle,
    castleMargin,
    bankHugging,
    homeWasBroken,
  );
  const walls = player.walls;

  // Step 1: determine which rectangle to build/repair.
  // Pipeline: tryRepairHomeCastle → trySecondaryTower → tryExpandTerritory
  // Each phase only runs if the previous one found no gaps.
  const { targetGaps, targetRect } = selectTarget({
    state,
    playerId,
    player,
    castle,
    piece,
    castleMargin,
    bankHugging,
    cursorPos,
    effectiveSkipHome,
    homeHasRingGaps,
    allCastlesEnclosed,
    unenclosedTowers,
    otherUnenclosed,
    outerRingHolesSnapshot,
  });
  // Step 2: score candidates
  const baselineOutside = outside.size;

  // Interior excluding gaps and castle-rect tiles — lets the AI place pieces
  // freely inside an open (gapped) enclosure. Without this exclusion, scoring
  // would penalize placements near gaps that need filling.
  const interiorExcludingGaps = adjustInterior(
    getInterior(player),
    targetGaps,
    targetRect,
  );

  const allCandidates = enumerateCandidates(
    state,
    playerId,
    piece,
    player.walls,
    outside,
    targetGaps,
    interiorExcludingGaps,
  );
  if (allCandidates.length === 0) return null;

  // Step 3: pick best using territory gain
  const baselinePocketWaste = countSmallPocketTiles(
    player.walls,
    outside,
  ).wasted;

  const noTargetGaps = allCastlesEnclosed && targetGaps.size === 0;
  const noBuildTargets = noTargetGaps && unenclosedTowers.length === 0;
  const aliveHouseKeys = collectAliveHouseKeys(state);
  const scored = prescoreCandidates(
    allCandidates,
    player.walls,
    noTargetGaps,
    aliveHouseKeys,
  );

  const scoringCtx: ScoringContext = {
    state,
    walls,
    outside,
    targetGaps,
    castle,
    cursorPos,
    zoneTowers,
    ownedTowers: player.ownedTowers,
    skill,
    caresAboutHouses,
    caresAboutBonuses,
    allCastlesEnclosed,
    homeTowerEnclosed,
    homeWasBroken,
    baselineOutside,
    baselinePocketWaste,
    aliveHouseKeys,
  };

  return selectBestPlacement(scored, allCandidates, scoringCtx, {
    player,
    castle,
    castleMargin,
    unenclosedTowers,
    noBuildTargets,
    hasManageableGaps:
      targetGaps.size > 0 && targetGaps.size <= MANAGEABLE_GAP_LIMIT,
  });
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

/** Pick the best placement from scored candidates, with gap-filler priority and fallback. */
function selectBestPlacement(
  scored: readonly Scored[],
  allCandidates: readonly Candidate[],
  scoringCtx: ScoringContext,
  extras: {
    player: Player;
    castle: Castle;
    castleMargin: number;
    unenclosedTowers: readonly Tower[];
    noBuildTargets: boolean;
    hasManageableGaps: boolean;
  },
): AiPlacement | null {
  const {
    walls,
    outside,
    state,
    allCastlesEnclosed,
    caresAboutHouses,
    caresAboutBonuses,
    aliveHouseKeys,
  } = scoringCtx;
  const { player, castle, noBuildTargets, hasManageableGaps } = extras;

  const fatBlockCountFor = memoize((candidate: Candidate) =>
    countFatBlocks(walls, candidate, aliveHouseKeys),
  );

  if (scored.length === 0) {
    // When everything is enclosed with no gaps, don't force-place fat walls
    if (noBuildTargets) {
      return null;
    }
    const isSmallEnclosure = memoize((candidate: Candidate) =>
      createsSmallEnclosure(candidate, walls, outside, state, aliveHouseKeys),
    );

    const open = allCandidates.filter(
      (c) =>
        c.wallAdjacent === 0 &&
        fatBlockCountFor(c) === 0 &&
        !isSmallEnclosure(c),
    );
    if (open.length > 0) {
      open.sort(
        (a, b) =>
          candidateObstacleHits(a, caresAboutHouses, caresAboutBonuses) -
          candidateObstacleHits(b, caresAboutHouses, caresAboutBonuses),
      );
      return candidateToPlacement(open[0]!);
    }
    // Allow fat-free first, fall back to least fat — still reject small enclosures
    const noFat = allCandidates.filter(
      (c) => fatBlockCountFor(c) === 0 && !isSmallEnclosure(c),
    );
    if (noFat.length > 0) {
      return candidateToPlacement(noFat[0]!);
    }
    // Last resort: least fat, prefer no small enclosure
    const least = [...allCandidates].sort((a, b) => {
      const aEncloses = isSmallEnclosure(a) ? 1 : 0;
      const bEncloses = isSmallEnclosure(b) ? 1 : 0;
      if (aEncloses !== bEncloses) return aEncloses - bEncloses;
      return fatBlockCountFor(a) - fatBlockCountFor(b);
    });
    return candidateToPlacement(least[0]!);
  }

  const sortedScored = [...scored].sort((a, b) => b.score - a.score);
  let topCandidates = sortedScored.slice(0, scoringCtx.skill.topCandidates);

  // When the target has manageable gaps (1-8) and at least one candidate fills
  // a gap, restrict the final scoring to gap-filling candidates only.
  // This prevents territory gain elsewhere from out-scoring the gap closure.
  // Threshold matches canPieceFillAnyGap — if the piece CAN fill a gap, it SHOULD.
  let restrictedToGapFillers = false;
  if (hasManageableGaps) {
    const sortedGapFillers = sortedScored.filter(
      (score) => score.candidate.gapsFilled > 0,
    );
    if (sortedGapFillers.length > 0) {
      topCandidates = sortedGapFillers.slice(0, scoringCtx.skill.topCandidates);
      restrictedToGapFillers = true;
    }
  }

  const {
    bestCandidate,
    bestScore,
    evaluated: bestCandidateEvaluated,
  } = scoreTopCandidates(topCandidates, scoringCtx);

  // All enclosed, no gaps, no towers to build toward — still allow
  // expansion if scoring found a positive placement (new large enclosure).
  // rejectTinyPockets already filtered out small-pocket candidates at
  // skill ≥ 3, so bestScore > 0 means genuinely useful territory gain.
  if (noBuildTargets && bestScore <= 0) return null;

  // Gap-filling was the priority but territory gain was ≤ 0 — still use the
  // best gap-filler by first-pass score (closing the ring IS the goal).
  // Only if we actually evaluated a candidate (fat-wall-only sets get skipped
  // entirely and should fall through to discard/extension instead).
  // Reject fat walls even here — a gap-fill that creates 2×2 blocks without
  // enclosing territory is wasteful.
  if (bestScore <= 0 && restrictedToGapFillers && bestCandidateEvaluated) {
    if (fatBlockCountFor(bestCandidate) === 0) {
      return candidateToPlacement(bestCandidate);
    }
    // Fat wall gap-filler — find a non-fat alternative among gap fillers
    const nonFatGapFillers = topCandidates.filter(
      (score) =>
        score.candidate.gapsFilled > 0 &&
        fatBlockCountFor(score.candidate) === 0,
    );
    if (nonFatGapFillers.length > 0) {
      nonFatGapFillers.sort(compareByNumericScoreDesc);
      return candidateToPlacement(nonFatGapFillers[0]!.candidate);
    }
    // All gap fillers are fat — accept the best one anyway if the ring
    // is still open, because closing the castle outweighs the fat penalty.
    if (!allCastlesEnclosed) {
      return candidateToPlacement(bestCandidate);
    }
  }

  // If no territory gain: discard or build toward unenclosed towers
  if (bestScore <= 0) {
    return pickFallbackPlacement(sortedScored, state, {
      walls: player.walls,
      outside,
      playerInterior: getInterior(player),
      castle,
      castleMargin: extras.castleMargin,
      homeWasBroken: scoringCtx.homeWasBroken,
      unenclosedTowers: extras.unenclosedTowers,
      caresAboutHouses,
      caresAboutBonuses,
    }).placement;
  }

  return {
    piece: bestCandidate.piece,
    row: bestCandidate.row,
    col: bestCandidate.col,
  };
}

/** Look up skill config by 1-based buildSkill level (1=clumsy, 5=clean). */
function getBuildSkillConfig(buildSkill: 1 | 2 | 3 | 4 | 5): BuildSkillConfig {
  return BUILD_SKILL_TABLE[buildSkill - 1]!;
}

/** Enumerate all valid placements for a piece, scoring adjacency/gap metrics. */
function enumerateCandidates(
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  walls: ReadonlySet<TileKey>,
  outside: Set<TileKey>,
  targetGaps: Set<TileKey>,
  interiorExcludingGaps: Set<TileKey>,
): Candidate[] {
  const cache = buildOccupancyCache(state);
  const placementCtx = buildPlacementContext(state, playerId);
  if (!placementCtx) return [];
  const candidates: Candidate[] = [];
  let rotated = piece;
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let r = 0; r < GRID_ROWS - rotated.height + 1; r++) {
      for (let c = 0; c < GRID_COLS - rotated.width + 1; c++) {
        if (
          !canPlacePiece(
            state,
            playerId,
            rotated.offsets,
            r,
            c,
            interiorExcludingGaps,
            cache,
            placementCtx,
          )
        )
          continue;

        const {
          gapsFilled,
          wallAdjacent,
          connectedTiles,
          gapAdjacent,
          isolated,
        } = scoreCandidateGapMetrics(r, c, rotated.offsets, walls, targetGaps);

        if (rotated.offsets.length > 1) {
          let anyOutsideOrGap = false;
          for (const [dr, dc] of rotated.offsets) {
            const k = packTile(r + dr, c + dc);
            if (outside.has(k) || targetGaps.has(k)) {
              anyOutsideOrGap = true;
              break;
            }
          }
          if (!anyOutsideOrGap) continue;
        }

        let housesHit = 0;
        let bonusHit = 0;
        for (const [dr, dc] of rotated.offsets) {
          const pr = r + dr,
            pc = c + dc;
          if (hasAliveHouseAt(state, pr, pc)) housesHit++;
          if (
            state.bonusSquares.some(
              (bonus) => bonus.row === pr && bonus.col === pc,
            )
          )
            bonusHit++;
        }
        // Every offset on an alive house means zero walls will be laid
        // (applyPiecePlacement filters house tiles out of wallKeys) and
        // grunts spawn against the placing player. Strictly bad — reject.
        if (housesHit === rotated.offsets.length) continue;

        candidates.push({
          row: r,
          col: c,
          piece: rotated,
          gapsFilled,
          wallAdjacent,
          connectedTiles,
          gapAdjacent,
          isolated,
          housesHit,
          bonusHit,
        });
      }
    }
    rotated = rotateCW(rotated);
  }
  return candidates;
}

/** Select which rectangle to build/repair.
 *  Pipeline: tryRepairHomeCastle → trySecondaryTower → tryExpandTerritory.
 *  Each phase only runs if the previous one found no gaps. */
function selectTarget(ctx: TargetContext): TargetResult {
  // Phase 1: repair home castle ring
  const home = tryRepairHomeCastle(ctx);
  if (home.targetGaps.size > 0) return home;
  // Phase 2: build toward best unenclosed secondary tower
  const secondary = trySecondaryTower(ctx);
  if (secondary.targetGaps.size > 0) return secondary;
  // Phase 3: expand territory when all towers are enclosed
  return tryExpandTerritory(ctx);
}

/** Score all candidates with gap/wall/fat-wall metrics; filter fat walls when no gaps remain. */
function prescoreCandidates(
  allCandidates: readonly Candidate[],
  walls: ReadonlySet<TileKey>,
  noTargetGaps: boolean,
  aliveHouseKeys: ReadonlySet<TileKey>,
): Scored[] {
  const scored: Scored[] = [];
  for (const candidate of allCandidates) {
    const { hasFatWall, gapClosingFat } = checkFatWall(
      walls,
      candidate,
      aliveHouseKeys,
    );

    if (noTargetGaps && (hasFatWall || gapClosingFat)) continue;

    const fatBlocks = countFatBlocks(walls, candidate, aliveHouseKeys);

    scored.push({
      candidate,
      score:
        candidate.gapsFilled * GAP_FILLED_WEIGHT +
        candidate.gapAdjacent * GAP_ADJACENT_WEIGHT +
        candidate.connectedTiles * CONNECTED_TILES_WEIGHT +
        candidate.wallAdjacent -
        (hasFatWall ? FAT_WALL_TILE_PENALTY : 0),
      gapClosingFat,
      hasFatWall,
      fatBlocks,
    });
  }
  return scored;
}

/** Phase 1: repair the home castle ring, expanding around temporary blockers.
 *  Tries the player's existing outer wall ring first (preserves territory),
 *  then falls back to the ideal small castle ring. */
function tryRepairHomeCastle(ctx: TargetContext): TargetResult {
  const {
    state,
    playerId,
    player,
    piece,
    castle,
    effectiveSkipHome,
    homeHasRingGaps,
  } = ctx;
  if (effectiveSkipHome || !homeHasRingGaps) return NO_TARGET;
  // Prefer the player's existing outer perimeter when it's salvageable —
  // the ideal castle rect collapses to ~36 interior tiles and the territory
  // sweep destroys every outer wall that no longer bounds an enclosed region.
  // BUT only commit to the outer ring when the *current* piece can fill at
  // least one of its gaps. Otherwise scoring produces score≤0 (no piece
  // overlaps the 1–8 ring-hole tiles, so no enclosure is closed), and the
  // selector falls through to pickFallbackPlacement which runs
  // createsSmallEnclosure on hundreds of candidates per tick. The outer
  // ring is a recommendation; falling through to the ideal-castle target
  // for one tick still pursues "enclose the tower" — next piece may help
  // the outer ring instead.
  const outer = tryRepairOuterRing(ctx);
  if (
    outer.targetGaps.size > 0 &&
    canPieceFillAnyGap(
      state,
      playerId,
      piece,
      getInterior(player),
      outer.targetGaps,
      null,
    )
  ) {
    return outer;
  }
  if (castle.top > castle.bottom || castle.left > castle.right)
    return NO_TARGET;

  // Home castle: use the rect recomputed in pickPlacement (via createCastle
  // against effectivePlanTiles). It matches the actual walls while the
  // selection-time modifier projection still holds; after a tile-projecting
  // modifier (e.g. high_tide) clears, the recomputed rect drifts to the
  // natural-shoreline shape — repair scoring may chase phantom gaps on the
  // wider side. Bounded suboptimality, never cross-peer desync.
  const homeRect = castle;
  let { top, bottom, left, right } = homeRect;

  const freeRatio = computeInteriorFreeRatio(homeRect, player, state);
  const MAX_EXPAND =
    EXPANSION_TIERS.find((tier) => freeRatio > tier.minFreeRatio)?.maxExpand ??
    EXPANSION_DEFAULT_MAX;

  for (let attempt = 0; attempt < MAX_EXPAND; attempt++) {
    const gaps = findGapTiles({ top, bottom, left, right }, player.walls);
    const wallRingTop = top - 1,
      wallRingBottom = bottom + 1,
      wallRingLeft = left - 1,
      wallRingRight = right + 1;
    let expanded = false;

    for (const key of gaps) {
      const { row, col } = unpackTile(key);
      // Only expand for temporary blockers (grunts, burning pits, alive
      // houses — house tiles turn placed walls into grunts, so the gap
      // doesn't actually close). Water is permanent terrain — expanding
      // just creates more water gaps.
      if (!isGrass(state.map.tiles, row, col)) continue;
      const blocked =
        hasGruntAt(state.grunts, row, col) ||
        hasPitAt(state.burningPits, row, col) ||
        hasAliveHouseAt(state, row, col);
      if (!blocked) continue;

      if (
        row === wallRingTop &&
        top - 1 >= homeRect.top - MAX_EXPAND &&
        top - 1 >= 1
      ) {
        top--;
        expanded = true;
      }
      if (
        row === wallRingBottom &&
        bottom + 1 <= homeRect.bottom + MAX_EXPAND &&
        bottom + 1 < GRID_ROWS - 1
      ) {
        bottom++;
        expanded = true;
      }
      if (
        col === wallRingLeft &&
        left - 1 >= homeRect.left - MAX_EXPAND &&
        left - 1 >= 1
      ) {
        left--;
        expanded = true;
      }
      if (
        col === wallRingRight &&
        right + 1 <= homeRect.right + MAX_EXPAND &&
        right + 1 < GRID_COLS - 1
      ) {
        right++;
        expanded = true;
      }
    }

    if (!expanded) break;
  }
  const targetRect: TileRect = { top, bottom, left, right };
  const targetGaps = findReachableRingGaps(
    targetRect,
    player.walls,
    state,
    getInterior(player),
  );

  // Verify the piece can actually fill these gaps (try plugging if needed)
  if (
    targetGaps.size > 0 &&
    targetGaps.size <= MANAGEABLE_GAP_LIMIT &&
    !canFillAfterPlugging(ctx, targetGaps, targetRect)
  ) {
    return NO_TARGET;
  }
  return { targetGaps, targetRect };
}

/** Try repairing the player's existing outer wall ring (the bounding box
 *  of player.walls) when it's larger than the ideal castle and the breach
 *  is closeable this turn. Falls through (returns NO_TARGET) when the
 *  outer ring is too far gone to be worth chasing — caller then falls
 *  back to the ideal-castle repair logic. */
function tryRepairOuterRing(ctx: TargetContext): TargetResult {
  const { player, castle } = ctx;
  if (player.walls.size === 0) return NO_TARGET;
  const outerRect = computeWallsInteriorBox(player.walls);
  if (!outerRect) return NO_TARGET;
  // Must contain the home tower — otherwise we're not looking at this
  // player's castle at all (stray walls from elsewhere).
  if (
    castle.tower.row < outerRect.top ||
    castle.tower.row + 1 > outerRect.bottom ||
    castle.tower.col < outerRect.left ||
    castle.tower.col + 1 > outerRect.right
  )
    return NO_TARGET;
  // Must be meaningfully bigger than the ideal castle — when the existing
  // ring IS the ideal castle, the existing logic below handles it correctly
  // (including grunt/pit expansion). Outer-ring repair only earns its keep
  // when the player has expanded beyond the ideal shape.
  const outerArea =
    (outerRect.bottom - outerRect.top + 1) *
    (outerRect.right - outerRect.left + 1);
  const idealArea =
    (castle.bottom - castle.top + 1) * (castle.right - castle.left + 1);
  if (outerArea <= idealArea) return NO_TARGET;
  // Detect breach tiles by scanning for short non-wall runs between paired
  // walls. The strategy snapshots the initial gap set on the first tick of
  // each build phase; we drop tiles the AI has since walled. Recomputing
  // each tick would pick up "phantom" gaps where AI-placed walls happen to
  // pair with original walls, dispersing the AI's focus.
  const gaps = snapshotMinusFilled(ctx.outerRingHolesSnapshot, player.walls);
  // Already closed (gaps=0) means the outer ring isn't actually breached;
  // homeTowerEnclosed would also be true and we wouldn't reach this path.
  // Many gaps means the outer ring is too shelled to be a realistic target
  // this turn — fall through to the ideal-castle retreat.
  if (gaps.size === 0 || gaps.size > MANAGEABLE_GAP_LIMIT) return NO_TARGET;
  // Note: no canFillAfterPlugging() guard here. Outer-ring repair is the
  // strategic goal for the whole phase, not just this tick — if the current
  // piece can't fill any of the remaining gaps, we still want to KEEP the
  // outer ring as the target (so scoring rewards wall-adjacent placements
  // along the existing perimeter) instead of falling through to the inner
  // castle. Inner-castle construction would break the outer ring and the
  // end-of-build wall sweep would then destroy the player's investment.
  return { targetGaps: gaps, targetRect: outerRect };
}

/** Filter a snapshot gap set to tiles still un-walled. */
function snapshotMinusFilled(
  snapshot: ReadonlySet<TileKey>,
  walls: ReadonlySet<TileKey>,
): Set<TileKey> {
  const remaining = new Set<TileKey>();
  for (const key of snapshot) if (!walls.has(key)) remaining.add(key);
  return remaining;
}

/** Compute the interior rect for the bounding box of a wall set, in the
 *  shape findGapTiles expects (interior tiles, with the wall ring one tile
 *  outside). Returns null when the walls don't span at least a 3×3 area. */
function computeWallsInteriorBox(walls: ReadonlySet<TileKey>): TileRect | null {
  const bbox = computeWallsBBox(walls);
  if (bbox === null) return null;
  if (bbox.maxR - bbox.minR < 2 || bbox.maxC - bbox.minC < 2) return null;
  return {
    top: bbox.minR + 1,
    bottom: bbox.maxR - 1,
    left: bbox.minC + 1,
    right: bbox.maxC - 1,
  };
}

/** Fraction of interior tiles that are unoccupied (no wall, tower, cannon, or water). */
function computeInteriorFreeRatio(
  rect: TileRect,
  player: Player,
  state: BuildViewState,
): number {
  let total = 0;
  let occupied = 0;
  for (let row = rect.top; row <= rect.bottom; row++) {
    for (let col = rect.left; col <= rect.right; col++) {
      total++;
      const key = packTile(row, col);
      if (
        player.walls.has(key) ||
        !isGrass(state.map.tiles, row, col) ||
        hasTowerAt(state, row, col) ||
        hasCannonAt(state, row, col)
      ) {
        occupied++;
      }
    }
  }
  return total > 0 ? 1 - occupied / total : 1;
}

/** Phase 2: score unenclosed towers and pick the best one the current piece can fill. */
function trySecondaryTower(ctx: TargetContext): TargetResult {
  const {
    state,
    player,
    castle,
    castleMargin,
    bankHugging,
    cursorPos,
    effectiveSkipHome,
    unenclosedTowers,
    otherUnenclosed,
  } = ctx;
  const buildTowers = effectiveSkipHome ? otherUnenclosed : unenclosedTowers;
  if (buildTowers.length === 0) return NO_TARGET;

  const currentRow = cursorPos?.row ?? castle.tower.row;
  const currentCol = cursorPos?.col ?? castle.tower.col;

  // Score all towers, then try them in order — skip towers whose ring is unfillable
  const towerScores = buildTowers.map((tower) =>
    scoreBuildTowerTarget(
      tower,
      state,
      player,
      currentRow,
      currentCol,
      castleMargin,
      bankHugging,
    ),
  );
  towerScores.sort(compareByNumericScoreDesc);

  for (const { tower: bestTower } of towerScores) {
    const rect = castleRect(
      bestTower,
      state.map.tiles,
      state.map.towers,
      castleMargin,
      !bankHugging,
    );
    const totalGaps = findGapTiles(rect, player.walls).size;
    const gaps = computeFillableGaps(
      rect,
      player.walls,
      getInterior(player),
      state,
      bankHugging,
    );
    // Accept if there are fillable gaps, or if the ring was already complete
    if (gaps.size > 0 || totalGaps === 0) {
      // If the current piece can't fill this tower's gaps, try the next tower
      if (
        gaps.size > 0 &&
        gaps.size <= MANAGEABLE_GAP_LIMIT &&
        !canFillAfterPlugging(ctx, gaps, rect)
      ) {
        continue;
      }
      return { targetGaps: gaps, targetRect: rect };
    }
  }
  return NO_TARGET;
}

/** Phase 3: all towers enclosed — expand territory outward.
 *  Compute bounding box of existing walls, expand by 2, and treat
 *  the expanded ring as gaps to fill over multiple rounds. */
function tryExpandTerritory(ctx: TargetContext): TargetResult {
  const { state, player, bankHugging, allCastlesEnclosed } = ctx;
  if (!allCastlesEnclosed) return NO_TARGET;

  const bbox = computeWallsBBox(player.walls);
  if (bbox === null) return NO_TARGET;
  const expandRect: TileRect = {
    top: Math.max(1, bbox.minR + 1),
    bottom: Math.min(GRID_ROWS - 2, bbox.maxR - 1 + TERRITORY_EXPAND_RING),
    left: Math.max(1, bbox.minC + 1),
    right: Math.min(GRID_COLS - 2, bbox.maxC - 1 + TERRITORY_EXPAND_RING),
  };
  if (
    expandRect.top > expandRect.bottom ||
    expandRect.left > expandRect.right
  ) {
    return NO_TARGET;
  }
  const gaps = computeFillableGaps(
    expandRect,
    player.walls,
    getInterior(player),
    state,
    bankHugging,
  );
  if (gaps.size === 0) return NO_TARGET;
  // Gate on canPieceFillAnyGap — without it, the scorer runs a full candidate
  // sweep against expand gaps even when the current piece can't help, which
  // forces pickFallbackPlacement to call createsSmallEnclosure on hundreds of
  // candidates per tick. Mirrors the gate trySecondaryTower applies.
  if (
    gaps.size <= MANAGEABLE_GAP_LIMIT &&
    !canFillAfterPlugging(ctx, gaps, expandRect)
  ) {
    return NO_TARGET;
  }
  return { targetGaps: gaps, targetRect: expandRect };
}

/** Try plugging structurally unreachable gaps (e.g. thick walls from + pieces)
 *  then re-check whether the current piece can fill any gap.
 *  Returns true if the piece can fill at least one gap after plugging. */
function canFillAfterPlugging(
  ctx: TargetContext,
  gaps: Set<TileKey>,
  rect: TileRect | null,
): boolean {
  const { state, playerId, player, piece } = ctx;
  const interior = getInterior(player);
  if (canPieceFillAnyGap(state, playerId, piece, interior, gaps, rect))
    return true;
  return (
    plugUnreachableGaps(gaps, rect, state, playerId, player.walls, interior) &&
    canPieceFillAnyGap(state, playerId, piece, interior, gaps, rect)
  );
}

/** Min/max R,C bounding box of a wall set (empty → null). Callers shape it
 *  into whatever rect they need — interior box, expansion ring, etc. */
function computeWallsBBox(walls: ReadonlySet<TileKey>): TileBounds | null {
  let minR = Infinity,
    maxR = -Infinity,
    minC = Infinity,
    maxC = -Infinity;
  for (const key of walls) {
    const { row, col } = unpackTile(key);
    if (row < minR) minR = row;
    if (row > maxR) maxR = row;
    if (col < minC) minC = col;
    if (col > maxC) maxC = col;
  }
  if (!Number.isFinite(minR)) return null;
  return { minR, maxR, minC, maxC };
}

/** Analyze board enclosures: which towers are open, whether to skip home, etc. */
function analyzeEnclosures(
  state: BuildViewState,
  player: Player,
  castle: Castle,
  castleMargin: number,
  bankHugging: boolean,
  homeWasBroken: boolean,
): EnclosureAnalysis {
  const zoneTowers = state.map.towers.filter(
    (tower) => tower.zone === castle.tower.zone,
  );

  // `outside` is still needed for the 4-dir diagonal-leak disambiguation
  // (towerReachesOutsideCardinal) and for hasMeaningfulHomeRingGaps. The
  // 8-dir "is this tower enclosed by my walls" question is answered by
  // player.ownedTowers, which recheckTerritory keeps in sync via the same
  // computeOutside-derived interior.
  const outside = computeOutside(player.walls);
  const ownedTowerSet = new Set(player.ownedTowers.map((tower) => tower.index));
  const homeTowerEnclosed = ownedTowerSet.has(castle.tower.index);
  // 4-dir BFS from a tower: returns true if the BFS can reach the map
  // border without crossing walls.
  const unenclosedTowers = zoneTowers.filter((tower) => {
    if (!ownedTowerSet.has(tower.index)) {
      // 8-dir flood says not enclosed. But if 4-dir BFS can't reach the
      // map border, the tower only has diagonal leaks — walls form a
      // complete orthogonal ring. Treat as enclosed to avoid building a
      // full castleRect that creates fat walls around the existing ring.
      // But first: if the expected ring has fillable gaps, the tower
      // genuinely needs repair (e.g. a single missing corner — 4-dir BFS
      // can't escape through the diagonal but the gap is real).
      if (!towerReachesOutsideCardinal(tower, player.walls)) {
        const rect = castleRect(
          tower,
          state.map.tiles,
          state.map.towers,
          castleMargin,
          !bankHugging,
        );
        const ringGaps = findReachableRingGaps(
          rect,
          player.walls,
          state,
          getInterior(player),
        );
        if (ringGaps.size > 0) return true; // real gaps need filling
        return false;
      }
      return true;
    }
    // 8-directional flood says enclosed, but diagonal wall connections can
    // create false positives. Verify with 4-directional BFS from the tower:
    // if we can reach an "outside" tile, the tower isn't truly enclosed.
    if (towerReachesOutsideCardinal(tower, player.walls, outside)) return true;
    // Truly enclosed (BFS confirmed) — territory will count this tower.
    return false;
  });
  const allCastlesEnclosed = unenclosedTowers.length === 0;

  // If home was broken or its tower is dead, deprioritize it if there are other unenclosed towers
  // But only skip if the gap is large (> 5 tiles) — small holes are worth repairing
  const homeTowerDead = !state.towerAlive[castle.tower.index];
  const otherUnenclosed = unenclosedTowers.filter(
    (tower) => tower !== castle.tower,
  );
  let effectiveSkipHome =
    (homeWasBroken || homeTowerDead) && otherUnenclosed.length > 0;
  if (effectiveSkipHome && !homeTowerEnclosed) {
    const homeGaps = findGapTiles(castle, player.walls);
    if (homeGaps.size <= HOME_GAP_REPAIR_THRESHOLD) effectiveSkipHome = false;
  }

  const homeHasRingGaps = hasMeaningfulHomeRingGaps(
    homeTowerEnclosed,
    castle,
    player.walls,
    outside,
    state,
    getInterior(player),
  );

  return {
    outside,
    homeTowerEnclosed,
    zoneTowers,
    unenclosedTowers,
    otherUnenclosed,
    allCastlesEnclosed,
    effectiveSkipHome,
    homeHasRingGaps,
  };
}

function scoreCandidateGapMetrics(
  row: number,
  col: number,
  offsets: ReadonlyArray<readonly [number, number]>,
  walls: ReadonlySet<TileKey>,
  targetGaps: Set<TileKey>,
): {
  gapsFilled: number;
  wallAdjacent: number;
  connectedTiles: number;
  gapAdjacent: number;
  isolated: number;
} {
  let gapsFilled = 0;
  let wallAdjacent = 0;
  let connectedTiles = 0;
  let gapAdjacent = 0;
  let isolated = 0;

  for (const [dr, dc] of offsets) {
    const pr = row + dr;
    const pc = col + dc;
    if (!inBounds(pr, pc)) continue;
    const key = packTile(pr, pc);
    if (targetGaps.has(key)) {
      gapsFilled++;
      continue;
    }
    let hasWallAdjacent = false;
    let hasGapAdjacent = false;
    for (const [ar, ac] of DIRS_4) {
      const nr = pr + ar;
      const nc = pc + ac;
      if (!inBounds(nr, nc)) continue;
      const neighborKey = packTile(nr, nc);
      if (walls.has(neighborKey)) {
        wallAdjacent++;
        hasWallAdjacent = true;
      }
      if (targetGaps.has(neighborKey)) hasGapAdjacent = true;
    }
    if (hasWallAdjacent) connectedTiles++;
    if (hasGapAdjacent) gapAdjacent++;
    if (!hasWallAdjacent && !hasGapAdjacent) isolated++;
  }

  for (const [dr, dc] of offsets) {
    const pr = row + dr;
    const pc = col + dc;
    if (!inBounds(pr, pc)) continue;
    if (!targetGaps.has(packTile(pr, pc))) continue;
    let hasWallAdjacent = false;
    for (const [ar, ac] of DIRS_4) {
      const nr = pr + ar;
      const nc = pc + ac;
      if (!inBounds(nr, nc)) continue;
      if (walls.has(packTile(nr, nc))) {
        wallAdjacent++;
        hasWallAdjacent = true;
      }
    }
    if (hasWallAdjacent) connectedTiles++;
  }

  return { gapsFilled, wallAdjacent, connectedTiles, gapAdjacent, isolated };
}
