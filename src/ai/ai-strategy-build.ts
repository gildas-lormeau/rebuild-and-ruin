/**
 * AI build-phase placement orchestrator: pick a target ring
 * (ai-build-target), enumerate candidates, score (ai-build-score), fall back
 * (ai-build-shared). Castle rectangle + gap analysis live in ai-castle-rect.
 */

import {
  buildPlacementContext,
  canPlacePiece,
  createCastle,
  effectivePlanTiles,
  type PlacementContext,
} from "../game/index.ts";
import { isCannonAlive } from "../shared/core/battle-types.ts";
import {
  buildOccupancyCache,
  collectAliveHouseKeys,
  filterAliveEnclosedTowers,
  hasAliveHouseAt,
  type OccupancyCache,
} from "../shared/core/board-occupancy.ts";
import { MODIFIER_ID } from "../shared/core/game-constants.ts";
import type {
  Castle,
  TilePos,
  Tower,
  TowerIdx,
} from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import { type PieceShape, rotateCW } from "../shared/core/pieces.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { Player } from "../shared/core/player-types.ts";
import {
  computeOutside,
  computeOutsideAfterAdd,
  DIRS_4,
  inBounds,
  isCannonTile,
  isFloodedTile,
  isGrass,
  packTile,
  towerReachesOutsideCardinal,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import {
  hasFillableTowerHope,
  pickDesperateInteriorDiscard,
} from "./ai-build-desperate.ts";
import {
  emitDesperateFiredDiag,
  emitNoPlacementDiag,
  emitWallPlacedDiag,
  isAiBuildDiagHookActive,
  type NoPlacementReason,
} from "./ai-build-diag.ts";
import { computePeekFitTargets } from "./ai-build-lookahead.ts";
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
  MANAGEABLE_GAP_LIMIT,
  selectTarget,
} from "./ai-build-target.ts";
import type {
  AiPlacement,
  Candidate,
  EnclosureAnalysis,
  FallbackContext,
  PlacementOptions,
  Scored,
  ScoringContext,
} from "./ai-build-types.ts";
import { findGapTiles, hasMeaningfulHomeRingGaps } from "./ai-castle-rect.ts";

type BuildSkillConfig = (typeof BUILD_SKILL_TABLE)[number];

export interface PickPlacementResult {
  placement: AiPlacement | null;
  /** Tower committed to by trySecondaryTower this tick (undefined for home
   *  repair, expand-territory, or any path that didn't cache). The caller
   *  (DefaultStrategy) stores this and passes it back via PlacementOptions
   *  on the next tick to drive the persistence short-circuit. */
  chosenTowerIndex: TowerIdx | undefined;
}

interface BestPlacementResult {
  placement: AiPlacement | null;
  /** Set iff placement === null; identifies the terminal branch that
   *  gave up. Forwarded to emitNoPlacementDiag at the pickPlacement call
   *  site so the build-trace observer can bucket no-placement ticks. */
  reason: NoPlacementReason | undefined;
}

const NO_PLACEMENT: PickPlacementResult = {
  placement: null,
  chosenTowerIndex: undefined,
};
/** Max gap tiles before AI deprioritizes home tower in favor of other unenclosed towers. */
const HOME_GAP_REPAIR_THRESHOLD = 5;
/** Score weight per gap tile filled by a placement. */
const GAP_FILLED_WEIGHT = 100;
/** Score weight per tile adjacent to a gap (supports gap closure). */
const GAP_ADJACENT_WEIGHT = 20;
/** Score weight per tile connected to existing walls. */
const CONNECTED_TILES_WEIGHT = 10;
/** Score penalty for a placement that extends a doubled-wall block into a
 *  2×3 / 3×2 all-wall RUN — the visible "fat wall" pathology. Several orders
 *  of magnitude larger than the typical placement score (`GAP_FILLED_WEIGHT
 *  = 100 × gaps`) so a fat-run candidate ranks BELOW every non-fat-run
 *  alternative, but is still kept in the scored list as a last-resort
 *  fallback when every other placement is impossible (avoids the build-
 *  phase deadlock observed when fat-run was hard-rejected upstream). */
