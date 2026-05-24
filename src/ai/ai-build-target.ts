/**
 * AI build target selection — picks the rectangle the AI builds toward each
 * tick (home ring repair → secondary tower → territory expansion). Called
 * by the build placement orchestrator (ai-strategy-build.ts), which owns
 * candidate enumeration and scoring; this module owns the "which rect am
 * I trying to close" decision and the gap-feasibility helpers it uses.
 */

import { canPlacePiece, type PlacementContext } from "../game/index.ts";
import {
  hasAliveHouseAt,
  hasGruntAt,
  type OccupancyCache,
} from "../shared/core/board-occupancy.ts";
import type { TileBounds, TileRect } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import { hasCannonAt, hasTowerAt } from "../shared/core/occupancy-queries.ts";
import {
  ALL_PIECE_SHAPES,
  type PieceShape,
  rotateCW,
} from "../shared/core/pieces.ts";
import { getInterior } from "../shared/core/player-interior.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { FreshInterior, Player } from "../shared/core/player-types.ts";
import {
  hasPitAt,
  isGrass,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import { compareByNumericScoreDesc } from "./ai-build-score.ts";
import type { TargetContext, TargetResult } from "./ai-build-types.ts";
import {
  addInteriorPlugGaps,
  castleRect,
  computeFillableGaps,
  filterUnfillableGaps,
  findGapTiles,
  findReachableRingGaps,
  scoreBuildTowerTarget,
} from "./ai-castle-rect.ts";

/** Which branch of `selectTarget` produced the result this tick. Used by the
 *  AI build-survival test runner to classify stall rounds by their path-mix
 *  signature (HOME-dominant = home-ring repair, SEC-dominant = persistence
 *  commitment, EXP-dominant = all towers enclosed and expanding territory,
 *  STRAT_RECT = strategic fallback found a rect, STRAT_NONE = nothing at all).
 *  Production code never sets the hook; it stays null and the check costs
 *  one branch per call. */
export type SelectTargetPathHook = (
  playerId: ValidPlayerId,
  round: number,
  path: "HOME" | "SEC" | "EXP" | "STRAT_RECT" | "STRAT_NONE",
  result?: TargetResult,
) => void;

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
const NO_TARGET: TargetResult = { targetGaps: new Set(), targetRect: null };
/** Max gap tiles the AI considers evaluable in a single build turn. Beyond this, the target is skipped. */
export const MANAGEABLE_GAP_LIMIT = 8;

let selectTargetPathHook: SelectTargetPathHook | undefined = undefined;

export function setSelectTargetPathHook(
  hook: SelectTargetPathHook | undefined,
): void {
  selectTargetPathHook = hook;
}

/** Select which rectangle to build/repair.
 *  Pipeline: tryRepairHomeCastle → trySecondaryTower → tryExpandTerritory.
 *  Each phase only runs if the previous one found no gaps. */
export function selectTarget(ctx: TargetContext): TargetResult {
  // Phase 1: repair home castle ring
  const home = tryRepairHomeCastle(ctx);
  if (home.targetGaps.size > 0) {
    selectTargetPathHook?.(ctx.playerId, ctx.state.round, "HOME", home);
    return home;
  }
  // Phase 2: build toward best unenclosed secondary tower
  const secondary = trySecondaryTower(ctx);
  if (secondary.targetGaps.size > 0) {
    selectTargetPathHook?.(ctx.playerId, ctx.state.round, "SEC", secondary);
    return secondary;
  }
  // Phase 3: expand territory when all towers are enclosed
  const expand = tryExpandTerritory(ctx);
  if (expand.targetGaps.size > 0) {
    selectTargetPathHook?.(ctx.playerId, ctx.state.round, "EXP", expand);
    return expand;
  }
  // All three phases bailed — typically because every tower's `canFillAfter-
  // Plugging` gate fired (current piece doesn't fit any gap this tick). Without
  // a target the orchestrator can't restrict to gap-fillers and the scattered
  // fallback in `pickFallbackPlacement` takes over, dispersing walls across
  // the map without closing any ring. When the player still has unenclosed
  // towers, keep the strategic target — the home castle ring (or top secondary
  // if home is being skipped) with its raw gap set — so scoring still rewards
  // gap-adjacent and wall-adjacent placements. Future pieces will close the
  // gap; this tick's placement at least lands near the ring instead of in
  // arbitrary corners of the board.
  const fallback = strategicFallbackTarget(ctx);
  selectTargetPathHook?.(
    ctx.playerId,
    ctx.state.round,
    fallback.targetGaps.size > 0 ? "STRAT_RECT" : "STRAT_NONE",
    fallback,
  );
  return fallback;
}

/** Strategic fallback when every selectTarget phase bailed. Returns the home
 *  castle rect with its raw gap set (or the top-scored secondary's rect if
 *  home is being skipped). Bypasses the `canFillAfterPlugging` gate — that
 *  gate is per-tick optimization, not strategic gating. */
function strategicFallbackTarget(ctx: TargetContext): TargetResult {
  const { state, player, castle, castleMargin, bankHugging, cursorPos } = ctx;
  if (ctx.unenclosedTowers.length === 0) return NO_TARGET;
  if (!ctx.effectiveSkipHome && player.homeTower) {
    const gaps = findReachableRingGaps(
      castle,
      player.walls,
      state,
      getInterior(player),
    );
    if (gaps.size > 0) return { targetGaps: gaps, targetRect: castle };
  }
  // Home unavailable — pick the best-scored secondary tower's rect, raw gaps.
  const candidatePool = ctx.effectiveSkipHome
    ? ctx.otherUnenclosed
    : ctx.unenclosedTowers;
  if (candidatePool.length === 0) return NO_TARGET;
  const currentRow = cursorPos?.row ?? castle.tower.row;
  const currentCol = cursorPos?.col ?? castle.tower.col;
  const sorted = candidatePool
    .map((tower) =>
      scoreBuildTowerTarget(
        tower,
        state,
        player,
        currentRow,
        currentCol,
        castleMargin,
        bankHugging,
      ),
    )
    .sort(compareByNumericScoreDesc);
  for (const { tower } of sorted) {
    const rect = castleRect(
      tower,
      state.map.tiles,
      state.map.towers,
      castleMargin,
      !bankHugging,
    );
    const gaps = findReachableRingGaps(
      rect,
      player.walls,
      state,
      getInterior(player),
    );
    if (gaps.size > 0) return { targetGaps: gaps, targetRect: rect };
  }
  return NO_TARGET;
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
    cache,
    placementCtx,
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
      cache,
      placementCtx,
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
  const targetRect = expandRectAroundBlockers(castle, state, player);
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
    lastTargetTowerIndex,
  } = ctx;
  const buildTowers = effectiveSkipHome ? otherUnenclosed : unenclosedTowers;
  if (buildTowers.length === 0) return NO_TARGET;

  // Persistence short-circuit: if last tick committed to a tower that's
  // still alive, manageable, and piece-feasible right now, reuse it without
  // re-scoring. Skips the cursor-driven per-tick re-decision that drives
  // Mode #2 churn while preserving Modes #1/#3/#4 guards (the cache was
  // only written when those invariants held).
  if (lastTargetTowerIndex !== undefined) {
    const cached = buildTowers.find((t) => t.index === lastTargetTowerIndex);
    if (cached) {
      const cachedRect = expandRectAroundBlockers(
        castleRect(
          cached,
          state.map.tiles,
          state.map.towers,
          castleMargin,
          !bankHugging,
        ),
        state,
        player,
      );
      const cachedGaps = computeFillableGaps(
        cachedRect,
        player.walls,
        getInterior(player),
        state,
        bankHugging,
      );
      if (
        cachedGaps.size > 0 &&
        cachedGaps.size <= MANAGEABLE_GAP_LIMIT &&
        canFillAfterPlugging(ctx, cachedGaps, cachedRect)
      ) {
        return {
          targetGaps: cachedGaps,
          targetRect: cachedRect,
          chosenTowerIndex: cached.index,
        };
      }
    }
  }

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
    const rect = expandRectAroundBlockers(
      castleRect(
        bestTower,
        state.map.tiles,
        state.map.towers,
        castleMargin,
        !bankHugging,
      ),
      state,
      player,
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
      // Cache only when ALL persistence invariants hold: tower is alive,
      // gaps are manageable, and the piece-feasibility check just passed
      // (implicit from getting here without the `continue`). Caching a
      // ring with > MANAGEABLE_GAP_LIMIT gaps risks lock-in on Modes
      // #3/#4 (structurally unsealable rings); caching a dead tower
      // amplifies Mode #1 preemption.
      const cacheable =
        gaps.size > 0 &&
        gaps.size <= MANAGEABLE_GAP_LIMIT &&
        state.towerAlive[bestTower.index];
      return {
        targetGaps: gaps,
        targetRect: rect,
        chosenTowerIndex: cacheable ? bestTower.index : undefined,
      };
    }
  }
  return NO_TARGET;
}

