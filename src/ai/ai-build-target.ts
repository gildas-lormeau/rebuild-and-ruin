/**
 * AI build target selection — picks the rectangle the AI builds toward each
 * tick (home ring repair → secondary tower → territory expansion). Called
 * by the build placement orchestrator (ai-strategy-build.ts), which owns
 * candidate enumeration and scoring; this module owns the "which rect am
 * I trying to close" decision and the gap-feasibility helpers it uses.
 */

import { canPlacePiece, type PlacementContext } from "../game/index.ts";
import type {
  TileBounds,
  TilePos,
  TileRect,
  Tower,
  TowerIdx,
} from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS, type TileKey } from "../shared/core/grid.ts";
import type { PieceShape } from "../shared/core/pieces.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { FreshInterior, Player } from "../shared/core/player-types.ts";
import {
  hasPitAt,
  isGrass,
  manhattanDistance,
  packTile,
  unpackTile,
} from "../shared/core/spatial.ts";
import type { BuildViewState } from "../shared/core/system-interfaces.ts";
import {
  hasAliveHouseAt,
  hasGruntAt,
  type OccupancyCache,
} from "../shared/sim/board-occupancy.ts";
import { hasCannonAt, hasTowerAt } from "../shared/sim/occupancy-queries.ts";
import { ALL_PIECE_SHAPES, rotateCW } from "../shared/sim/pieces.ts";
import { getInterior } from "../shared/sim/player-interior.ts";
import {
  emitTargetSelectedDiag,
  isAiBuildDiagHookActive,
  type SelectTargetPath,
  type TargetAlternative,
} from "./ai-build-diag.ts";
import { compareByNumericScoreDesc } from "./ai-build-score.ts";
import type { TargetContext, TargetResult } from "./ai-build-types.ts";
import {
  addInteriorPlugGaps,
  castleRect,
  clampRectOffUnwallable,
  computeFillableGaps,
  filterUnfillableGaps,
  findGapTiles,
  findReachableRingGaps,
  scoreBuildTowerTarget,
  snapRectToReuseWalls,
} from "./ai-castle-rect.ts";
import { findEnclosureCut } from "./ai-min-cut.ts";

/** An enclosure the planner may pursue this tick: one tower (solo ring) or two
 *  (merged ring), its minimum enclosure cut (new wall tiles needed), the rect
 *  the cut wraps, a goal-hierarchy priority class (3 = alive home, 2 = any
 *  alive, 1 = dead-but-revivable), and a within-class value (tower worth minus
 *  wall cost) that lets a 2-tower merge compete against solo rings. */
interface EnclosureCandidate {
  towers: Tower[];
  gaps: Set<TileKey>;
  rect: TileRect;
  priority: number;
  value: number;
}

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
/** Default lookahead depth for the upcoming-pieces × target-fillability diag
 *  signal. 3 covers ~2-3 ticks between piece arrivals; if the bag queue has
 *  fewer pieces left, the emitted array is shorter. */
const UPCOMING_PIECE_LOOKAHEAD = 3;
const EMPTY_UPCOMING_FIT: {
  upcomingPieces: readonly string[];
  upcomingPieceFitsTarget: readonly boolean[];
} = { upcomingPieces: [], upcomingPieceFitsTarget: [] };
/** Max static anchors (houses + bonus squares) the idle-window capture phase
 *  gate-tests per tick. Bounds the per-tick cost (each attempt runs
 *  computeFillableGaps + a piece-fit sweep). Nearest-first, so the cap drops
 *  the far anchors least likely to be cheaply closeable this tick. */
const CAPTURE_SCAN_LIMIT = 6;
/** Half-width of the local pocket box the capture phase walls around an anchor.
 *  A 2-tile radius → 5×5 interior whose 1-tile ring leans on the player's
 *  adjacent existing wall for most of its perimeter. Small enough that a
 *  wall-adjacent anchor yields ≤ MANAGEABLE_GAP_LIMIT new holes, while an
 *  anchor sitting in open ground (no nearby wall to lean on) produces a full
 *  perimeter of gaps and is correctly rejected — we only cheaply capture what
 *  abuts the territory, never wall a lone hut in a field. */
const CAPTURE_POCKET_RADIUS = 2;
/** Relative value weights for ranking capture pockets by what their interior
 *  encloses. A bonus square is worth territoryBonusSquarePoints (100–1000 pts,
 *  build-system.ts) — by far the biggest prize; a grunt is DESTROY_GRUNT_POINTS
 *  plus threat removal; a house scores nothing directly but spawns a grunt on
 *  every enemy's zone (offensive disruption). Used only to order pockets, not
 *  to compute real scores, so coarse magnitudes are enough. Grunts are counted
 *  per-pocket as a byproduct: they sit inside a static-anchor pocket but are
 *  never anchors themselves (they pace during build — chasing one thrashes). */