const FAT_WALL_RUN_PENALTY = 10_000;
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
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  options: PlacementOptions,
): PickPlacementResult {
  const {
    cursorPos,
    homeWasBroken,
    castleMargin,
    bankHugging,
    caresAboutHouses,
    caresAboutBonuses,
    buildSkill,
    outerRingHolesSnapshot,
    lastTargetTowerIndex,
  } = options;
  const maybePlayer = state.players[playerId];
  if (!maybePlayer || maybePlayer.castleWallTiles.size === 0) {
    emitNoPlacementDiag(playerId, state.round, "eliminated-no-walls");
    return NO_PLACEMENT;
  }
  const player = maybePlayer;
  // Recompute the home castle rect on demand. Selection used the same
  // algorithm against the modifier-projected tiles; passing
  // `effectivePlanTiles(state)` here keeps AI scoring aligned with the
  // actual walls while the same modifier is active. After a modifier
  // clears between selection and now, the recomputed rect drifts to the
  // natural-shoreline shape — bounded suboptimality, never desync.
  if (!player.homeTower) {
    emitNoPlacementDiag(playerId, state.round, "eliminated-no-tower");
    return NO_PLACEMENT;
  }
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
  } = analyzeEnclosures(state, player, castle, homeWasBroken);
  const walls = player.walls;

  // Build the occupancy cache + placement context once per pickPlacement.
  // Every sub-helper that walks candidates (enumerateCandidates,
  // canPieceFillAnyGap, plugUnreachableGaps) reads these — without this
  // hoist they get rebuilt up to ~10 times per tick during target selection.
  // State is read-only during pickPlacement so memoization is safe.
  const cache = buildOccupancyCache(state);
  const placementCtx = buildPlacementContext(state, playerId);
  if (!placementCtx) {
    emitNoPlacementDiag(playerId, state.round, "no-placement-context");
    return NO_PLACEMENT;
  }

  // Step 1: determine which rectangle to build/repair.
  // Pipeline: tryRepairHomeCastle → trySecondaryTower → tryExpandTerritory
  // Each phase only runs if the previous one found no gaps.
  const { targetGaps, targetRect, chosenTowerIndex } = selectTarget({
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
    homeTowerEnclosed,
    allCastlesEnclosed,
    unenclosedTowers,
    otherUnenclosed,
    outerRingHolesSnapshot,
    lastTargetTowerIndex,
    cache,
    placementCtx,
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
    cache,
    placementCtx,
    interiorExcludingGaps,
  );
  if (allCandidates.length === 0) {
    emitNoPlacementDiag(
      playerId,
      state.round,
      "no-candidates",
      isAiBuildDiagHookActive()
        ? classifyGapBlockers(state, player, targetGaps, cache)
        : undefined,
    );
    return { placement: null, chosenTowerIndex };
  }

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

  const peekFitTargets = computePeekFitTargets(
    state,
    playerId,
    player,
    unenclosedTowers,
    targetRect,
    castleMargin,
    bankHugging,
    cache,
    placementCtx,
  );

  const scoringCtx: ScoringContext = {
    state,
    walls,
    outside,
    targetGaps,
    castle,
    cursorPos,
    zoneTowers,
    enclosedTowers: player.enclosedTowers,
    skill,
    caresAboutHouses,
    caresAboutBonuses,
    allCastlesEnclosed,
    homeTowerEnclosed,
    homeWasBroken,
    baselineOutside,
    baselinePocketWaste,
    aliveHouseKeys,
    peekFitTargets,
  };

  const bestResult = selectBestPlacement(scored, allCandidates, scoringCtx, {
    player,
    castle,
    castleMargin,
    unenclosedTowers,
    noBuildTargets,
    hasManageableGaps:
      targetGaps.size > 0 && targetGaps.size <= MANAGEABLE_GAP_LIMIT,
  });
  let placement = bestResult.placement;
  // Desperate last-resort: if every exterior path returned null AND the
  // player has zero enclosed alive towers (would lose a life at round end)
  // AND some pool piece could close some unenclosed alive ring next pick,
  // discard the current piece inside the player's own closed enclosure to
  // advance the bag. Mirrors what a human does when stuck with an
  // unplaceable piece — humans can place anywhere legal; the AI's normal
  // enumeration blocks interior tiles via `excludeInterior`. See
  // ai-build-desperate.ts.
  if (placement === null) {
    placement = tryDesperateInteriorDiscard(
      state,
      playerId,
      piece,
      player,
      unenclosedTowers,
      cursorPos,
      castleMargin,
      bankHugging,
      cache,
      placementCtx,
    );
  }
  // Work-is-done idle: once every castle is enclosed, a placement is only
  // worth making if it contributes to a future enclosure — i.e. fills a
  // target-ring tile (advancing/expanding a ring toward closing) or reclaims
  // net territory (usefulGain > 0). A placement that does neither is pure
  // waste: there is nothing left to build (the zone is boxed in by water / map
  // edges) and laying the piece anyway just buries it in the finished interior
  // as a junk wall (seed 424501 r6 BLUE dumped a dozen pieces inside a complete
  // shell — "wtf is blue doing"). Do nothing: hold the piece and let the build
  // timer run out. Genuine expansion (a real ring-gap fill or netGain > 0) is
  // untouched. Gated on allCastlesEnclosed so the bag-cycling that IS load-
  // bearing — burning a dud piece to reach a piece that can still enclose an
  // open tower — is unaffected. A previous version routed these to a fat-free
  // interior discard to "advance the bag"; a 10×20×15 ai-compare-multi showed
  // idling instead is strength-neutral (finalScore -0.30%, finalLives -0.08%,
  // enclosedAvg -0.31% — all noise), so the discards had no real value and the
  // idle is the cleaner behaviour.
  if (placement !== null && allCastlesEnclosed) {
    const current = placement;
    const cells = current.piece.offsets.map(([dr, dc]) =>
      packTile(current.row + dr, current.col + dc),
    );
    const wallTiles = cells.filter((key) => !aliveHouseKeys.has(key));
    const netGain =
      baselineOutside -
      computeOutsideAfterAdd(outside, wallTiles).size -
      current.piece.offsets.length;
    const fillsTargetGap = cells.some((key) => targetGaps.has(key));
    if (netGain <= 0 && !fillsTargetGap) placement = null;
  }
  if (placement === null && bestResult.reason !== undefined) {
    emitNoPlacementDiag(playerId, state.round, bestResult.reason);
  }
  if (placement !== null) {
    const cells = placement.piece.offsets.map(([dr, dc]) =>
      packTile(placement.row + dr, placement.col + dc),
    );
    // Net interior this placement reclaims — the scorer's own `usefulGain`
    // (`rawGain − pieceTiles`, see computeCandidateEnv). rawGain alone
    // over-counts: the piece's OWN wall footprint flips outside→wall and
    // would read as "reclaimed" even when nothing is enclosed; subtracting the
    // piece's tile count leaves only genuinely-sealed interior. Computed only
    // when a diag hook is active (for the build-trace) — otherwise production
    // skips the O(outside) recompute. House tiles never become walls
    // (applyPiecePlacement drops them), so exclude them from the add set.
    const wallTiles = cells.filter((key) => !aliveHouseKeys.has(key));
    const usefulGain = isAiBuildDiagHookActive()
      ? baselineOutside -
        computeOutsideAfterAdd(outside, wallTiles).size -
        placement.piece.offsets.length
      : 0;
    let cellsOnRingPerimeter = 0;
    if (targetRect !== null) {
      const ringTop = targetRect.top - 1;
      const ringBottom = targetRect.bottom + 1;
      const ringLeft = targetRect.left - 1;
      const ringRight = targetRect.right + 1;
      for (const [dr, dc] of placement.piece.offsets) {
        const r = placement.row + dr;
        const c = placement.col + dc;
        const inRingBox =
          r >= ringTop && r <= ringBottom && c >= ringLeft && c <= ringRight;
        const onRingEdge =
          r === ringTop ||
          r === ringBottom ||
          c === ringLeft ||
          c === ringRight;
        if (inRingBox && onRingEdge) cellsOnRingPerimeter++;
      }
    }
    emitWallPlacedDiag(
      playerId,
      state.round,
      cells,
      targetGaps,
      targetRect,
      cellsOnRingPerimeter,
      usefulGain,
      placement.piece.name,
    );
  }
  return { placement, chosenTowerIndex };
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
): BestPlacementResult {
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
    return selectFromEmptyScored(
      allCandidates,
      scoringCtx,
      noBuildTargets,
      fatBlockCountFor,
    );
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

  const scoreResult = scoreTopCandidates(topCandidates, scoringCtx);

  const fallbackBuildCtx: FallbackContext = {
    walls: player.walls,
    outside,
    playerInterior: getInterior(player),
    castle,
    castleMargin: extras.castleMargin,
    homeWasBroken: scoringCtx.homeWasBroken,
    unenclosedTowers: extras.unenclosedTowers,
    caresAboutHouses,
    caresAboutBonuses,
    aliveHouseKeys,
  };

  // No candidate evaluated (empty batch or every top candidate hard-rejected
  // by SCORING_RULES — typically rejectIsolatedGapTiles / rejectFatWalls /
  // rejectTinyPockets). The hard-rejects guard against imperfect placements
  // (isolated bridges, fat walls without usefulGain, tiny trapped pockets);
  // they're meant to nudge the AI toward cleaner choices, not to block it
  // from ever building when there's a real target. When the AI has a target
  // with gap-fillers available but every one fails a hard-reject, falling to
  // `pickFallbackPlacement` (which scans the FULL candidate pool — gap-fillers
  // and non-gap-fillers alike) scatters walls across the map and the target
  // never closes, recurring tick after tick. Prefer the highest-pre-score
  // gap-filler from `sortedScored` instead: closing the ring is more valuable
  // than the cosmetics the hard-rejects were optimizing for. Falls back to
  // `pickFallbackPlacement` only when no gap-filler exists at all.
  if (!scoreResult.evaluated) {
    if (noBuildTargets) return fail("unevaluated-no-targets");
    const topGapFiller = sortedScored.find(
      (entry) => entry.candidate.gapsFilled > 0,
    );
    if (topGapFiller) return ok(candidateToPlacement(topGapFiller.candidate));
    return fromFallback(
      pickFallbackPlacement(sortedScored, state, fallbackBuildCtx),
    );
  }

  const { bestCandidate, bestScore } = scoreResult;

  // All enclosed, no gaps, no towers to build toward — still allow
  // expansion if scoring found a positive placement (new large enclosure).
  // rejectTinyPockets already filtered out small-pocket candidates at
  // skill ≥ 3, so bestScore > 0 means genuinely useful territory gain.
  if (noBuildTargets && bestScore <= 0) return fail("low-score-no-targets");

  // Gap-filling was the priority but territory gain was ≤ 0 — still use the
  // best gap-filler by first-pass score (closing the ring IS the goal).
  // Reject fat walls even here — a gap-fill that creates 2×2 blocks without
  // enclosing territory is wasteful.
  if (bestScore <= 0 && restrictedToGapFillers) {
    if (fatBlockCountFor(bestCandidate) === 0) {
      return ok(candidateToPlacement(bestCandidate));
    }
    // Fat wall gap-filler — find a non-fat alternative among gap fillers
    const nonFatGapFillers = topCandidates.filter(
      (score) =>
        score.candidate.gapsFilled > 0 &&
        fatBlockCountFor(score.candidate) === 0,
    );
    if (nonFatGapFillers.length > 0) {
      nonFatGapFillers.sort(compareByNumericScoreDesc);
      return ok(candidateToPlacement(nonFatGapFillers[0]!.candidate));
    }
    // All gap fillers are fat — accept the best one anyway if the ring
    // is still open, because closing the castle outweighs the fat penalty.
    if (!allCastlesEnclosed) {
      return ok(candidateToPlacement(bestCandidate));
    }
  }

  // If no territory gain: discard or build toward unenclosed towers
  if (bestScore <= 0) {
    return fromFallback(
      pickFallbackPlacement(sortedScored, state, fallbackBuildCtx),
    );
  }

  return ok({
    piece: bestCandidate.piece,
    row: bestCandidate.row,
    col: bestCandidate.col,
  });
}