/** Expand a castle rect outward to route around temporary blockers (grunts,
 *  burning pits, alive houses) on the wall ring. Only grows along directions
 *  that have a blocker on the ring; water/permanent terrain doesn't trigger.
 *  Used by tryRepairHomeCastle and trySecondaryTower so secondaries also get
 *  the Mode #4 escape. */
function expandRectAroundBlockers(
  initialRect: TileRect,
  state: BuildViewState,
  player: Player,
): TileRect {
  let { top, bottom, left, right } = initialRect;
  const freeRatio = computeInteriorFreeRatio(initialRect, player, state);
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
      if (!isGrass(state.map.tiles, row, col)) continue;
      const blocked =
        hasGruntAt(state.grunts, row, col) ||
        hasPitAt(state.burningPits, row, col) ||
        hasAliveHouseAt(state, row, col);
      if (!blocked) continue;
      if (
        row === wallRingTop &&
        top - 1 >= initialRect.top - MAX_EXPAND &&
        top - 1 >= 1
      ) {
        top--;
        expanded = true;
      }
      if (
        row === wallRingBottom &&
        bottom + 1 <= initialRect.bottom + MAX_EXPAND &&
        bottom + 1 < GRID_ROWS - 1
      ) {
        bottom++;
        expanded = true;
      }
      if (
        col === wallRingLeft &&
        left - 1 >= initialRect.left - MAX_EXPAND &&
        left - 1 >= 1
      ) {
        left--;
        expanded = true;
      }
      if (
        col === wallRingRight &&
        right + 1 <= initialRect.right + MAX_EXPAND &&
        right + 1 < GRID_COLS - 1
      ) {
        right++;
        expanded = true;
      }
    }
    if (!expanded) break;
  }
  return { top, bottom, left, right };
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
  const { state, playerId, player, piece, cache, placementCtx } = ctx;
  const interior = getInterior(player);
  if (
    canPieceFillAnyGap(
      state,
      playerId,
      piece,
      interior,
      gaps,
      rect,
      cache,
      placementCtx,
    )
  )
    return true;
  return (
    plugUnreachableGaps(
      gaps,
      rect,
      state,
      playerId,
      player.walls,
      interior,
      cache,
      placementCtx,
    ) &&
    canPieceFillAnyGap(
      state,
      playerId,
      piece,
      interior,
      gaps,
      rect,
      cache,
      placementCtx,
    )
  );
}