const CAPTURE_VALUE_BONUS = 100;
const CAPTURE_VALUE_GRUNT = 16;
const CAPTURE_VALUE_HOUSE = 20;
/** Value weights ranking enclosure candidates within a priority class:
 *  per-tower worth minus per-wall cost. A 2-alive-tower merge scores
 *  2·ALIVE − cut, beating a solo (1·ALIVE − cut) whenever the second tower's
 *  worth exceeds the extra walls — which the merge saving-cap already bounds. */
const CANDIDATE_VALUE_PER_ALIVE = 100;
const CANDIDATE_VALUE_PER_DEAD = 30;
const CANDIDATE_VALUE_PER_WALL = 1;
/** Merge gates. The aggressive-archetype personality (see `collectMerge-
 *  Candidates`) builds sprawling consolidated strongholds, so distance/area are
 *  permissive — but MERGE_MAX_GAPS is the load-bearing SAFETY cap: a merge whose
 *  ring can't be CLOSED in a build phase (cut > MERGE_MAX_GAPS) becomes an
 *  unclosable target the build thrash latches onto, closing neither it nor the
 *  near-complete home (seed 2705100 BLUE: 38-gap merge → eliminated). The
 *  closeability cap prevents that self-destruction while still allowing big
 *  rings whose gaps are mostly already walled (small cut, large interior).
 *  Distance/area bound how far the consolidation can reach; MERGE_MIN_WALL_SAVING
 *  keeps the shared ring at least marginally cheaper than two separate rings. */
const MERGE_MAX_DISTANCE = 18;
const MERGE_MIN_WALL_SAVING = 2;
const MERGE_MAX_INTERIOR_AREA = 180;
const MERGE_MAX_GAPS = 22;
/** Solo-ring closeability cap. A solo candidate whose min-cut exceeds this
 *  can't be sealed in one build phase via the wide-gap bypass, so the planner
 *  won't commit the whole build to it WHEN a manageable alternative exists —
 *  the planner-side analog of the `homeWasBroken` skip + the `MERGE_MAX_GAPS`
 *  merge cap. Unlike `homeWasBroken` (previous-round state), this is the
 *  CURRENT cut, so it also catches a home that breaks mid-build. */
const SOLO_MAX_GAPS = 30;
/** Estimated wall-clock seconds the AI spends per piece placement during
 *  WALL_BUILD: ~0.5s post-place think + ~0.35s pre-place dwell + ~0.5s cursor
 *  travel (the POST/PRE_PLACE_DELAY + spread averages in ai-constants.ts plus a
 *  few tiles of movement at BUILD_CURSOR_SPEEDS). A single documented estimate,
 *  not a live computation — cursor-travel distance is the dominant unknown, so
 *  per-term precision would be false. Converts the remaining build time into a
 *  gap-closing budget for the deadline cap (`deadlineGapBudget`). */
const EST_SECONDS_PER_PLACEMENT = 1.35;
/** Net ring-gap tiles a single placement closes, held conservatively below the
 *  4-tile piece size: only ~1-2 cells of a piece land on the min-cut ring (the
 *  rest extend into interior), and blocked retries / non-fitting bag pieces
 *  waste whole placements. Higher → the deadline cap trusts the AI to close
 *  more per second and shrinks the target later (less protective); lower →
 *  shrinks earlier (banks a guaranteed smaller ring sooner). The ai-compare /
 *  survival tuning knob for the deadline-aware fallback. */
const GAPS_PER_PLACEMENT = 1.8;
/** Max gap tiles the AI considers evaluable in a single build turn. Beyond this, the target is skipped. */
export const MANAGEABLE_GAP_LIMIT = 8;

/** Select which rectangle to build/repair.
 *  Pipeline: planEnclosureTarget → tryEncloseCaptures → tryExpandTerritory.
 *  Each phase only runs if the previous one found no gaps. The last two are
 *  the idle-window family (gated on allCastlesEnclosed): the value-ranked
 *  capture phase (houses / bonus squares / grunts-inside) takes priority over
 *  aimless uniform expansion, which runs last. */
export function selectTarget(ctx: TargetContext): TargetResult {
  const planned = planEnclosureTarget(ctx);
  if (planned.targetGaps.size > 0) {
    // Diag path is approximate under the planner: home is priority-1 while
    // unenclosed, so label by home-enclosure state. Debug-only — does not
    // affect outcome metrics.
    emitTargetSelected(ctx, ctx.homeTowerEnclosed ? "SEC" : "HOME", planned);
    return planned;
  }
  return selectIdleOrFallback(ctx);
}

/** Compute a tower's manageable wall-ring and check whether any piece in
 *  `poolPieces` could fit any rotation into one of its gaps. Returns
 *  `{ rect, gaps }` on a hit (gaps in [1, MANAGEABLE_GAP_LIMIT] AND at least
 *  one rotation fits at least one gap), null otherwise. Shared by the
 *  cursor-anticipation peek (uses the geometry to compute a centroid anchor)
 *  and the desperate-interior fallback's hope check (just needs the boolean).
 *  Keeps the `castleRect → findReachableRingGaps → adjustInterior →
 *  canAnyRotationFillGap` sequence in one place. */