function fromFallback(result: {
  placement: AiPlacement | null;
  reason: string;
}): BestPlacementResult {
  if (result.placement !== null) return ok(result.placement);
  switch (result.reason) {
    case "interior-full":
      return fail("fallback-interior-full");
    case "discard-all-fat":
      return fail("fallback-discard-all-fat");
    case "extend-all-fat":
      return fail("fallback-extend-all-fat");
    default:
      return fail("fallback-unknown");
  }
}

/** Fallback when prescoreCandidates yielded zero scored entries (every
 *  candidate was filtered for fat walls under noTargetGaps). Bucket into
 *  open / no-fat-not-open / rest tiers and return the best of the first
 *  non-empty tier. Mutually exclusive with the territory-gain path — this
 *  branch only fires when there's nothing legitimate to score. */
function selectFromEmptyScored(
  allCandidates: readonly Candidate[],
  scoringCtx: ScoringContext,
  noBuildTargets: boolean,
  fatBlockCountFor: (candidate: Candidate) => number,
): BestPlacementResult {
  const {
    walls,
    outside,
    state,
    caresAboutHouses,
    caresAboutBonuses,
    aliveHouseKeys,
  } = scoringCtx;
  // When everything is enclosed with no gaps, don't force-place fat walls
  if (noBuildTargets) {
    return fail("scored-empty-no-targets");
  }
  const isSmallEnclosure = memoize((candidate: Candidate) =>
    createsSmallEnclosure(candidate, walls, outside, state, aliveHouseKeys),
  );

  // Bucket candidates into descending-preference tiers in a single pass.
  // Each tier subsumes the next's qualification (open ⊂ noFatNotOpen ⊂ rest).
  // We only sort the tier we end up returning from.
  const open: Candidate[] = [];
  const noFatNotOpen: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const candidate of allCandidates) {
    const cleanFat = fatBlockCountFor(candidate) === 0;
    const cleanShape = cleanFat && !isSmallEnclosure(candidate);
    if (cleanShape && candidate.wallAdjacent === 0) {
      open.push(candidate);
    } else if (cleanShape) {
      noFatNotOpen.push(candidate);
    } else {
      rest.push(candidate);
    }
  }
  if (open.length > 0) {
    open.sort(
      (a, b) =>
        candidateObstacleHits(a, caresAboutHouses, caresAboutBonuses) -
        candidateObstacleHits(b, caresAboutHouses, caresAboutBonuses),
    );
    return ok(candidateToPlacement(open[0]!));
  }
  if (noFatNotOpen.length > 0) {
    return ok(candidateToPlacement(noFatNotOpen[0]!));
  }
  // Last resort: prefer no small enclosure, then fewer fat blocks
  rest.sort((a, b) => {
    const aEncloses = isSmallEnclosure(a) ? 1 : 0;
    const bEncloses = isSmallEnclosure(b) ? 1 : 0;
    if (aEncloses !== bEncloses) return aEncloses - bEncloses;
    return fatBlockCountFor(a) - fatBlockCountFor(b);
  });
  return ok(candidateToPlacement(rest[0]!));
}

