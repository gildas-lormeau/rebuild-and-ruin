/**
 * AI Strategy — build phase piece placement orchestrator.
 *
 * Coordinates the build placement pipeline:
 *   1. ai-build-target.ts  — select which tower ring to repair
 *   2. enumerateCandidates  — brute-force all rotations × positions
 *   3. ai-build-score.ts   — territory gain scoring and fat wall checks
 *   4. ai-build-fallback.ts — discard / extension when no gain
 *
 * Castle rectangle and gap analysis live in ai-castle-rect.ts.
 */

import {
  createsSmallEnclosure,
  memoize,
  pickFallbackPlacement,
} from "./ai-build-fallback.ts";
import {
  candidateToPlacement,
  checkFatWall,
  compareByNumericScoreDesc,
  compareCandidatesByObstaclePreference,
  compareScoredByScoreDesc,
  countFatBlocks,
  countSmallPocketTiles,
  FAT_WALL_TILE_PENALTY,
  scoreTopCandidates,
} from "./ai-build-score.ts";
import { canPieceFillAnyGap, plugUnreachableGaps } from "./ai-build-target.ts";
import type {
  AiPlacement,
  Candidate,
  PlacementOptions,
  Scored,
  ScoringContext,
} from "./ai-build-types.ts";
import {
  castleRect,
  computeFillableGaps,
  filterUnfillableGaps,
  findGapTiles,
  hasMeaningfulHomeRingGaps,
  scoreBuildTowerTarget,
} from "./ai-castle-rect.ts";
import { getInterior, hasGruntAt } from "./board-occupancy.ts";
import { canPlacePiece } from "./build-system.ts";
import type { ValidPlayerSlot } from "./game-constants.ts";
import type { TileRect } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import { type PieceShape, rotateCW } from "./pieces.ts";
import {
  computeOutside,
  DIRS_4,
  hasPitAt,
  isCannonTile,
  isGrass,
  isTowerEnclosed,
  isTowerTile,
  packTile,
  towerReachesOutsideCardinal,
  unpackTile,
} from "./spatial.ts";
import type { GameState } from "./types.ts";

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

