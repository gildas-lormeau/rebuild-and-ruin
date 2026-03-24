/**
 * AI Strategy — build phase piece placement.
 *
 * Contains piece placement scoring, enumeration, and selection logic
 * used by DefaultStrategy. Castle rectangle and gap analysis live in
 * ai-castle-rect.ts.
 */

import {
  castleRect,
  computeFillableGaps,
  filterUnfillableGaps,
  findGapTiles,
  floodPocket,
  hasMeaningfulHomeRingGaps,
  scoreBuildTowerTarget,
} from "./ai-castle-rect.ts";
import { SMALL_POCKET_MAX_SIZE } from "./ai-constants.ts";
import {
  getCardinalObstacleMask,
  hasCannonAt,
  hasGruntAt,
  hasTowerAt,
  hasWallAt,
} from "./board-occupancy.ts";
import { isCannonEnclosed } from "./cannon-system.ts";
import type { TilePos, TileRect, Tower } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS, Tile } from "./grid.ts";
import { canPlacePiece } from "./phase-build.ts";
import type { PieceShape } from "./pieces.ts";
import { ALL_PIECE_SHAPES, rotateCW } from "./pieces.ts";
import {
  CORNERS_2X2,
  computeOutside,
  DIRS_4,
  DIRS_8,
  isCannonAlive,
  isCannonTile,
  isGrass,
  isPitAt,
  isTowerEnclosed,
  isTowerTile,
  isWater,
  packTile,
  towerReachesOutsideCardinal,
  unpackTile,
} from "./spatial.ts";
import type { GameState } from "./types.ts";

/** Result of a single AI placement decision. null = no valid placement. */
export interface AiPlacement {
  piece: PieceShape;
  row: TilePos["row"];
  col: TilePos["col"];
}
type Candidate = TilePos & {
  rotation: PieceShape;
  gapsFilled: number;
  wallAdjacent: number;
  connectedTiles: number;
  gapAdjacent: number;
  isolated: number;
  housesHit: number;
  bonusHit: number;
};
type Scored = {
  candidate: Candidate;
  score: number;
  gapClosingFat: boolean;
  fatWallTiles: number;
};
/** Shared context for the scoring loop — avoids threading 15+ params through closures. */
type ScoringContext = {
  state: GameState;
  walls: Set<number>;
  outside: Set<number>;
  targetGaps: Set<number>;
  castle: TileRect;
  cursorPos: TilePos | undefined;
  zoneTowers: Tower[];
  ownedTowers: Tower[];
  skill: typeof BUILD_SKILL_TABLE[number];
  caresAboutHouses: boolean;
  caresAboutBonuses: boolean;
  allCastlesEnclosed: boolean;
  homeTowerEnclosed: boolean;
  homeWasBroken: boolean | undefined;
  baselineOutside: number;
  baselinePocketWaste: number;
};

/** Max gap tiles in home castle before AI skips it for other towers. */
const HOME_GAP_REPAIR_THRESHOLD = 5;
/** Pockets this small or smaller block placement when no gaps are being filled. */
const TINY_POCKET_MAX_SIZE = 2;
/** Score weight per gap tile filled by a placement. */
const GAP_FILLED_WEIGHT = 100;
/** Score weight per tile adjacent to a gap (supports gap closure). */
const GAP_ADJACENT_WEIGHT = 20;
/** Score weight per tile connected to existing walls. */
const CONNECTED_TILES_WEIGHT = 10;
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
/** Penalty per tile that would create a 2x2 fat wall block. */
const FAT_WALL_TILE_PENALTY = 5;
/** Score bonus per obstacle around a 1x1 gap (prioritizes hard-to-fill gaps). */
const DIFFICULTY_MULTIPLIER = 3;
/** Score penalty per tile of new wasted pocket space created. */
const POCKET_DELTA_PENALTY = 3;
/** Score penalty for each house or bonus square tile covered by a placement. */
const OBSTACLE_HIT_PENALTY = 8;
/** Discard pieces if fewer free interior tiles remain (territory is full). */
const MIN_FREE_INTERIOR = 6;
/** Enclosures with at least this many tiles are considered viable (not wasted). */
const MIN_VIABLE_ENCLOSURE = 9;
/** Max Manhattan distance from an unowned tower that receives a proximity bonus. */
const TOWER_PROXIMITY_RANGE = 8;
/** Score bonus per tile of proximity to an unowned zone tower (guides expansion). */
const TOWER_PROXIMITY_FACTOR = 0.3;
/** Bonus per gap tile that would survive the sweep (≥2 cardinal neighbors). */
const SWEEP_SAFE_BONUS = 2;
const BUILD_SKILL_TABLE = [
  /*1*/ { topCandidates: 12, fatGainPerBlock: 0, pocketScale: 0.25, fatPenaltyScale: 0.25, tinyPocketReject: false },
  /*2*/ { topCandidates: 20, fatGainPerBlock: 1, pocketScale: 0.5, fatPenaltyScale: 0.5, tinyPocketReject: false },
  /*3*/ { topCandidates: 30, fatGainPerBlock: 2, pocketScale: 0.75, fatPenaltyScale: 0.75, tinyPocketReject: true },
  /*4*/ { topCandidates: 36, fatGainPerBlock: 2, pocketScale: 1.0, fatPenaltyScale: 1.0, tinyPocketReject: true },
  /*5*/ { topCandidates: 40, fatGainPerBlock: 3, pocketScale: 1.25, fatPenaltyScale: 1.25, tinyPocketReject: true },
] as const;