function ok(placement: AiPlacement): BestPlacementResult {
  return { placement, reason: undefined };
}

function fail(reason: NoPlacementReason): BestPlacementResult {
  return { placement: null, reason };
}

/** Gate + dispatch the desperate interior discard. Returns null when not
 *  desperate (player has ≥1 enclosed alive tower), when no alive unenclosed
 *  tower exists, when no pool piece could ever fill any unenclosed ring, or
 *  when no rotation of the current piece fits entirely inside the player's
 *  closed interior. */
function tryDesperateInteriorDiscard(
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  player: Player,
  unenclosedTowers: readonly Tower[],
  cursorPos: TilePos | undefined,
  castleMargin: number,
  bankHugging: boolean,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
): AiPlacement | null {
  if (filterAliveEnclosedTowers(player, state).length > 0) return null;
  const unenclosedAlive = unenclosedTowers.filter(
    (tower) => state.towerAlive[tower.index],
  );
  if (unenclosedAlive.length === 0) return null;
  if (
    !hasFillableTowerHope(
      state,
      playerId,
      player,
      unenclosedAlive,
      castleMargin,
      bankHugging,
      cache,
      placementCtx,
    )
  ) {
    return null;
  }
  const placement = pickDesperateInteriorDiscard(
    state,
    playerId,
    piece,
    player,
    cursorPos,
    cache,
    placementCtx,
  );
  if (placement !== null) {
    emitDesperateFiredDiag(
      playerId,
      state.round,
      placement.row,
      placement.col,
      placement.piece.name,
    );
  }
  return placement;
}