export function poolFillableTowerRing(
  tower: Tower,
  state: BuildViewState,
  player: Player,
  interior: ReadonlySet<TileKey>,
  castleMargin: number,
  bankHugging: boolean,
  poolPieces: readonly PieceShape[],
  playerId: ValidPlayerId,
  cache: OccupancyCache,
  placementCtx: PlacementContext,
): { rect: TileRect; gaps: Set<TileKey> } | null {
  const rect = castleRect(
    tower,
    state.map.tiles,
    state.map.towers,
    castleMargin,
    !bankHugging,
  );
  const gaps = findReachableRingGaps(rect, player.walls, state, interior);
  if (gaps.size === 0 || gaps.size > MANAGEABLE_GAP_LIMIT) return null;
  const adjusted = adjustInterior(interior, gaps, rect);
  if (
    !canAnyRotationFillGap(
      poolPieces,
      gaps,
      adjusted,
      state,
      playerId,
      cache,
      placementCtx,
    )
  ) {
    return null;
  }
  return { rect, gaps };
}

/** Idle-window + fallback tail shared by the heuristic pipeline and the
 *  enclosure planner. Runs once all tower-enclosure phases bail. */
function selectIdleOrFallback(ctx: TargetContext): TargetResult {
  // Idle window (all towers enclosed): prefer DIRECTED captures over aimless
  // uniform expansion, which would otherwise return a +2-ring target every
  // tick and starve the captures (seed 829597 r28 RED: EXP fired all build,
  // houses never pursued). One value-ranked phase walls the richest closeable
  // pocket (bonus square / house anchor, grunts inside counted as byproduct).
  const capture = tryEncloseCaptures(ctx);
  if (capture.targetGaps.size > 0) {
    emitTargetSelected(ctx, "CAPTURE", capture);
    return capture;
  }
  const expand = tryExpandTerritory(ctx);
  if (expand.targetGaps.size > 0) {
    emitTargetSelected(ctx, "EXP", expand);
    return expand;
  }
  // All build phases bailed — typically because every tower's `canFillAfter-
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
  const resultPath = fallback.targetGaps.size > 0 ? "STRAT_RECT" : "STRAT_NONE";
  emitTargetSelected(ctx, resultPath, fallback);
  return fallback;
}

/** Enclosure planner: a single value-ranked pass over enclosure candidates,
 *  each costed by its minimum enclosure cut. Candidates are one tower (solo
 *  ring) or, for the aggressive archetype, two nearby alive towers (shared
 *  ring — see `collectMergeCandidates`). Priority follows the goal hierarchy:
 *  alive home > any alive > dead-only; within a class, higher value (tower
 *  worth minus walls) wins, so a wall-efficient merge outranks the solo rings
 *  it replaces. Empty-region territory is covered by the idle-window
 *  capture/expand phases. */