export function pickPlacementImpl(
  state: GameState,
  playerId: number,
  piece: PieceShape,
  cursorPos?: TilePos,
  homeWasBroken?: boolean,
  castleMargin = 3,
  bankHugging = false,
  caresAboutHouses = true,
  caresAboutBonuses = true,
  buildSkill = 3,
): AiPlacement | null {
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
  const skill = BUILD_SKILL_TABLE[buildSkill - 1]!;
  const zoneTowers = state.map.towers.filter(
    (t) => t.zone === castle.tower.zone,
  );

  // Enclosure detection must match territory's computeOutside (no water
  // barriers) so the AI and claimTerritory agree on which towers are enclosed.
  // Water-as-barrier made the AI think bank-adjacent castles were closed when
  // territory's plain flood could still enter through the bank.
  const walls = player.walls;
  const outside = computeOutside(walls);
  const homeTowerEnclosed = isTowerEnclosed(castle.tower, outside);
  // 4-dir BFS from a tower: returns true if the BFS can reach the map
  // border without crossing walls.
  const unenclosedTowers = zoneTowers.filter((t) => {
    if (!isTowerEnclosed(t, outside)) {
      // 8-dir flood says not enclosed. But if 4-dir BFS can't reach the
      // map border, the tower only has diagonal leaks — walls form a
      // complete orthogonal ring. Treat as enclosed to avoid building a
      // full castleRect that creates fat walls around the existing ring.
      // But first: if the expected ring has fillable gaps, the tower
      // genuinely needs repair (e.g. a single missing corner — 4-dir BFS
      // can't escape through the diagonal but the gap is real).
      if (!towerReachesOutsideCardinal(t, player.walls)) {
        const rect = castleRect(t, state.map.tiles, state.map.towers, castleMargin, !bankHugging);
        const ringGaps = findGapTiles(rect, player.walls);
        filterUnfillableGaps(ringGaps, state, player.interior);
        if (ringGaps.size > 0) return true; // real gaps need filling
        return false;
      }
      return true;
    }
    // 8-directional flood says enclosed, but diagonal wall connections can
    // create false positives. Verify with 4-directional BFS from the tower:
    // if we can reach an "outside" tile, the tower isn't truly enclosed.
    if (towerReachesOutsideCardinal(t, player.walls, outside)) return true;
    // Truly enclosed (BFS confirmed) — territory will count this tower.
    return false;
  });
  const allCastlesEnclosed = unenclosedTowers.length === 0;

  // If home was broken or its tower is dead, deprioritize it if there are other unenclosed towers
  // But only skip if the gap is large (> 5 tiles) — small holes are worth repairing
  const homeTowerDead = !state.towerAlive[castle.tower.index];
  const otherUnenclosed = unenclosedTowers.filter((t) => t !== castle.tower);
  let effectiveSkipHome = (homeWasBroken || homeTowerDead) && otherUnenclosed.length > 0;
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
    player.interior,
  );

  const logTime = (result: AiPlacement | null, _reason?: string) => result;

  // Step 1: determine which rectangle to build/repair
  function selectTarget(): { targetGaps: Set<number>; targetRect: TileRect | null } {
    // console.log(`[AI P${playerId}] step1: homeEnclosed=${homeTowerEnclosed} homeHasRingGaps=${homeHasRingGaps} skipHome=${effectiveSkipHome} unenclosed=[${unenclosedTowers.map(t=>`(${t.row},${t.col})`).join(',')}]`);

    let targetGaps: Set<number> = new Set();
    let targetRect: TileRect | null = null;
    const hasManageableGaps = (): boolean =>
      targetGaps.size > 0 && targetGaps.size <= 8;

    if (
      !effectiveSkipHome &&
      homeHasRingGaps &&
      castle.top <= castle.bottom &&
      castle.left <= castle.right
    ) {
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
          for (const t of state.map.towers) {
            if (isTowerTile(t, r, c)) {
              occupiedInterior++;
              break;
            }
          }
          for (const p of state.players) {
            for (const cannon of p.cannons) {
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
        freeRatio > 0.6 ? 2 : freeRatio > 0.3 ? 3 : freeRatio > 0.1 ? 4 : 5;

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
            hasGruntAt(state, r, c) ||
            isPitAt(state.burningPits, r, c);
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
      filterUnfillableGaps(targetGaps, state, player.interior);
      targetRect = { top, bottom, left, right };
    }

    if (hasManageableGaps() &&
        !canPieceFillAnyGap(state, playerId, piece, player.interior, targetGaps, targetRect)) {
      // Try plugging structurally unreachable gaps (e.g. thick walls from + pieces)
      if (!plugUnreachableGaps(targetGaps, targetRect, state, playerId, player) ||
          !canPieceFillAnyGap(state, playerId, piece, player.interior, targetGaps, targetRect)) {
        targetGaps = new Set();
        targetRect = null;
      }
    }

    const buildTowers = effectiveSkipHome ? otherUnenclosed : unenclosedTowers;
    // console.log(`[AI P${playerId}] step1 result: targetGaps=${targetGaps.size} buildTowers=${buildTowers.length} allEnclosed=${allCastlesEnclosed}`);

    if (targetGaps.size === 0 && buildTowers.length > 0) {
      const currentRow = cursorPos?.row ?? castle.tower.row;
      const currentCol = cursorPos?.col ?? castle.tower.col;

      // Score all towers, then try them in order — skip towers whose ring is unfillable
      const towerScores = buildTowers.map((t) =>
        scoreBuildTowerTarget(
          t,
          state,
          player,
          currentRow,
          currentCol,
          castleMargin,
          bankHugging,
        )
      );
      towerScores.sort(compareByNumericScoreDesc);
      // console.log(`[AI P${playerId}] towerScores: ${towerScores.map(({ tower: tw, score: s }) => `(${tw.row},${tw.col})=${s.toFixed(1)}`).join(' ')}`);

      for (const { tower: bestTower } of towerScores) {
        const rect = castleRect(
          bestTower,
          state.map.tiles,
          state.map.towers,
          castleMargin,
          !bankHugging,
        );
        const totalGaps = findGapTiles(rect, player.walls).size;
        const gaps = computeFillableGaps(rect, player, state, bankHugging);
        // Accept if there are fillable gaps, or if the ring was already complete
        if (gaps.size > 0 || totalGaps === 0) {
          // Diagnostic: for small gap counts, log why each gap might be unfillable
          if (gaps.size <= 3) {
            const playerZone = player.homeTower?.zone;
            for (const gk of gaps) {
              const { r: gr, c: gc } = unpackTile(gk);
              const reasons: string[] = [];
              if (!isGrass(state.map.tiles, gr, gc)) reasons.push('!grass');
              if (playerZone !== undefined && state.map.zones[gr]?.[gc] !== playerZone) reasons.push(`zone=${state.map.zones[gr]?.[gc]}≠${playerZone}`);
              if (hasWallAt(state, gr, gc)) reasons.push('wall');
              if (hasTowerAt(state, gr, gc)) reasons.push('tower');
              if (hasCannonAt(state, gr, gc)) reasons.push('cannon');
              if (hasGruntAt(state, gr, gc)) reasons.push('grunt');
              if (isPitAt(state.burningPits, gr, gc)) reasons.push('pit');
              if (state.bonusSquares.some(b => b.row === gr && b.col === gc)) reasons.push('bonus');
              // console.log(`[AI P${playerId}]   gap (${gr},${gc}) blockers: ${reasons.length ? reasons.join(',') : 'none'}`);
            }
          }
          // If the current piece can't fill this tower's gaps, try the next tower
          // but keep building toward secondary targets instead of giving up
          if (gaps.size > 0 && gaps.size <= 8 && !canPieceFillAnyGap(state, playerId, piece, player.interior, gaps, rect)) {
            // Try plugging structurally unreachable gaps before deferring
            if (!plugUnreachableGaps(gaps, rect, state, playerId, player) ||
                !canPieceFillAnyGap(state, playerId, piece, player.interior, gaps, rect)) {
              // console.log(`[AI P${playerId}]   deferring tower (${bestTower.row},${bestTower.col}) — piece ${piece.offsets.length}t can't fill ${gaps.size} gaps`);
              continue;
            }
          }
          // console.log(`[AI P${playerId}] → targeting tower (${bestTower.row},${bestTower.col}) gaps=${gaps.size}`);
          targetGaps = gaps;
          targetRect = rect;
          break;
        }
      }
    }

    return { targetGaps, targetRect };
  }

  const { targetGaps, targetRect } = selectTarget();
  const hasManageableGaps = (): boolean =>
    targetGaps.size > 0 && targetGaps.size <= 8;

  // Step 2: score candidates
  const baselineOutside = outside.size;

  // Interior minus target gaps and target castle rect — gaps are holes in the ring
  // that need filling, and the castle rect interior belongs to an open (gapped)
  // enclosure where the AI should be free to extend pieces while closing the ring.
  const interiorExcludingGaps = new Set(player.interior);
  for (const gk of targetGaps) interiorExcludingGaps.delete(gk);
  let rectExcluded = 0;
  if (targetRect) {
    for (let r = targetRect.top; r <= targetRect.bottom; r++) {
      for (let c = targetRect.left; c <= targetRect.right; c++) {
        if (interiorExcludingGaps.delete(packTile(r, c))) rectExcluded++;
      }
    }
  }
  if (rectExcluded > 0) {
    // console.log(`[AI P${playerId}] rectExcluded=${rectExcluded} interior tiles from open castle rect (interior=${player.interior.size} → exclusion=${interiorExcludingGaps.size})`);
  }

  const allCandidates = enumerateCandidates(
    state, playerId, piece, player.walls, outside, targetGaps, interiorExcludingGaps,
  );
  if (allCandidates.length === 0) return logTime(null);

  // Step 3: pick best using territory gain
  const baselinePocketWaste = countSmallPocketTiles(
    player.walls,
    outside,
  ).wasted;

  const scored: Scored[] = [];
  const noTargetGaps = allCastlesEnclosed && targetGaps.size === 0;
  const noBuildTargets = noTargetGaps && unenclosedTowers.length === 0;

  for (const candidate of allCandidates) {
    const { fatWallTiles, gapClosingFat } = checkFatWall(
      player.walls,
      candidate,
      targetGaps,
    );

    if (noTargetGaps && (fatWallTiles > 0 || gapClosingFat)) continue;

    scored.push({
      candidate,
      score:
        candidate.gapsFilled * GAP_FILLED_WEIGHT +
        candidate.gapAdjacent * GAP_ADJACENT_WEIGHT +
        candidate.connectedTiles * CONNECTED_TILES_WEIGHT +
        candidate.wallAdjacent -
        fatWallTiles * FAT_WALL_TILE_PENALTY,
      gapClosingFat,
      fatWallTiles,
    });
  }

  if (scored.length === 0) {
    // When everything is enclosed with no gaps, don't force-place fat walls
    if (noBuildTargets) {
      return logTime(null, 'all-enclosed-no-scored');
    }
    const fatBlockCountFor = memoize((candidate: Candidate) => countFatBlocks(player.walls, candidate));
    const compareByFatBlockCount = (a: Candidate, b: Candidate): number =>
      fatBlockCountFor(a) - fatBlockCountFor(b);

    const open = allCandidates.filter((c) => c.wallAdjacent === 0 && fatBlockCountFor(c) === 0);
    if (open.length > 0) {
      open.sort((a, b) =>
        compareCandidatesByObstaclePreference(a, b, caresAboutHouses, caresAboutBonuses)
      );
      return logTime(candidateToPlacement(open[0]!), 'open-noFat');
    }
    // Allow fat-free first, fall back to least fat
    const noFat = allCandidates.filter((c) => fatBlockCountFor(c) === 0);
    if (noFat.length > 0) {
      return logTime(candidateToPlacement(noFat[0]!), 'noFat-fallback');
    }
    const least = [...allCandidates].sort(compareByFatBlockCount);
    return logTime(candidateToPlacement(least[0]!), 'least-fat-fallback');
  }

  scored.sort(compareScoredByScoreDesc);
  let topCandidates = scored.slice(0, skill.topCandidates);

  // When the target has manageable gaps (1-8) and at least one candidate fills
  // a gap, restrict the final scoring to gap-filling candidates only.
  // This prevents territory gain elsewhere from out-scoring the gap closure.
  // Threshold matches canPieceFillAnyGap — if the piece CAN fill a gap, it SHOULD.
  let restrictedToGapFillers = false;
  if (hasManageableGaps()) {
    const allGapFillers = scored.filter((s) => s.candidate.gapsFilled > 0);
    const topGapFillers = topCandidates.filter((s) => s.candidate.gapsFilled > 0);
    if (topGapFillers.length > 0) {
      topCandidates = topGapFillers;
      restrictedToGapFillers = true;
    } else if (allGapFillers.length > 0) {
      topCandidates = allGapFillers.slice(0, skill.topCandidates);
      restrictedToGapFillers = true;
    }
  }

  function scoreCandidates(topCandidates: Scored[], ctx: ScoringContext): { bestCandidate: Candidate; bestScore: number; evaluated: boolean } {
    const anyHasWallAdjacent = topCandidates.some(
      (s) => s.candidate.wallAdjacent > 0 || s.candidate.connectedTiles > 0,
    );

    let bestCandidate = topCandidates[0]!.candidate;
    let bestScore = -Infinity;
    let evaluated = false;

    for (const { candidate, gapClosingFat, fatWallTiles } of topCandidates) {
      const nonGapCount =
        candidate.rotation.offsets.length - candidate.gapsFilled;
      if (
        !ctx.homeWasBroken &&
        !ctx.homeTowerEnclosed &&
        candidate.gapsFilled > 0 &&
        nonGapCount > 0 &&
        candidate.isolated >= nonGapCount
      )
        continue;

      const simulatedWalls = buildSimulatedWalls(ctx.walls, candidate);
      const newOutside = computeOutside(simulatedWalls);
      const rawGain = ctx.baselineOutside - newOutside.size;
      const pieceTiles = candidate.rotation.offsets.length;
      const usefulGain = rawGain - pieceTiles;

      const rawFatBlocks = countFatBlocks(ctx.walls, candidate);
      if (rawFatBlocks > 0) {
        // console.log(`[AI] fatCandidate (${candidate.row},${candidate.col}) ${pieceTiles}t gapsFilled=${candidate.gapsFilled} usefulGain=${usefulGain} fatBlocks=${rawFatBlocks} checkFat={tiles=${fatWallTiles},closing=${gapClosingFat}}`);
      }

      const fatExempt = candidate.gapsFilled > 0 && !ctx.allCastlesEnclosed;
      if (shouldRejectForFatWalls(rawFatBlocks, ctx.skill.fatGainPerBlock, usefulGain, fatExempt)) continue;

      const pocketInfo = countSmallPocketTiles(simulatedWalls, newOutside);
      const pocketDelta = pocketInfo.wasted - ctx.baselinePocketWaste;

      if (
        ctx.skill.tinyPocketReject &&
        pocketDelta > 0 &&
        pocketInfo.smallestPocket <= TINY_POCKET_MAX_SIZE &&
        candidate.gapsFilled === 0
      )
        continue;
      if (
        ctx.skill.tinyPocketReject &&
        ctx.allCastlesEnclosed &&
        pocketDelta > 0 &&
        pocketInfo.smallestPocket < SMALL_POCKET_MAX_SIZE
      )
        continue;

      const baseGapBonus = computeGapBonus(candidate.gapsFilled, usefulGain);
      const { gapBonus, wastefulClosurePenalty } =
        computeWastefulClosureAdjustment(
          candidate,
          ctx.targetGaps,
          ctx.castle,
          usefulGain,
          baseGapBonus,
        );

      const cursorProximityBonus = computeCursorProximityBonus(
        candidate,
        anyHasWallAdjacent,
        ctx.cursorPos,
      );

      const innerObstacleBonus = computeInnerObstacleBonus(
        candidate,
        ctx.targetGaps,
        ctx.castle,
        ctx.state.map.tiles,
      );

      const fatWallPenalty = computeFatWallPenalty(
        gapClosingFat,
        fatWallTiles,
        usefulGain,
        ctx.skill.fatPenaltyScale,
      );
      const pocketPenalty = computePocketPenalty(pocketDelta, ctx.skill.pocketScale);
      const obstacleHitPenalty = computeObstacleHitPenalty(
        candidate,
        ctx.caresAboutHouses,
        ctx.caresAboutBonuses,
      );

      const difficultyBonus = computeDifficultyBonus(ctx.state, candidate);

      const towerProximityBonus = computeTowerProximityBonus(
        candidate,
        ctx.targetGaps,
        ctx.zoneTowers,
        ctx.ownedTowers,
      );

      // Bonus for gap tiles that would survive the post-build sweep (≥2 cardinal neighbors).
      // Guides the AI to fill well-connected gaps first, deferring corners until
      // adjacent gaps are filled and provide the needed cardinal connections.
      const sweepSafeBonus = computeSweepSafeBonus(
        candidate,
        targetGaps,
        simulatedWalls,
      );

      const score =
        usefulGain +
        gapBonus +
        innerObstacleBonus +
        difficultyBonus -
        pocketPenalty -
        obstacleHitPenalty -
        fatWallPenalty -
        wastefulClosurePenalty +
        sweepSafeBonus +
        cursorProximityBonus +
        towerProximityBonus;

      if (
        score > bestScore ||
        (score === bestScore && candidate.gapsFilled > bestCandidate.gapsFilled)
      ) {
        bestScore = score;
        bestCandidate = candidate;
        evaluated = true;
      }
    }

    return { bestCandidate, bestScore, evaluated };
  }

  const scoringCtx: ScoringContext = {
    state, walls, outside, targetGaps, castle, cursorPos, zoneTowers,
    ownedTowers: player.ownedTowers, skill, caresAboutHouses, caresAboutBonuses,
    allCastlesEnclosed, homeTowerEnclosed, homeWasBroken,
    baselineOutside, baselinePocketWaste,
  };
  const { bestCandidate, bestScore, evaluated: bestCandidateEvaluated } = scoreCandidates(topCandidates, scoringCtx);

  // All enclosed, no gaps, no towers to build toward — keep going only if
  // there are enemy grunts or unenclosed cannons on outside tiles worth
  // enclosing, or if the scoring found a placement with positive territory gain.
  if (noBuildTargets) {
    const hasOutsideGrunts = state.grunts.some(
      (g) => g.targetPlayerId === playerId && outside.has(packTile(g.row, g.col)),
    );
    const hasUnenclosedCannons = player.cannons.some(
      (c) => isCannonAlive(c) && !c.balloon && !isCannonEnclosed(c, player.interior),
    );
    if ((!hasOutsideGrunts && !hasUnenclosedCannons) || bestScore <= 0) return logTime(null);
  }

  // Gap-filling was the priority but territory gain was ≤ 0 — still use the
  // best gap-filler by first-pass score (closing the ring IS the goal).
  // Only if we actually evaluated a candidate (fat-wall-only sets get skipped
  // entirely and should fall through to discard/extension instead).
  // Reject fat walls even here — a gap-fill that creates 2×2 blocks without
  // enclosing territory is wasteful.
  if (bestScore <= 0 && restrictedToGapFillers && bestCandidateEvaluated) {
    const gapFillerFatBlockCountFor = memoize((candidate: Candidate) => countFatBlocks(player.walls, candidate));

    if (gapFillerFatBlockCountFor(bestCandidate) === 0) {
      return logTime(candidateToPlacement(bestCandidate), 'gapFiller-noGain');
    }
    // Fat wall gap-filler — find a non-fat alternative among gap fillers
    const nonFatGapFillers = topCandidates.filter(
      (s) => s.candidate.gapsFilled > 0 && gapFillerFatBlockCountFor(s.candidate) === 0,
    );
    if (nonFatGapFillers.length > 0) {
      nonFatGapFillers.sort(compareByNumericScoreDesc);
      return logTime(candidateToPlacement(nonFatGapFillers[0]!.candidate), 'gapFiller-noGain-noFat');
    }
    // All gap fillers are fat — accept the best one anyway if the ring
    // is still open, because closing the castle outweighs the fat penalty.
    if (!allCastlesEnclosed) {
      return logTime(candidateToPlacement(bestCandidate), 'gapFiller-fat-forced');
    }
  }

  // If no territory gain: discard or build toward unenclosed towers
  if (bestScore <= 0) {
    const fb = pickFallbackPlacement(
      scored, state, player.walls, outside, player.interior,
      castle, castleMargin, !!homeWasBroken, unenclosedTowers,
      caresAboutHouses, caresAboutBonuses,
    );
    if (fb) return logTime(fb.placement, fb.reason);
  }

  return logTime({
    piece: bestCandidate.rotation,
    row: bestCandidate.row,
    col: bestCandidate.col,
  }, 'scored');
}
function compareCandidatesByObstaclePreference(
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
function compareScoredByScoreDesc(a: Scored, b: Scored): number {
  return b.score - a.score;
}
function compareByNumericScoreDesc<T extends { score: number }>(a: T, b: T): number {
  return b.score - a.score;
}
function computeGapBonus(gapsFilled: number, usefulGain: number): number {
  if (gapsFilled <= 0) return 0;
  const base = Math.max(
    GAP_BONUS_MIN,
    GAP_BONUS_BASE - usefulGain * GAP_BONUS_GAIN_FACTOR,
  );
  return base + (gapsFilled - 1) * GAP_BONUS_PER_EXTRA;
}
function computeFatWallPenalty(
  gapClosingFat: boolean,
  fatWallTiles: number,
  usefulGain: number,
  fatPenaltyScale: number,
): number {
  if (gapClosingFat) {
    return Math.max(
      FAT_WALL_PENALTY_MIN,
      usefulGain * FAT_WALL_GAIN_FACTOR,
    ) * fatPenaltyScale;
  }
  if (fatWallTiles > 0) {
    return fatWallTiles * FAT_WALL_TILE_PENALTY * fatPenaltyScale;
  }
  return 0;
}
function computePocketPenalty(
  pocketDelta: number,
  pocketScale: number,
): number {
  return Math.max(0, pocketDelta) * POCKET_DELTA_PENALTY * pocketScale;
}
function computeObstacleHitPenalty(
  candidate: Pick<Candidate, "housesHit" | "bonusHit">,
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
): number {
  return (caresAboutHouses ? candidate.housesHit * OBSTACLE_HIT_PENALTY : 0) +
    (caresAboutBonuses ? candidate.bonusHit * OBSTACLE_HIT_PENALTY : 0);
}
function computeTowerProximityBonus(
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
function computeSweepSafeBonus(
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
function computeCursorProximityBonus(
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
function computeInnerObstacleBonus(
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

  let innerTiles = 0;
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
      innerTiles++;
    }
  }

  return innerTiles * INNER_OBSTACLE_MULTIPLIER;
}
function computeDifficultyBonus(
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
function computeWastefulClosureAdjustment(
  candidate: Candidate,
  targetGaps: Set<number>,
  castle: TileRect,
  usefulGain: number,
  baseGapBonus: number,
): { gapBonus: number; wastefulClosurePenalty: number } {
  if (candidate.gapsFilled <= 0 || castle.top > castle.bottom) {
    return { gapBonus: baseGapBonus, wastefulClosurePenalty: 0 };
  }

  let insideNonGap = 0;
  let outsideNonGap = 0;
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
      insideNonGap++;
    } else {
      outsideNonGap++;
    }
  }

  if (outsideNonGap === 0 && insideNonGap > candidate.gapsFilled) {
    return {
      gapBonus: 0,
      wastefulClosurePenalty: usefulGain + insideNonGap,
    };
  }

  return { gapBonus: baseGapBonus, wastefulClosurePenalty: 0 };
}
function shouldRejectForFatWalls(
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
/** Cheap fat-wall check — no Set copy, just checks if placing creates 2×2 blocks. */
function checkFatWall(
  walls: Set<number>,
  candidate: Candidate,
  _gaps: Set<number>,
): { fatWallTiles: number; gapClosingFat: boolean } {
  const { addedKeys, addedSet: _, isWall } = buildCandidateWallInfo(walls, candidate.rotation.offsets, candidate.row, candidate.col);
  let fatWallTiles = 0;
  let gapClosingFat = false;
  for (const key of addedKeys) {
    const { r, c } = unpackTile(key);
    if (!tileCreatesFatBlock(r, c, isWall)) continue;
    if (candidate.gapsFilled > 0) {
      gapClosingFat = true;
      continue;
    }
    fatWallTiles++;
    break;
  }
  return { fatWallTiles, gapClosingFat };
}
/** Count wasted tiles in small pockets (< SMALL_POCKET_MAX_SIZE). */
function countSmallPocketTiles(
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
/** Check if the current piece (in any rotation) can fill any of the given gaps. */
function canPieceFillAnyGap(
  state: GameState,
  playerId: number,
  piece: PieceShape,
  interior: Set<number>,
  gaps: Set<number>,
  rect?: TileRect | null,
): boolean {
  // Interior excluding these gaps — gap tiles are ring holes, not forbidden interior.
  // Also exclude the castle rect interior: the enclosure has gaps so it's NOT closed,
  // and the AI should be free to extend pieces into it while filling those gaps.
  const adjusted = new Set(interior);
  for (const gk of gaps) adjusted.delete(gk);
  if (rect) {
    for (let r = rect.top; r <= rect.bottom; r++) {
      for (let c = rect.left; c <= rect.right; c++) {
        adjusted.delete(packTile(r, c));
      }
    }
  }
  let rot = piece;
  for (let ri = 0; ri < 4; ri++) {
    for (const gk of gaps) {
      const { r: gr, c: gc } = unpackTile(gk);
      for (const [dr, dc] of rot.offsets) {
        if (canPlacePiece(state, playerId, rot, gr - dr, gc - dc, adjusted)) return true;
      }
    }
    rot = rotateCW(rot);
  }
  return false;
}
/**
 * When the current piece can't fill any gap, check if some gaps are
 * structurally unreachable by ANY piece shape.  For those, add interior plug
 * tiles (seal diagonal leaks from inside, same as water/pit plugs).
 * Returns true if the gap set was modified.
 */
function plugUnreachableGaps(
  gaps: Set<number>,
  rect: TileRect | null,
  state: GameState,
  playerId: number,
  player: { walls: Set<number>; interior: Set<number> },
): boolean {
  if (!rect || gaps.size === 0) return false;
  const unreachable: number[] = [];
  for (const gk of gaps) {
    if (!isGapFillableByAnyShape(state, playerId, player.interior, gk, rect)) {
      unreachable.push(gk);
    }
  }
  if (unreachable.length === 0) return false;
  for (const gk of unreachable) gaps.delete(gk);
  // Add interior-facing grass neighbors as plug gaps (same diagonal-leak seal as water/pits)
  for (const gk of unreachable) {
    const { r: gr, c: gc } = unpackTile(gk);
    for (const [dr, dc] of DIRS_8) {
      const nr = gr + dr, nc = gc + dc;
      if (nr < rect.top || nr > rect.bottom || nc < rect.left || nc > rect.right) continue;
      const nk = packTile(nr, nc);
      if (player.walls.has(nk)) continue;
      if (!isGrass(state.map.tiles, nr, nc)) continue;
      gaps.add(nk);
    }
  }
  filterUnfillableGaps(gaps, state, player.interior);
  return true;
}
/** Check if ANY standard piece shape (in any rotation) could fill a single gap tile. */
function isGapFillableByAnyShape(
  state: GameState,
  playerId: number,
  interior: Set<number>,
  gapKey: number,
  rect?: TileRect | null,
): boolean {
  const { r: gr, c: gc } = unpackTile(gapKey);
  const adjusted = new Set(interior);
  adjusted.delete(gapKey);
  if (rect) {
    for (let r = rect.top; r <= rect.bottom; r++) {
      for (let c = rect.left; c <= rect.right; c++) {
        adjusted.delete(packTile(r, c));
      }
    }
  }
  for (const shape of ALL_PIECE_SHAPES) {
    let rot = shape;
    for (let ri = 0; ri < 4; ri++) {
      for (const [dr, dc] of rot.offsets) {
        if (canPlacePiece(state, playerId, rot, gr - dr, gc - dc, adjusted)) return true;
      }
      rot = rotateCW(rot);
    }
  }
  return false;
}
/** Enumerate all valid placements for a piece, scoring adjacency/gap metrics. */
function enumerateCandidates(
  state: GameState,
  playerId: number,
  piece: PieceShape,
  walls: Set<number>,
  outside: Set<number>,
  targetGaps: Set<number>,
  interiorExcludingGaps: Set<number>,
): Candidate[] {
  const candidates: Candidate[] = [];
  let rotated = piece;
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let r = 0; r < GRID_ROWS - rotated.height + 1; r++) {
      for (let c = 0; c < GRID_COLS - rotated.width + 1; c++) {
        if (!canPlacePiece(state, playerId, rotated, r, c, interiorExcludingGaps)) continue;

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
          rotation: rotated,
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
  walls: Set<number>,
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
/**
 * When the best scored placement has usefulGain <= 0, pick a fallback:
 * extend toward unenclosed towers, or discard somewhere harmless.
 * Returns null when no fallback applies (interior full / nothing useful).
 */
function pickFallbackPlacement(
  scored: Scored[],
  state: GameState,
  walls: Set<number>,
  outside: Set<number>,
  interior: Set<number>,
  castle: { tower: Tower },
  castleMargin: number,
  homeWasBroken: boolean,
  unenclosedTowers: Tower[],
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
): { placement: AiPlacement | null; reason: string } | null {
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
      const k = packTile(r, c);
      if (!interior.has(k)) continue;
      if (walls.has(k)) continue;
      let blocked = false;
      for (const t of state.map.towers) {
        if (isTowerTile(t, r, c)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      for (const p of state.players) {
        for (const cannon of p.cannons) {
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
    return { placement: null, reason: 'interior-full' };

  const createsSmallEnclosure = (candidate: Candidate): boolean => {
    const simulatedWalls = buildSimulatedWalls(walls, candidate);
    const simulatedOutside = computeOutside(simulatedWalls);
    const visited = new Set<number>();
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const k = packTile(r, c);
        if (visited.has(k) || simulatedOutside.has(k) || simulatedWalls.has(k))
          continue;
        const pocket = floodPocket(k, visited, simulatedWalls, simulatedOutside);
        if (pocket.length >= MIN_VIABLE_ENCLOSURE) continue;
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
          for (const t of state.map.towers) {
            if (isTowerTile(t, pr, pc)) {
              hasOccupant = true;
              break;
            }
          }
          if (!hasOccupant && !isGrass(state.map.tiles, pr, pc))
            hasOccupant = true;
          if (!hasOccupant) {
            for (const g of state.grunts) {
              if (g.row === pr && g.col === pc) {
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
  };

  const createsSmallEnclosureCached = memoize(createsSmallEnclosure);

  const insideEnclosure = (candidate: Candidate): boolean => {
    for (const [dr, dc] of candidate.rotation.offsets) {
      const k = packTile(candidate.row + dr, candidate.col + dc);
      for (const p of state.players) {
        if (p.interior.has(k)) return true;
      }
    }
    return false;
  };

  const fallbackTowers = homeWasBroken
    ? unenclosedTowers.filter((t) => t !== castle.tower)
    : unenclosedTowers;

  const isInsideOrFatCandidate = (candidate: Candidate): boolean => {
    return insideEnclosure(candidate) || !isFatFreeCandidate(walls, candidate);
  };

  if (fallbackTowers.length > 0) {
    const ringDistanceCache = new Map<Candidate, { distance: number; tooClose: boolean }>();
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
      return placementResult(bestDiscard, 'discard');
    }
    return { placement: null, reason: 'discard-all-fat' };
  }
}
/** Create a memoized version of a function (Map-based cache). */
function memoize<K, V>(fn: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>();
  return (key: K): V => {
    const cached = cache.get(key);
    if (cached != null) return cached;
    const computed = fn(key);
    cache.set(key, computed);
    return computed;
  };
}
function pickTowerExtensionCandidate(
  scored: Scored[],
  fallbackTowers: readonly Tower[],
  castleMargin: number,
  ringDistanceCache: Map<Candidate, { distance: number; tooClose: boolean }>,
  createsSmallEnclosureCached: (candidate: Candidate) => boolean,
  isInsideOrFatCandidate: (candidate: Candidate) => boolean,
): {
  candidate: Candidate | null;
  reason: 'extend' | 'extend-fallback' | 'extend-all-fat';
} {
  const extending = scored.filter((s) =>
    isExtensionCandidateForFallback(
      s.candidate,
      fallbackTowers,
      castleMargin,
      ringDistanceCache,
      createsSmallEnclosureCached,
      isInsideOrFatCandidate,
    )
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
        ) ||
        b.candidate.wallAdjacent - a.candidate.wallAdjacent,
    );
    return { candidate: extending[0]!.candidate, reason: 'extend' };
  }

  const fallback = [...scored].filter((s) =>
    isExtensionFallbackCandidateForFallback(
      s.candidate,
      createsSmallEnclosureCached,
      isInsideOrFatCandidate,
    )
  );
  fallback.sort((a, b) =>
    compareByFallbackRingDistance(
      a.candidate,
      b.candidate,
      fallbackTowers,
      castleMargin,
      ringDistanceCache,
    )
  );
  if (fallback.length > 0) {
    return { candidate: fallback[0]!.candidate, reason: 'extend-fallback' };
  }

  return { candidate: null, reason: 'extend-all-fat' };
}
function compareByFallbackRingDistance(
  a: Candidate,
  b: Candidate,
  fallbackTowers: readonly Tower[],
  castleMargin: number,
  ringDistanceCache: Map<Candidate, { distance: number; tooClose: boolean }>,
): number {
  return (
    ringDistanceForFallbackTowers(a, fallbackTowers, castleMargin, ringDistanceCache).distance -
    ringDistanceForFallbackTowers(b, fallbackTowers, castleMargin, ringDistanceCache).distance
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
  const rd = ringDistanceForFallbackTowers(
    candidate,
    fallbackTowers,
    castleMargin,
    ringDistanceCache,
  );
  if (rd.tooClose) return false;
  if (createsSmallEnclosureCached(candidate)) return false;
  if (isInsideOrFatCandidate(candidate)) return false;
  return true;
}
function ringDistanceForFallbackTowers(
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
    const towerDistance = candidateRingDistanceForTower(candidate, tower, castleMargin);
    if (towerDistance.tooClose) tooClose = true;
    if (towerDistance.distance < bestDistance) bestDistance = towerDistance.distance;
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
  const ringTop = tower.row - castleMargin - 1;
  const ringBot = tower.row + 1 + castleMargin + 1;
  const ringLeft = tower.col - castleMargin - 1;
  const ringRight = tower.col + 1 + castleMargin + 1;

  let tooClose = false;
  for (const [dr, dc] of candidate.rotation.offsets) {
    const pr = candidate.row + dr;
    const pc = candidate.col + dc;
    if (
      pr >= tower.row - castleMargin &&
      pr <= tower.row + 1 + castleMargin &&
      pc >= tower.col - castleMargin &&
      pc <= tower.col + 1 + castleMargin
    ) {
      if (
        pr > ringTop &&
        pr < ringBot &&
        pc > ringLeft &&
        pc < ringRight
      ) {
        tooClose = true;
      }
    }
  }

  const centerR = tower.row + 0.5;
  const centerC = tower.col + 0.5;
  const distance =
    Math.abs(candidate.row - centerR) +
    Math.abs(candidate.col - centerC);

  return { distance, tooClose };
}
function isExtensionFallbackCandidateForFallback(
  candidate: Candidate,
  createsSmallEnclosureCached: (candidate: Candidate) => boolean,
  isInsideOrFatCandidate: (candidate: Candidate) => boolean,
): boolean {
  return !createsSmallEnclosureCached(candidate) && !isInsideOrFatCandidate(candidate);
}
function pickDiscardCandidate(
  scored: Scored[],
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
  createsSmallEnclosureCached: (candidate: Candidate) => boolean,
  isInsideOrFatCandidate: (candidate: Candidate) => boolean,
): Candidate | null {
  const throwAway = [...scored].filter(
    (s) => !isInsideOrFatCandidate(s.candidate),
  );
  if (throwAway.length === 0) return null;
  throwAway.sort((a, b) =>
    compareDiscardCandidatesForFallback(
      a,
      b,
      caresAboutHouses,
      caresAboutBonuses,
      createsSmallEnclosureCached,
    )
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
  const aHit = candidateObstacleHits(a.candidate, caresAboutHouses, caresAboutBonuses);
  const bHit = candidateObstacleHits(b.candidate, caresAboutHouses, caresAboutBonuses);
  if (aHit !== bHit) return aHit - bHit;
  const aEncloses = createsSmallEnclosureCached(a.candidate) ? 0 : 1;
  const bEncloses = createsSmallEnclosureCached(b.candidate) ? 0 : 1;
  if (aEncloses !== bEncloses) return aEncloses - bEncloses;
  return a.fatWallTiles - b.fatWallTiles;
}
function candidateObstacleHits(
  candidate: Pick<Candidate, "housesHit" | "bonusHit">,
  caresAboutHouses: boolean,
  caresAboutBonuses: boolean,
): number {
  return (caresAboutHouses ? candidate.housesHit : 0) +
    (caresAboutBonuses ? candidate.bonusHit : 0);
}
function candidateToPlacement(candidate: Candidate): AiPlacement {
  return {
    piece: candidate.rotation,
    row: candidate.row,
    col: candidate.col,
  };
}
function isFatFreeCandidate(
  walls: Set<number>,
  candidate: { row: number; col: number; rotation?: PieceShape; piece?: PieceShape },
): boolean {
  return countFatBlocks(walls, candidate) === 0;
}
/** Count 2×2 all-wall blocks a candidate would create (no exemptions). */
function countFatBlocks(
  walls: Set<number>,
  candidate: { row: number; col: number; rotation?: PieceShape; piece?: PieceShape },
): number {
  const shape = candidate.rotation ?? candidate.piece;
  if (!shape) return 0;
  const { addedKeys, addedSet: _, isWall } = buildCandidateWallInfo(walls, shape.offsets, candidate.row, candidate.col);
  let blocks = 0;
  for (const key of addedKeys) {
    const { r, c } = unpackTile(key);
    if (tileCreatesFatBlock(r, c, isWall)) blocks++;
  }
  return blocks;
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
/** Build the simulated wall set for a candidate. */
function buildSimulatedWalls(
  walls: Set<number>,
  candidate: Candidate,
): Set<number> {
  const simulatedWalls = new Set(walls);
  for (const [dr, dc] of candidate.rotation.offsets) {
    simulatedWalls.add(packTile(candidate.row + dr, candidate.col + dc));
  }
  return simulatedWalls;
}