/** Look up skill config by 1-based buildSkill level (1=clumsy, 5=clean). */
function getBuildSkillConfig(buildSkill: 1 | 2 | 3 | 4 | 5): BuildSkillConfig {
  return BUILD_SKILL_TABLE[buildSkill - 1]!;
}

/** Diag-only: explain why no candidate could be placed on the target ring
 *  this tick, as a `cause×count,…` breakdown of what occupies the unfilled
 *  gap tiles. `pit` / `debris` / `cannon` / `tower` / `enemy-wall` / `grunt` /
 *  `flooded` (high-tide) / `water` (incl. sinkhole) mark a gap no piece can
 *  fill while that blocker sits there; `open` means the gap tile is buildable
 *  and the current piece simply couldn't reach/fit it (transient — a later
 *  piece may). That split tells "the AI is stuck on a blocked ring" apart from
 *  "the AI just needs a different piece next tick". Order matters: occupant
 *  blockers are tested before terrain so a grunt-on-grass reads as `grunt`,
 *  not `open`. (Low-water exposed-riverbed tiles aren't surfaced by the
 *  narrow BuildViewState.modern slice, so a buildable exposed tile reads as
 *  `water` — conservative: it never falsely claims `open`.) Never called on
 *  the production path — guarded by isAiBuildDiagHookActive() at the call
 *  site — so the per-gap scan costs nothing in real games. */