function planEnclosureTarget(ctx: TargetContext): TargetResult {
  const { state, homeTowerEnclosed, lastTargetTowerIndex } = ctx;
  const pool = getBuildTowerPool(ctx);
  if (pool.length === 0) return NO_TARGET;
  const homeIndex = ctx.castle.tower.index;

  // Persistence short-circuit (anti-churn): reuse last tick's committed tower
  // when it's still a closeable candidate, skipping the re-rank. Safe because
  // walls only grow within a build phase (home can't re-breach mid-phase) and
  // lastTargetTowerIndex resets at build-end, so the cache can't override a
  // newly-higher-priority home.
  if (lastTargetTowerIndex !== undefined) {
    const cached = pool.find((tower) => tower.index === lastTargetTowerIndex);
    if (cached) {
      const reuse = tryCloseableTowerTarget(cached, ctx);
      if (reuse !== null) return reuse;
    }
  }

  const solos: EnclosureCandidate[] = [];
  for (const tower of pool) {
    // The rect is the protected interior (cannon space) the cut wraps around;
    // soloEnclosure clamps it off a border-reaching uncuttable channel when the
    // full rect would otherwise read as unenclosable.
    const { rect, cut } = soloEnclosure(tower, ctx);
    // null = unenclosable (channel reaches border); empty = already enclosed.
    if (cut === null || cut.size === 0) continue;
    solos.push(makeCandidate([tower], cut, rect, homeIndex, state));
  }
  if (solos.length === 0) return NO_TARGET;

  const candidates = [...solos, ...collectMergeCandidates(solos, ctx)];
  // Goal hierarchy first, then highest value (a wall-efficient merge beats the
  // solo rings it replaces); cheapest cut breaks remaining ties.
  candidates.sort(
    (a, b) =>
      b.priority - a.priority || b.value - a.value || a.gaps.size - b.gaps.size,
  );

  // Closeability cap: when a closeable ALIVE ring exists this phase, don't let
  // the wide-gap bypass commit the build to a ring it can't finish in time.
  // Diverts to the manageable alternative so the build banks a real enclosure
  // rather than thrashing on a ring it can't close. The alternative must be
  // alive (priority ≥ 2) — abandoning a wide home for a dead-tower revival ring
  // trades live territory for nothing.
  //
  // The cap is DEADLINE-AWARE: it starts at SOLO_MAX_GAPS (a ring needing more
  // than a whole build phase of new walls is hopeless from the outset) and
  // ratchets down toward MANAGEABLE_GAP_LIMIT as `state.timer` runs out, so a
  // MEDIUM ring (8–30 gaps) that can't close in the seconds left is diverted
  // too — the human "I can't finish the big ring, lock in a tower I CAN close
  // before time expires" reflex. The budget is monotone in the timer (only
  // shrinks), so the chosen target can only narrow across ticks, never re-widen
  // (the property that keeps this late-phase shrink from thrashing targets).
  const deadlineMaxGaps = Math.max(
    MANAGEABLE_GAP_LIMIT,
    Math.min(SOLO_MAX_GAPS, deadlineGapBudget(state.timer)),
  );
  const hasManageableAlt = candidates.some(
    (cand) => cand.gaps.size <= MANAGEABLE_GAP_LIMIT && cand.priority >= 2,
  );

  for (const cand of candidates) {
    const manageable = cand.gaps.size <= MANAGEABLE_GAP_LIMIT;
    if (!manageable && cand.gaps.size > deadlineMaxGaps && hasManageableAlt) {
      continue;
    }
    // Wide-gap bypass: while home isn't enclosed, hold a many-gap ring as the
    // target even without a current-piece fit (wall-adjacent scoring grows
    // walls toward closure). Once home is enclosed, require piece feasibility
    // so placements can't drift into topologies that re-open home.
    if (manageable || homeTowerEnclosed) {
      if (!canFillAfterPlugging(ctx, cand.gaps, cand.rect)) continue;
    }
    // Only solo alive towers cache for the persistence short-circuit — a merge
    // has two towers (no single index to key on) and is cheap to re-derive
    // deterministically each tick.
    const cacheable =
      manageable &&
      cand.towers.length === 1 &&
      state.towerAlive[cand.towers[0]!.index];
    return {
      targetGaps: cand.gaps,
      targetRect: cand.rect,
      chosenTowerIndex: cacheable ? cand.towers[0]!.index : undefined,
    };
  }
  return NO_TARGET;
}

/** Ring-gap tiles the AI can realistically still place before the WALL_BUILD
 *  timer expires: remaining seconds ÷ per-placement time × gaps closed per
 *  placement. Drives the deadline-aware closeability cap in
 *  `planEnclosureTarget`. Strictly decreasing in `timerSeconds` as the clock
 *  ticks down, so the cap it feeds only narrows the target and never re-opens a
 *  wider one — the property that keeps the late-phase shrink from thrashing
 *  between targets. Clamping to the [MANAGEABLE_GAP_LIMIT, SOLO_MAX_GAPS] band
 *  is the caller's job. */
function deadlineGapBudget(timerSeconds: number): number {
  const placementsLeft = timerSeconds / EST_SECONDS_PER_PLACEMENT;
  return Math.floor(placementsLeft * GAPS_PER_PLACEMENT);
}

/** Merge candidates: every close alive non-home pair whose shared ring saves
 *  at least MERGE_MIN_WALL_SAVING tiles over two separate rings and whose
 *  combined interior stays under MERGE_MAX_INTERIOR_AREA. The min cut over both
 *  seed regions reports the merged ring's exact cost, so "merge if it's worth
 *  it" is measured, not guessed. */
function collectMergeCandidates(
  solos: readonly EnclosureCandidate[],
  ctx: TargetContext,
): EnclosureCandidate[] {
  const { state, player } = ctx;
  // Personality gate: merging two towers into one big shared ring is an
  // AMBITIOUS, riskier play — it grabs more in one enclosure but loses both to
  // a single breach (compartmentalization). It's marginally suboptimal on
  // average (measured neutral-to-slightly-negative), so it's reserved as a
  // CHARACTER trait of the aggressive archetype (castleMargin 3 ⇔
  // aggressiveness ≥ 3), not applied to every AI. The closeability gates below
  // keep it from ever self-destructing. Like bankHugging / caresAboutHouses,
  // this is a playstyle flavour, not a strength optimisation.
  if (ctx.castleMargin < 3) return [];
  const homeIndex = ctx.castle.tower.index;
  // Only solo alive non-home towers are merge-eligible.
  const eligible = solos.filter(
    (cand) =>
      cand.towers[0]!.index !== homeIndex &&
      state.towerAlive[cand.towers[0]!.index],
  );
  const merges: EnclosureCandidate[] = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const first = eligible[i]!;
      const second = eligible[j]!;
      const towerA = first.towers[0]!;
      const towerB = second.towers[0]!;
      const apart = manhattanDistance(
        towerA.row,
        towerA.col,
        towerB.row,
        towerB.col,
      );
      if (apart > MERGE_MAX_DISTANCE) continue;
      const mergeRect = unionRect(first.rect, second.rect);
      if (rectArea(mergeRect) > MERGE_MAX_INTERIOR_AREA) continue;
      const cut = findEnclosureCut(
        [
          { tower: towerA, interior: first.rect },
          { tower: towerB, interior: second.rect },
        ],
        state,
        player.walls,
        ctx.placementCtx.allowPitOverlap,
      );
      if (cut === null || cut.size === 0) continue;
      // Closeability cap: a merged ring needing more than a build phase's worth
      // of new walls is an unclosable target — reject regardless of any nominal
      // wall-saving vs two (also-large) separate rings.
      if (cut.size > MERGE_MAX_GAPS) continue;
      // Reasonable only when the shared ring is meaningfully cheaper than two
      // separate rings — otherwise keep them compartmentalized.
      if (cut.size > first.gaps.size + second.gaps.size - MERGE_MIN_WALL_SAVING)
        continue;
      merges.push(
        makeCandidate([towerA, towerB], cut, mergeRect, homeIndex, state),
      );
    }
  }
  return merges;
}