/**
 * When the current piece can't fill any gap, check if some gaps are
 * structurally unreachable by ANY piece shape.  For those, add interior plug
 * tiles (seal diagonal leaks from inside, same as water/pit plugs).
 * Returns true if the gap set was modified.
 */
function plugUnreachableGaps(
  gaps: Set<TileKey>,
  rect: TileRect | null,
  state: BuildViewState,
  playerId: ValidPlayerId,
  walls: ReadonlySet<TileKey>,
  interior: FreshInterior,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
): boolean {
  if (!rect || gaps.size === 0) return false;
  const unreachable: TileKey[] = [];
  for (const gapKey of gaps) {
    if (
      !isGapFillableByAnyShape(
        state,
        playerId,
        interior,
        gapKey,
        rect,
        cache,
        placementCtx,
      )
    ) {
      unreachable.push(gapKey);
    }
  }
  if (unreachable.length === 0) return false;
  for (const gapKey of unreachable) gaps.delete(gapKey);
  // Seal diagonal-leak through interior-facing grass (same shape as water/pit plug)
  addInteriorPlugGaps(gaps, unreachable, rect, walls, state.map.tiles);
  filterUnfillableGaps(gaps, state, interior);
  return true;
}

function canPieceFillAnyGap(
  state: BuildViewState,
  playerId: ValidPlayerId,
  piece: PieceShape,
  interior: ReadonlySet<TileKey>,
  gaps: Set<TileKey>,
  rect: TileRect | null,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
): boolean {
  const adjusted = adjustInterior(interior, gaps, rect);
  return canAnyRotationFillGap(
    [piece],
    gaps,
    adjusted,
    state,
    playerId,
    cache,
    placementCtx,
  );
}

/** Check if ANY standard piece shape (in any rotation) could fill a single gap tile. */
function isGapFillableByAnyShape(
  state: BuildViewState,
  playerId: ValidPlayerId,
  interior: ReadonlySet<TileKey>,
  gapKey: TileKey,
  rect: TileRect | null,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
): boolean {
  const singleGap = new Set<TileKey>([gapKey]);
  const adjusted = adjustInterior(interior, singleGap, rect);
  return canAnyRotationFillGap(
    ALL_PIECE_SHAPES,
    singleGap,
    adjusted,
    state,
    playerId,
    cache,
    placementCtx,
  );
}

/**
 * Build an adjusted interior set by removing gap tiles and castle-rect interior.
 * Gap tiles are ring holes, not forbidden interior; the rect interior is open
 * so the AI is free to extend pieces into it while filling gaps.
 */
export function adjustInterior(
  interior: ReadonlySet<TileKey>,
  gaps: Set<TileKey>,
  rect?: TileRect | null,
): Set<TileKey> {
  const adjusted = new Set(interior);
  for (const gapKey of gaps) adjusted.delete(gapKey);
  if (rect) {
    for (let r = rect.top; r <= rect.bottom; r++) {
      for (let c = rect.left; c <= rect.right; c++) {
        adjusted.delete(packTile(r, c));
      }
    }
  }
  return adjusted;
}

/** Try all rotations of each piece against each gap anchor; return true on first fit. */
function canAnyRotationFillGap(
  pieces: readonly PieceShape[],
  gaps: Set<TileKey>,
  adjusted: ReadonlySet<TileKey>,
  state: BuildViewState,
  playerId: ValidPlayerId,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
): boolean {
  for (const shape of pieces) {
    let rot = shape;
    for (let rotIdx = 0; rotIdx < 4; rotIdx++) {
      for (const gapKey of gaps) {
        const { row: gr, col: gc } = unpackTile(gapKey);
        for (const [dr, dc] of rot.offsets) {
          if (
            canPlacePiece(
              state,
              playerId,
              rot.offsets,
              gr - dr,
              gc - dc,
              adjusted,
              cache,
              placementCtx,
            )
          )
            return true;
        }
      }
      rot = rotateCW(rot);
    }
  }
  return false;
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