function classifyGapBlockers(
  state: BuildViewState,
  player: Player,
  targetGaps: ReadonlySet<TileKey>,
  cache: OccupancyCache,
): string {
  if (targetGaps.size === 0) return "no-gaps";
  const counts = new Map<string, number>();
  const bump = (cause: string): void => {
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  };
  const highTide = state.modern?.activeModifier === MODIFIER_ID.HIGH_TIDE;
  for (const key of targetGaps) {
    const { row, col } = unpackTile(key);
    if (cache.pitKeys.has(key)) bump("pit");
    else if (cache.cannonKeys.has(key)) bump(cannonCauseAt(state, row, col));
    else if (cache.towerKeys.has(key)) bump("tower");
    else if (cache.wallKeys.has(key) && !player.walls.has(key))
      bump("enemy-wall");
    else if (cache.gruntKeys.has(key)) bump("grunt");
    else if (highTide && isFloodedTile(state.map, row, col)) bump("flooded");
    else if (!isGrass(state.map.tiles, row, col)) bump("water");
    else bump("open");
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cause, count]) => `${cause}×${count}`)
    .join(",");
}

/** Whether a cannon-occupied gap tile holds a live cannon or dead-cannon
 *  debris — debris is the common ring-gap case (a destroyed cannon's tiles
 *  block rebuilding until zone reset). */
function cannonCauseAt(
  state: BuildViewState,
  row: number,
  col: number,
): string {
  for (const candidate of state.players) {
    for (const cannon of candidate.cannons) {
      if (isCannonTile(cannon, row, col)) {
        return isCannonAlive(cannon) ? "cannon" : "debris";
      }
    }
  }
  return "cannon";
}