/** Assemble an enclosure candidate: priority class from the goal hierarchy
 *  (alive home > any alive > dead-only) and value = per-tower worth minus the
 *  cut's wall cost. */
function makeCandidate(
  towers: Tower[],
  gaps: Set<TileKey>,
  rect: TileRect,
  homeIndex: TowerIdx,
  state: BuildViewState,
): EnclosureCandidate {
  let alive = 0;
  let dead = 0;
  let hasAliveHome = false;
  for (const tower of towers) {
    if (state.towerAlive[tower.index]) {
      alive++;
      if (tower.index === homeIndex) hasAliveHome = true;
    } else {
      dead++;
    }
  }
  const priority = hasAliveHome ? 3 : alive > 0 ? 2 : 1;
  const value =
    alive * CANDIDATE_VALUE_PER_ALIVE +
    dead * CANDIDATE_VALUE_PER_DEAD -
    gaps.size * CANDIDATE_VALUE_PER_WALL;
  return { towers, gaps, rect, priority, value };
}

/** Smallest rect covering both inputs. */
function unionRect(first: TileRect, second: TileRect): TileRect {
  return {
    top: Math.min(first.top, second.top),
    bottom: Math.max(first.bottom, second.bottom),
    left: Math.min(first.left, second.left),
    right: Math.max(first.right, second.right),
  };
}

/** Tile area of a rect's interior bounds. */
function rectArea(rect: TileRect): number {
  return (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1);
}

/** Min-cut target for a single tower when the current piece can close one of
 *  its gaps — backs the planner's persistence short-circuit. null when the
 *  tower is already enclosed / unenclosable / too breached / not piece-feasible
 *  this tick. */
function tryCloseableTowerTarget(
  tower: Tower,
  ctx: TargetContext,
): TargetResult | null {
  const { rect, cut } = soloEnclosure(tower, ctx);
  if (cut === null || cut.size === 0 || cut.size > MANAGEABLE_GAP_LIMIT)
    return null;
  if (!canFillAfterPlugging(ctx, cut, rect)) return null;
  return {
    targetGaps: cut,
    targetRect: rect,
    chosenTowerIndex: ctx.state.towerAlive[tower.index]
      ? tower.index
      : undefined,
  };
}

/** Bridge from selectTarget's per-branch context to the diag module's typed
 *  emit helper. Computes upcoming-piece fit + per-tower alternatives snapshot
 *  when a diag hook is active — both are read-only bag peeks that never
 *  trigger a refill (would advance state.rng). */
function emitTargetSelected(
  ctx: TargetContext,
  path: SelectTargetPath,
  result: TargetResult,
): void {
  const hookActive = isAiBuildDiagHookActive();
  const { upcomingPieces, upcomingPieceFitsTarget } = hookActive
    ? collectUpcomingPieceFit(ctx, result)
    : EMPTY_UPCOMING_FIT;
  const alternatives: readonly TargetAlternative[] = hookActive
    ? collectAlternatives(ctx)
    : [];
  emitTargetSelectedDiag(
    ctx.playerId,
    ctx.state.round,
    path,
    result.targetRect,
    result.targetGaps,
    result.chosenTowerIndex,
    upcomingPieces,
    upcomingPieceFitsTarget,
    alternatives,
    ctx.piece.name,
  );
}

/** Snapshot every secondary-tower candidate the AI could have committed to
 *  this tick — for each, compute (score, gapCount, bagFit). Mirrors the
 *  planner's candidate enumeration so the runner can compare the chosen tower
 *  against alternatives. Test-only: only invoked when a diag hook is
 *  installed. */