export function pickPlacement(
  state: GameState,
  playerId: ValidPlayerSlot,
  piece: PieceShape,
  options?: PlacementOptions,
): AiPlacement | null {
  const {
    cursorPos,
    homeWasBroken,
    /** Tile margin around the home tower for castle ring placement.
     *  Derived from AI aggressiveness (2 or 3). Default 3 = widest ring. */
    castleMargin = 3,
    bankHugging = false,
    caresAboutHouses = true,
    caresAboutBonuses = true,
    buildSkill = 3,
  } = options ?? {};
  const maybePlayer = state.players[playerId];
  if (!maybePlayer || !maybePlayer.castle) return null;
  const player = maybePlayer;
  const castle = maybePlayer.castle;

  // Skill-derived parameters (level 1 = clumsy, 5 = clean builder)
  //   topCandidates:    how many placements get full territory-gain evaluation
  //   fatGainPerBlock:  useful-gain required per 2×2 fat block to pass hard reject
  //   pocketScale:      multiplier on pocket delta penalty
  //   fatPenaltyScale:  multiplier on fat wall scoring penalty
  //   tinyPocketReject: whether tiny-pocket hard reject is active
  const skill = getBuildSkillConfig(buildSkill);
  const zoneTowers = state.map.towers.filter(
    (tower) => tower.zone === castle.tower.zone,
  );

  // Enclosure detection must match territory's computeOutside (no water
  // barriers) so the AI and recheckTerritoryOnly agree on which towers are enclosed.
  // Water-as-barrier made the AI think bank-adjacent castles were closed when
  // territory's plain flood could still enter through the bank.
  const walls = player.walls;
  const outside = computeOutside(walls);
  const homeTowerEnclosed = isTowerEnclosed(castle.tower, outside);
  // 4-dir BFS from a tower: returns true if the BFS can reach the map
  // border without crossing walls.
  const unenclosedTowers = zoneTowers.filter((tower) => {
    if (!isTowerEnclosed(tower, outside)) {
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
        const ringGaps = findGapTiles(rect, player.walls);
        filterUnfillableGaps(ringGaps, state, getInterior(player));
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

  // Step 1: determine which rectangle to build/repair.
  // Pipeline: tryRepairHomeCastle → trySecondaryTower → tryExpandTerritory
  // Each phase only runs if the previous one found no gaps.

  type TargetResult = { targetGaps: Set<number>; targetRect: TileRect | null };
  const NO_TARGET: TargetResult = {
    targetGaps: new Set(),
    targetRect: null,
  };

  /** Try plugging structurally unreachable gaps (e.g. thick walls from + pieces)
   *  then re-check whether the current piece can fill any gap.
   *  Returns true if the piece can fill at least one gap after plugging. */
  function canFillAfterPlugging(
    gaps: Set<number>,
    rect: TileRect | null,
  ): boolean {
    const interior = getInterior(player);
    if (canPieceFillAnyGap(state, playerId, piece, interior, gaps, rect))
      return true;
    return (
      plugUnreachableGaps(
        gaps,
        rect,
        state,
        playerId,
        player.walls,
        interior,
      ) && canPieceFillAnyGap(state, playerId, piece, interior, gaps, rect)
    );
  }

  /** Phase 1: repair the home castle ring, expanding around temporary blockers. */
  function tryRepairHomeCastle(): TargetResult {
    if (effectiveSkipHome || !homeHasRingGaps) return NO_TARGET;
    if (castle.top > castle.bottom || castle.left > castle.right)
      return NO_TARGET;

    // Home castle: always use original bounds from buildCastle — existing walls
    // match this ring, so repair targets the actual gaps instead of upgrading
    const homeRect = castle;
    let { top, bottom, left, right } = homeRect;

    let totalInterior = 0;
    let occupiedInterior = 0;
    for (let r = homeRect.top; r <= homeRect.bottom; r++) {
      for (let c = homeRect.left; c <= homeRect.right; c++) {
        totalInterior++;
        const k = packTile(r, c);
        if (player.walls.has(k)) {
          occupiedInterior++;
          continue;
        }
        if (!isGrass(state.map.tiles, r, c)) {
          occupiedInterior++;
          continue;
        }
        for (const tower of state.map.towers) {
          if (isTowerTile(tower, r, c)) {
            occupiedInterior++;
            break;
          }
        }
        for (const other of state.players) {
          for (const cannon of other.cannons) {
            if (isCannonTile(cannon, r, c)) {
              occupiedInterior++;
              break;
            }
          }
        }
      }
    }
    const freeRatio =
      totalInterior > 0 ? 1 - occupiedInterior / totalInterior : 1;
    const MAX_EXPAND =
      EXPANSION_TIERS.find((tier) => freeRatio > tier.minFreeRatio)
        ?.maxExpand ?? EXPANSION_DEFAULT_MAX;

    let targetGaps: Set<number> = new Set();
    for (let attempt = 0; attempt < MAX_EXPAND; attempt++) {
      const gaps = findGapTiles({ top, bottom, left, right }, player.walls);
      const wallRingTop = top - 1,
        wallRingBottom = bottom + 1,
        wallRingLeft = left - 1,
        wallRingRight = right + 1;
      let expanded = false;

      for (const key of gaps) {
        const { r, c } = unpackTile(key);
        // Only expand for temporary blockers (grunts, burning pits).
        // Water is permanent terrain — expanding just creates more water gaps.
        if (!isGrass(state.map.tiles, r, c)) continue;
        const blocked =
          hasGruntAt(state, r, c) || hasPitAt(state.burningPits, r, c);
        if (!blocked) continue;

        if (
          r === wallRingTop &&
          top - 1 >= homeRect.top - MAX_EXPAND &&
          top - 1 >= 1
        ) {
          top--;
          expanded = true;
        }
        if (
          r === wallRingBottom &&
          bottom + 1 <= homeRect.bottom + MAX_EXPAND &&
          bottom + 1 < GRID_ROWS - 1
        ) {
          bottom++;
          expanded = true;
        }
        if (
          c === wallRingLeft &&
          left - 1 >= homeRect.left - MAX_EXPAND &&
          left - 1 >= 1
        ) {
          left--;
          expanded = true;
        }
        if (
          c === wallRingRight &&
          right + 1 <= homeRect.right + MAX_EXPAND &&
          right + 1 < GRID_COLS - 1
        ) {
          right++;
          expanded = true;
        }
      }

      if (!expanded) {
        targetGaps = gaps;
        break;
      }
    }
    targetGaps = findGapTiles({ top, bottom, left, right }, player.walls);
    filterUnfillableGaps(targetGaps, state, getInterior(player));
    const targetRect: TileRect = { top, bottom, left, right };

    // Verify the piece can actually fill these gaps (try plugging if needed)
    if (
      targetGaps.size > 0 &&
      targetGaps.size <= MANAGEABLE_GAP_LIMIT &&
      !canFillAfterPlugging(targetGaps, targetRect)
    ) {
      return NO_TARGET;
    }
    return { targetGaps, targetRect };
  }

  /** Phase 2: score unenclosed towers and pick the best one the current piece can fill. */
  function trySecondaryTower(): TargetResult {
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
          !canFillAfterPlugging(gaps, rect)
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
  function tryExpandTerritory(): TargetResult {
    if (!allCastlesEnclosed) return NO_TARGET;

    let minR = GRID_ROWS,
      maxR = 0,
      minC = GRID_COLS,
      maxC = 0;
    for (const key of player.walls) {
      const { r, c } = unpackTile(key);
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    const EXPAND = 2;
    const expandRect: TileRect = {
      top: Math.max(1, minR + 1),
      bottom: Math.min(GRID_ROWS - 2, maxR - 1 + EXPAND),
      left: Math.max(1, minC + 1),
      right: Math.min(GRID_COLS - 2, maxC - 1 + EXPAND),
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
    if (gaps.size > 0) return { targetGaps: gaps, targetRect: expandRect };
    return NO_TARGET;
  }

  function selectTarget(): TargetResult {
    // Phase 1: repair home castle ring
    const home = tryRepairHomeCastle();
    if (home.targetGaps.size > 0) return home;
    // Phase 2: build toward best unenclosed secondary tower
    const secondary = trySecondaryTower();
    if (secondary.targetGaps.size > 0) return secondary;
    // Phase 3: expand territory when all towers are enclosed
    return tryExpandTerritory();
  }

  const { targetGaps, targetRect } = selectTarget();
  const hasManageableGaps = (): boolean =>
    targetGaps.size > 0 && targetGaps.size <= MANAGEABLE_GAP_LIMIT;

  // Step 2: score candidates
  const baselineOutside = outside.size;

  // Interior excluding gaps and castle-rect tiles — lets the AI place pieces
  // freely inside an open (gapped) enclosure. Without this exclusion, scoring
  // would penalize placements near gaps that need filling.
  const interiorExcludingGaps = new Set(getInterior(player));
  for (const gk of targetGaps) interiorExcludingGaps.delete(gk);
  if (targetRect) {
    for (let r = targetRect.top; r <= targetRect.bottom; r++) {
      for (let c = targetRect.left; c <= targetRect.right; c++) {
        interiorExcludingGaps.delete(packTile(r, c));
      }
    }
  }

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

  const scored: Scored[] = [];
  const noTargetGaps = allCastlesEnclosed && targetGaps.size === 0;
  const noBuildTargets = noTargetGaps && unenclosedTowers.length === 0;

  for (const candidate of allCandidates) {
    const { hasFatWall, gapClosingFat } = checkFatWall(player.walls, candidate);

    if (noTargetGaps && (hasFatWall || gapClosingFat)) continue;

    const fatBlocks = countFatBlocks(player.walls, candidate);

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

  const fatBlockCountFor = memoize((candidate: Candidate) =>
    countFatBlocks(player.walls, candidate),
  );

  if (scored.length === 0) {
    // When everything is enclosed with no gaps, don't force-place fat walls
    if (noBuildTargets) {
      return null;
    }
    const noSmallEnclosure = (c: Candidate): boolean =>
      !createsSmallEnclosure(c, walls, outside, state);

    const open = allCandidates.filter(
      (c) =>
        c.wallAdjacent === 0 &&
        fatBlockCountFor(c) === 0 &&
        noSmallEnclosure(c),
    );
    if (open.length > 0) {
      open.sort((a, b) =>
        compareCandidatesByObstaclePreference(
          a,
          b,
          caresAboutHouses,
          caresAboutBonuses,
        ),
      );
      return candidateToPlacement(open[0]!);
    }
    // Allow fat-free first, fall back to least fat — still reject small enclosures
    const noFat = allCandidates.filter(
      (c) => fatBlockCountFor(c) === 0 && noSmallEnclosure(c),
    );
    if (noFat.length > 0) {
      return candidateToPlacement(noFat[0]!);
    }
    // Last resort: least fat, prefer no small enclosure
    const least = [...allCandidates].sort((a, b) => {
      const aEncloses = createsSmallEnclosure(a, walls, outside, state) ? 1 : 0;
      const bEncloses = createsSmallEnclosure(b, walls, outside, state) ? 1 : 0;
      if (aEncloses !== bEncloses) return aEncloses - bEncloses;
      return fatBlockCountFor(a) - fatBlockCountFor(b);
    });
    return candidateToPlacement(least[0]!);
  }

  scored.sort(compareScoredByScoreDesc);
  let topCandidates = scored.slice(0, skill.topCandidates);

  // When the target has manageable gaps (1-8) and at least one candidate fills
  // a gap, restrict the final scoring to gap-filling candidates only.
  // This prevents territory gain elsewhere from out-scoring the gap closure.
  // Threshold matches canPieceFillAnyGap — if the piece CAN fill a gap, it SHOULD.
  let restrictedToGapFillers = false;
  if (hasManageableGaps()) {
    const allGapFillers = scored.filter(
      (score) => score.candidate.gapsFilled > 0,
    );
    const topGapFillers = topCandidates.filter(
      (score) => score.candidate.gapsFilled > 0,
    );
    if (topGapFillers.length > 0) {
      topCandidates = topGapFillers;
      restrictedToGapFillers = true;
    } else if (allGapFillers.length > 0) {
      topCandidates = allGapFillers.slice(0, skill.topCandidates);
      restrictedToGapFillers = true;
    }
  }

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
  };
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
    const fb = pickFallbackPlacement(scored, state, {
      walls: player.walls,
      outside,
      interior: getInterior(player),
      castle,
      castleMargin,
      homeWasBroken: !!homeWasBroken,
      unenclosedTowers,
      caresAboutHouses,
      caresAboutBonuses,
    });
    if (fb) return fb.placement;
  }

  return {
    piece: bestCandidate.piece,
    row: bestCandidate.row,
    col: bestCandidate.col,
  };
}

/** Look up skill config by 1-based buildSkill level (1=clumsy, 5=clean). */
function getBuildSkillConfig(buildSkill: number): BuildSkillConfig {
  return BUILD_SKILL_TABLE[buildSkill - 1]!;
}

/** Enumerate all valid placements for a piece, scoring adjacency/gap metrics. */
function enumerateCandidates(
  state: GameState,
  playerId: ValidPlayerSlot,
  piece: PieceShape,
  walls: ReadonlySet<number>,
  outside: Set<number>,
  targetGaps: Set<number>,
  interiorExcludingGaps: Set<number>,
): Candidate[] {
  const candidates: Candidate[] = [];
  let rotated = piece;
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let r = 0; r < GRID_ROWS - rotated.height + 1; r++) {
      for (let c = 0; c < GRID_COLS - rotated.width + 1; c++) {
        if (
          !canPlacePiece(state, playerId, rotated, r, c, interiorExcludingGaps)
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
          if (
            state.map.houses.some(
              (h) => h.alive && h.row === pr && h.col === pc,
            )
          )
            housesHit++;
          if (state.bonusSquares.some((bs) => bs.row === pr && bs.col === pc))
            bonusHit++;
        }

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

function scoreCandidateGapMetrics(
  row: number,
  col: number,
  offsets: ReadonlyArray<readonly [number, number]>,
  walls: ReadonlySet<number>,
  targetGaps: Set<number>,
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
    const key = packTile(pr, pc);
    if (targetGaps.has(key)) {
      gapsFilled++;
      continue;
    }
    let hasWallAdjacent = false;
    let hasGapAdjacent = false;
    for (const [ar, ac] of DIRS_4) {
      const nk = packTile(pr + ar, pc + ac);
      if (walls.has(nk)) {
        wallAdjacent++;
        hasWallAdjacent = true;
      }
      if (targetGaps.has(nk)) hasGapAdjacent = true;
    }
    if (hasWallAdjacent) connectedTiles++;
    if (hasGapAdjacent) gapAdjacent++;
    if (!hasWallAdjacent && !hasGapAdjacent) isolated++;
  }

  for (const [dr, dc] of offsets) {
    const pr = row + dr;
    const pc = col + dc;
    if (!targetGaps.has(packTile(pr, pc))) continue;
    let hasWallAdjacent = false;
    for (const [ar, ac] of DIRS_4) {
      if (walls.has(packTile(pr + ar, pc + ac))) {
        wallAdjacent++;
        hasWallAdjacent = true;
      }
    }
    if (hasWallAdjacent) connectedTiles++;
  }

  return { gapsFilled, wallAdjacent, connectedTiles, gapAdjacent, isolated };
}