/** Enumerate all valid placements for a piece, scoring adjacency/gap metrics. */
function enumerateCandidates(
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  walls: ReadonlySet<TileKey>,
  outside: Set<TileKey>,
  targetGaps: Set<TileKey>,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
  interiorExcludingGaps: Set<TileKey>,
): Candidate[] {
  const candidates: Candidate[] = [];
  const bonusKeys = new Set<TileKey>();
  for (const bonus of state.bonusSquares)
    bonusKeys.add(packTile(bonus.row, bonus.col));
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
          if (bonusKeys.has(packTile(pr, pc))) bonusHit++;
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

/** Score all candidates with gap/wall/fat-wall metrics; filter fat walls when no gaps remain. */
function prescoreCandidates(
  allCandidates: readonly Candidate[],
  walls: ReadonlySet<TileKey>,
  noTargetGaps: boolean,
  aliveHouseKeys: ReadonlySet<TileKey>,
): Scored[] {
  const scored: Scored[] = [];
  for (const candidate of allCandidates) {
    const { hasFatWall, hasFatRun, gapClosingFat } = checkFatWall(
      walls,
      candidate,
      aliveHouseKeys,
    );

    // Reject fat-RUN placements (2×3 / 3×2 doubled-wall blocks) unless they
    // close at least one gap — those are the visible ##/##/## or ####/####
    // touching-castle pathology. The gap-filled exception prevents the
    // build phase from stalling when fat-run is the only way to close a
    // critical ring gap (seed 7 modern needed this — pure hard-reject
    // starved the AI of placements and the build phase never ended).
    if (hasFatRun && candidate.gapsFilled === 0) continue;
    if (noTargetGaps && (hasFatWall || gapClosingFat)) continue;

    const fatBlocks = countFatBlocks(walls, candidate, aliveHouseKeys);

    // Heavy penalty when a gap-closing placement still creates a fat-run,
    // so the scorer prefers a non-fat-run alternative when one exists. The
    // penalty is much larger than the typical gap-fill bonus so a fat-run
    // candidate only wins when EVERY non-fat-run candidate is worse.
    const fatRunPenalty = hasFatRun ? FAT_WALL_RUN_PENALTY : 0;

    scored.push({
      candidate,
      score:
        candidate.gapsFilled * GAP_FILLED_WEIGHT +
        candidate.gapAdjacent * GAP_ADJACENT_WEIGHT +
        candidate.connectedTiles * CONNECTED_TILES_WEIGHT +
        candidate.wallAdjacent -
        (hasFatWall ? FAT_WALL_TILE_PENALTY : 0) -
        fatRunPenalty,
      gapClosingFat,
      hasFatWall,
      fatBlocks,
    });
  }
  return scored;
}

/** Analyze board enclosures: which towers are open, whether to skip home, etc. */
function analyzeEnclosures(
  state: BuildViewState,
  player: Player,
  castle: Castle,
  homeWasBroken: boolean,
): EnclosureAnalysis {
  const zoneTowers = state.map.towers.filter(
    (tower) => tower.zone === castle.tower.zone,
  );

  // `outside` is still needed for the 4-dir diagonal-leak disambiguation
  // (towerReachesOutsideCardinal) and for hasMeaningfulHomeRingGaps. The
  // 8-dir "is this tower enclosed by my walls" question is answered by
  // player.enclosedTowers, which recheckTerritory keeps in sync via the same
  // computeOutside-derived interior.
  const outside = computeOutside(player.walls);
  const enclosedTowerSet = new Set(
    player.enclosedTowers.map((tower) => tower.index),
  );
  const homeTowerEnclosed = enclosedTowerSet.has(castle.tower.index);
  // 4-dir BFS from a tower: returns true if the BFS can reach the map
  // border without crossing walls.
  const unenclosedTowers = zoneTowers.filter((tower) => {
    if (!enclosedTowerSet.has(tower.index)) {
      // 8-dir flood says not enclosed but 4-dir BFS can't reach the map
      // border — the tower has a diagonal-only leak (e.g. two walls form
      // a diagonal step where 8-dir flood passes between them, but no
      // single ring tile is open). The ideal castle rect's
      // findReachableRingGaps will report zero gaps in this case (no ring
      // tile to fill), but the tower is genuinely leaking and territory
      // isn't being counted. Include it in unenclosedTowers anyway so
      // `noBuildTargets` doesn't fire and the AI's normal scoring (via
      // `usefulGainRule`, which rewards placements that shrink `outside`)
      // can find the plug tile — usually a single interior cell that
      // blocks the diagonal step. Previously this branch returned `false`
      // to "treat as enclosed", which left the AI idle for the whole build
      // phase: no target, noBuildTargets=true, fat-wall candidates pruned
      // by prescoreCandidates, scored.length=0, placement=null.
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