function collectAlternatives(ctx: TargetContext): TargetAlternative[] {
  const { state, player, castleMargin, bankHugging } = ctx;
  const candidatePool = getBuildTowerPool(ctx);
  if (candidatePool.length === 0) return [];
  const { row: currentRow, col: currentCol } = currentCursorAnchor(ctx);
  const bag = player.bag;
  const interior = getInterior(player);
  const peekCount =
    bag && bag.queue.length > 0
      ? Math.min(UPCOMING_PIECE_LOOKAHEAD, bag.queue.length)
      : 0;
  const upcomingPiecesArr =
    peekCount > 0 && bag
      ? Array.from(
          { length: peekCount },
          (_, i) => bag.queue[bag.queue.length - 1 - i]!,
        )
      : [];
  const alternatives: TargetAlternative[] = [];
  for (const tower of candidatePool) {
    const scored = scoreBuildTowerTarget(
      tower,
      state,
      player,
      currentRow,
      currentCol,
      castleMargin,
      bankHugging,
    );
    const { rect, gaps } = evaluateTowerCandidate(tower, ctx);
    let bagFit = -1;
    if (gaps.size > 0 && upcomingPiecesArr.length > 0) {
      const adjusted = adjustInterior(interior, gaps, rect);
      let fit = 0;
      for (const piece of upcomingPiecesArr) {
        if (
          canAnyRotationFillGap(
            [piece],
            gaps,
            adjusted,
            ctx.state,
            ctx.playerId,
            ctx.cache,
            ctx.placementCtx,
          )
        ) {
          fit++;
        }
      }
      bagFit = fit;
    }
    alternatives.push({
      towerIdx: tower.index,
      score: scored.score,
      gapCount: gaps.size,
      bagFit,
      bagFitDenom: upcomingPiecesArr.length,
    });
  }
  alternatives.sort((a, b) => b.score - a.score);
  return alternatives;
}

/** Peek the next UPCOMING_PIECE_LOOKAHEAD pieces from the AI's bag queue
 *  without mutating it, and check whether each can fill at least one cell
 *  of the chosen target. Returns parallel arrays. When the queue has fewer
 *  pieces left than the lookahead window, the arrays are shorter — never
 *  triggers a refill (which would advance state.rng and break determinism).
 *  When the target is null or empty, returns empty arrays. */
function collectUpcomingPieceFit(
  ctx: TargetContext,
  result: TargetResult,
): {
  upcomingPieces: readonly string[];
  upcomingPieceFitsTarget: readonly boolean[];
} {
  const bag = ctx.player.bag;
  if (!bag || bag.queue.length === 0) return EMPTY_UPCOMING_FIT;
  if (result.targetGaps.size === 0) return EMPTY_UPCOMING_FIT;
  const peekCount = Math.min(UPCOMING_PIECE_LOOKAHEAD, bag.queue.length);
  const pieces: string[] = [];
  const fits: boolean[] = [];
  const interior = getInterior(ctx.player);
  const adjusted = adjustInterior(
    interior,
    result.targetGaps,
    result.targetRect,
  );
  for (let i = 0; i < peekCount; i++) {
    const piece = bag.queue[bag.queue.length - 1 - i]!;
    pieces.push(piece.name);
    fits.push(
      canAnyRotationFillGap(
        [piece],
        result.targetGaps,
        adjusted,
        ctx.state,
        ctx.playerId,
        ctx.cache,
        ctx.placementCtx,
      ),
    );
  }
  return { upcomingPieces: pieces, upcomingPieceFitsTarget: fits };
}

/** Strategic fallback when every selectTarget phase bailed. Returns the home
 *  castle rect with its raw gap set (or the top-scored secondary's rect if
 *  home is being skipped). Bypasses the `canFillAfterPlugging` gate — that
 *  gate is per-tick optimization, not strategic gating. */
function strategicFallbackTarget(ctx: TargetContext): TargetResult {
  const { state, player, castle, castleMargin, bankHugging } = ctx;
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
  const candidatePool = getBuildTowerPool(ctx);
  if (candidatePool.length === 0) return NO_TARGET;
  const { row: currentRow, col: currentCol } = currentCursorAnchor(ctx);
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

/** Towers eligible to be a secondary build target this tick. When the home
 *  ring is being deprioritized (`effectiveSkipHome`), the home tower itself
 *  drops out of consideration. Shared by `planEnclosureTarget`,
 *  `strategicFallbackTarget`, and `collectAlternatives` — single accessor
 *  keeps them in lockstep. */
function getBuildTowerPool(ctx: TargetContext): readonly Tower[] {
  return ctx.effectiveSkipHome ? ctx.otherUnenclosed : ctx.unenclosedTowers;
}

/** Anchor for distance-from-cursor scoring: the AI's last cursor position
 *  this tick, falling back to the home tower's top-left when there's no
 *  cursor yet (first-tick of a build phase). */
function currentCursorAnchor(ctx: TargetContext): {
  row: number;
  col: number;
} {
  return {
    row: ctx.cursorPos?.row ?? ctx.castle.tower.row,
    col: ctx.cursorPos?.col ?? ctx.castle.tower.col,
  };
}

/** Build the canonical (rect, gaps) tuple the AI uses to evaluate a candidate
 *  tower: ideal castleRect → expanded around blockers → compute fillable gaps.
 *  Used by collectAlternatives' diag mirror to stay aligned with the planner's
 *  real candidate path, avoiding the "diag drifts from real path" hazard. */
function evaluateTowerCandidate(
  tower: Tower,
  ctx: TargetContext,
): { rect: TileRect; gaps: Set<TileKey> } {
  const rect = candidateRect(tower, ctx);
  const gaps = computeFillableGaps(
    rect,
    ctx.player.walls,
    getInterior(ctx.player),
    ctx.state,
    ctx.bankHugging,
  );
  return { rect, gaps };
}

/** Min cut enclosing one tower, with a rescue for border-reaching uncuttable
 *  channels. Tries the full candidate rect first; if it's unenclosable (`null` —
 *  a water / pit / house / cannon / tower channel pierces the protected interior
 *  out to the zone edge), retries with the interior clamped to seal on the near,
 *  wallable side of that channel. Returns the rect actually used so the caller
 *  stores the matching interior. A `null` cut (still unenclosable after the
 *  clamp) or an empty cut (already enclosed) passes through unchanged.
 *
 *  Without this the planner sees only the expanded rect, which `expandRect-
 *  AroundBlockers` can grow over a deep pit/water column reaching the map edge;
 *  the whole-rect cut is then `null` and the tower is wrongly abandoned even
 *  though a tighter ring sealing above the channel encloses it (seed
 *  round-pits-1: BLUE's home over a bottom-edge pit column). */
function soloEnclosure(
  tower: Tower,
  ctx: TargetContext,
): { rect: TileRect; cut: Set<TileKey> | null } {
  const allowPit = ctx.placementCtx.allowPitOverlap;
  const rect = candidateRect(tower, ctx);
  const cut = findEnclosureCut(
    [{ tower, interior: rect }],
    ctx.state,
    ctx.player.walls,
    allowPit,
  );
  if (cut !== null) return { rect, cut };
  const clamped = clampRectOffUnwallable(rect, tower, ctx.state, allowPit);
  const reCut = findEnclosureCut(
    [{ tower, interior: clamped }],
    ctx.state,
    ctx.player.walls,
    allowPit,
  );
  return reCut === null ? { rect, cut } : { rect: clamped, cut: reCut };
}

/** Per-tower castle interior rect: margin-based `castleRect`, optionally
 *  snapped to reuse an adjacent wall when home is being abandoned, then
 *  expanded around temporary blockers. Used as both the protected interior
 *  the min cut wraps around and the rect downstream scoring consumes. */
function candidateRect(tower: Tower, ctx: TargetContext): TileRect {
  const { state, player, castleMargin, bankHugging } = ctx;
  const base = castleRect(
    tower,
    state.map.tiles,
    state.map.towers,
    castleMargin,
    !bankHugging,
  );
  // Reuse an adjacent existing wall as a shared boundary in two cases:
  //  - a secondary ring being abandoned for (effectiveSkipHome) — enclosing
  //    that tower is survival-critical and a tight, closeable ring beats a
  //    roomier one;
  //  - ALWAYS for the home tower — the round-1 prebuilt castle (and the
  //    player's own ring in later rounds) already traces a ring; snapping the
  //    margin rect onto it reuses those walls instead of building a concentric
  //    ring one tile out (which strands the standing walls as interior and
  //    wastes pieces). The snap is coverage-driven: it only pulls a side in
  //    where the existing walls have more coverage, so it keeps a roomier ring
  //    when the walls already trace one.
  const isHome = tower.index === ctx.castle.tower.index;
  const reused =
    ctx.effectiveSkipHome || isHome
      ? snapRectToReuseWalls(base, player.walls, tower)
      : base;
  return expandRectAroundBlockers(reused, state, player);
}

/** Expand a castle rect outward to route around temporary blockers (grunts,
 *  burning pits, alive houses) on the wall ring. Only grows along directions
 *  that have a blocker on the ring; water/permanent terrain doesn't trigger.
 *  Applied via `candidateRect` to every planner candidate (home and
 *  secondaries) so each gets the Mode #4 escape. */
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
  // candidates per tick. Mirrors the gate the planner applies per candidate.
  if (gaps.size <= MANAGEABLE_GAP_LIMIT) {
    if (!canFillAfterPlugging(ctx, gaps, expandRect)) return NO_TARGET;
  }
  return { targetGaps: gaps, targetRect: expandRect };
}

/** Phase 4 (idle window): all towers enclosed AND uniform expansion found
 *  nothing this tick — wall a small pocket around the highest-VALUE static
 *  anchor (alive house or un-captured bonus square) in the player's own zone.
 *  Each capture fires at end-of-build via recheckTerritory: a bonus square
 *  scores territoryBonusSquarePoints (100–1000), a grunt caught inside scores
 *  DESTROY_GRUNT_POINTS + removes a threat, a house spawns a grunt on every
 *  enemy's zone. Grunts are NOT anchors — they pace during the build, so
 *  chasing one thrashes (the pocket recenters every tick and never closes,
 *  seed 829597 r28). Instead they're counted as bonus value when they sit
 *  inside a static anchor's pocket, so the AI prefers pockets that scoop up
 *  grunts as a byproduct. Among the nearest CAPTURE_SCAN_LIMIT anchors whose
 *  pocket is closeable this tick (≤ MANAGEABLE_GAP_LIMIT gaps + current piece
 *  fits — fully gated, never bypassed), the richest pocket wins. */
function tryEncloseCaptures(ctx: TargetContext): TargetResult {
  const { state, player, castle, bankHugging, allCastlesEnclosed } = ctx;
  if (!allCastlesEnclosed) return NO_TARGET;
  const bbox = computeWallsBBox(player.walls);
  if (bbox === null) return NO_TARGET;
  const interior = getInterior(player);
  const homeZone = castle.tower.zone;

  // Static anchors only — houses and bonus squares hold still while the pocket
  // closes. Skip any already captured (inside the interior). Zone isolation
  // (rivers) means a cross-zone anchor can never be sealed by these walls.
  const anchors: TilePos[] = [];
  for (const house of state.map.houses) {
    if (!house.alive || house.zone !== homeZone) continue;
    if (interior.has(packTile(house.row, house.col))) continue;
    anchors.push(house);
  }
  for (const bonus of state.bonusSquares) {
    if (bonus.zone !== homeZone) continue;
    if (interior.has(packTile(bonus.row, bonus.col))) continue;
    anchors.push(bonus);
  }
  if (anchors.length === 0) return NO_TARGET;

  const nearest = anchors
    .map((anchor) => ({
      anchor,
      dist:
        rectAxisGap(anchor.row, bbox.minR, bbox.maxR) +
        rectAxisGap(anchor.col, bbox.minC, bbox.maxC),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, CAPTURE_SCAN_LIMIT);

  let best: { gaps: Set<TileKey>; rect: TileRect; value: number } | undefined;
  for (const { anchor } of nearest) {
    // Small local box centred on the anchor — its 1-tile ring leans on the
    // adjacent existing wall, so only the open side(s) become gaps. NOT a bbox
    // regrow: a large territory would need its whole perimeter rebuilt to reach
    // the anchor, blowing past the gap limit (seed 829597 r28 RED).
    const pocketRect: TileRect = {
      top: Math.max(1, anchor.row - CAPTURE_POCKET_RADIUS),
      bottom: Math.min(GRID_ROWS - 2, anchor.row + CAPTURE_POCKET_RADIUS),
      left: Math.max(1, anchor.col - CAPTURE_POCKET_RADIUS),
      right: Math.min(GRID_COLS - 2, anchor.col + CAPTURE_POCKET_RADIUS),
    };
    if (
      pocketRect.top > pocketRect.bottom ||
      pocketRect.left > pocketRect.right
    )
      continue;
    const gaps = computeFillableGaps(
      pocketRect,
      player.walls,
      interior,
      state,
      bankHugging,
    );
    if (gaps.size === 0 || gaps.size > MANAGEABLE_GAP_LIMIT) continue;
    if (!canFillAfterPlugging(ctx, gaps, pocketRect)) continue;
    const value = pocketCaptureValue(pocketRect, state, homeZone);
    if (best === undefined || value > best.value) {
      best = { gaps, rect: pocketRect, value };
    }
  }
  if (best === undefined) return NO_TARGET;
  return { targetGaps: best.gaps, targetRect: best.rect };
}

/** Weighted value of everything a sealed pocket would capture: alive houses +
 *  un-captured bonus squares + grunts currently sitting in its interior box.
 *  Grunts are an estimate (they may pace out before the seal), so they only
 *  break ties toward grunt-rich pockets rather than driving the choice. */
function pocketCaptureValue(
  rect: TileRect,
  state: BuildViewState,
  homeZone: number,
): number {
  let value = 0;
  for (const house of state.map.houses) {
    if (!house.alive || house.zone !== homeZone) continue;
    if (inRect(rect, house.row, house.col)) value += CAPTURE_VALUE_HOUSE;
  }
  for (const bonus of state.bonusSquares) {
    if (bonus.zone !== homeZone) continue;
    if (inRect(rect, bonus.row, bonus.col)) value += CAPTURE_VALUE_BONUS;
  }
  for (const grunt of state.grunts) {
    if (inRect(rect, grunt.row, grunt.col)) value += CAPTURE_VALUE_GRUNT;
  }
  return value;
}

/** Whether (row, col) lies inside the rect's interior box (inclusive). */
function inRect(rect: TileRect, row: number, col: number): boolean {
  return (
    row >= rect.top &&
    row <= rect.bottom &&
    col >= rect.left &&
    col <= rect.right
  );
}

/** Distance from a coordinate to the [low, high] band on one axis (0 when
 *  inside). Summed over both axes gives the Manhattan gap from a point to a
 *  bounding box. */
function rectAxisGap(value: number, low: number, high: number): number {
  if (value < low) return low - value;
  if (value > high) return value - high;
  return 0;
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
