/**
 * AI build-phase diagnostic hook — test-only instrumentation surface.
 * Two event kinds: `target-selected` (path + rect + bag-fit lookahead) and
 * `wall-placed` (per-placement gap-hit/adj/iso classification + on-ring
 * perimeter count). The hook is installed by the survival-suite runner and
 * by single-stall trace scripts; production callers pay one branch.
 */

import type { TileRect, TowerIdx } from "../shared/core/geometry-types.ts";
import type { TileKey } from "../shared/core/grid.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";

export type SelectTargetPath =
  | "HOME"
  | "SEC"
  | "EXP"
  | "STRAT_RECT"
  | "STRAT_NONE";

/** Snapshot of one secondary-tower candidate the AI considered this tick.
 *  Captured even for towers the score loop never reached (bag-fit alone can
 *  surface "candidate Y would have closed but chosen X couldn't"). The runner
 *  correlates this against `chosenTowerIndex` to surface the
 *  "wrong rect selected" failure class. */
export interface TargetAlternative {
  towerIdx: TowerIdx;
  /** scoreBuildTowerTarget result for this tower at decision time. Higher
   *  = stronger AI preference. */
  score: number;
  /** Fillable gaps on the expanded rect after `expandRectAroundBlockers` +
   *  `computeFillableGaps`. -1 when not computed (rect collapsed or tower
   *  geometry invalid). */
  gapCount: number;
  /** Count of upcoming bag pieces that could fill ≥1 gap on this rect (any
   *  rotation). -1 when gapCount === 0 or bag queue empty. */
  bagFit: number;
  /** Total upcoming pieces peeked when computing `bagFit` — denominator
   *  for the fit ratio. 0 implies bagFit is meaningless. */
  bagFitDenom: number;
}

type AiBuildDiagEvent =
  | {
      kind: "target-selected";
      playerId: ValidPlayerId;
      round: number;
      path: SelectTargetPath;
      targetRect: TileRect | null;
      targetGaps: ReadonlySet<TileKey>;
      chosenTowerIndex: TowerIdx | undefined;
      /** PieceShape.name for each of the next N pieces in the AI's bag
       *  queue (excluding the current piece). Read-only peek — never
       *  triggers a bag refill (would advance state.rng and break
       *  determinism). Variable length: empty when queue has fewer than
       *  one piece left; capped at N=3 by the diag emit site. */
      upcomingPieces: readonly string[];
      /** For each `upcomingPieces[i]`, true iff at least one orientation
       *  could fill at least one of `targetGaps`. Pre-computed at the
       *  emit site (test-only, no production cost). The runner aggregates
       *  this as `bag-fit=X%` per stall — distinguishes "bag will solve
       *  this target" from "bag can't help current ring." */
      upcomingPieceFitsTarget: readonly boolean[];
      /** All secondary-tower candidates the AI could have committed to this
       *  tick, with per-candidate (score, gapCount, bagFit). Empty when no
       *  hook is installed (production), or when the path is HOME/EXP/
       *  STRAT_* (no candidate enumeration). Sorted by score descending so
       *  the AI's top-ranked alternative is first. */
      alternatives: readonly TargetAlternative[];
      currentPieceShapeName: string;
    }
  | {
      kind: "wall-placed";
      playerId: ValidPlayerId;
      round: number;
      cells: readonly TileKey[];
      targetGaps: ReadonlySet<TileKey>;
      targetRect: TileRect | null;
      /** Count of `cells` lying on `targetRect`'s wall-ring perimeter (the
       *  ring of cells at top-1, bottom+1, left-1, right+1 of the interior
       *  rect). 0 when `targetRect` is null. Distinguishes "wall extends
       *  the committed ring" from "wall lands wall-adjacent but off-ring"
       *  — the existing gap/adj/iso classification conflates them. */
      cellsOnRingPerimeter: number;
      /** Net interior this placement reclaimed — the scorer's own `usefulGain`
       *  (`rawGain − pieceTiles`, see computeCandidateEnv). The piece's own
       *  wall footprint flips outside→wall and would inflate a raw
       *  outside-delta, so the piece-tile subtraction leaves only
       *  genuinely-sealed interior. > 0 ⇒ the placement actually enclosed new
       *  territory; ≤ 0 ⇒ no net interior gained (doubled / dead wall), even
       *  if it filled no ring gap. Lets the build-trace match what the scorer
       *  calls useful instead of guessing off the perimeter-gap count.
       *  Computed only when a diag hook is installed (test-only); 0 on the
       *  production path. */
      usefulGain: number;
      pieceShapeName: string;
    }
  | {
      kind: "no-placement";
      playerId: ValidPlayerId;
      round: number;
      /** Short label for why pickPlacement returned without a placement
       *  this tick. Pairs with the immediately-preceding `target-selected`
       *  event (when a target was picked) to attribute the failure to
       *  that target's rect/gap geometry. */
      reason: NoPlacementReason;
      /** Optional finer-grained cause, free-form. For `no-candidates` it's a
       *  `cause×count,…` breakdown of what occupies the unfilled gap tiles
       *  (e.g. `pit×2` = gap blocked by burning pits, unfillable by any piece;
       *  `open×3` = gap is buildable, the current piece just couldn't reach
       *  it). Computed only when a diag hook is installed, so it never costs
       *  the production path. */
      detail?: string;
    }
  | {
      kind: "desperate-fired";
      playerId: ValidPlayerId;
      round: number;
      /** Anchor of the chosen interior-discard placement. Pieces always
       *  land entirely inside the player's flooded interior (closed
       *  enclosure) — the discard advances the bag without affecting any
       *  open ring. */
      row: number;
      col: number;
      pieceShapeName: string;
    };

/** Why pickPlacement returned null this tick. Closed union so the
 *  build-trace observer's histogram stays exhaustive and a new failure
 *  path is a compile error. */
export type NoPlacementReason =
  | "eliminated-no-walls"
  | "eliminated-no-tower"
  | "no-placement-context"
  | "no-candidates"
  | "scored-empty-no-targets"
  | "unevaluated-no-targets"
  | "low-score-no-targets"
  | "fallback-interior-full"
  | "fallback-discard-all-fat"
  | "fallback-extend-all-fat"
  | "fallback-unknown";

export type AiBuildDiagHook = (event: AiBuildDiagEvent) => void;

let diagHook: AiBuildDiagHook | undefined = undefined;

export function setAiBuildDiagHook(hook: AiBuildDiagHook | undefined): void {
  diagHook = hook;
}

/** Returns whether a diag hook is installed. Callers gate diag-only
 *  computations (e.g. upcoming-piece-fit peek) behind this to avoid
 *  production cost when nobody listens. */
export function isAiBuildDiagHookActive(): boolean {
  return diagHook !== undefined;
}

/** Emit a wall-placed event. The event carries the active targetGaps +
 *  targetRect at the moment the AI chose this placement, so the runner can
 *  classify the placement as gap-hit / wall-adjacent / isolated. Bus
 *  WALL_PLACED already fires for every placement but doesn't carry AI-internal
 *  context — that distinction lets the bus stay observation-only per
 *  feedback_bus_observation_only. */
export function emitWallPlacedDiag(
  playerId: ValidPlayerId,
  round: number,
  cells: readonly TileKey[],
  targetGaps: ReadonlySet<TileKey>,
  targetRect: TileRect | null,
  cellsOnRingPerimeter: number,
  usefulGain: number,
  pieceShapeName: string,
): void {
  if (!diagHook) return;
  diagHook({
    kind: "wall-placed",
    playerId,
    round,
    cells,
    targetGaps,
    targetRect,
    cellsOnRingPerimeter,
    usefulGain,
    pieceShapeName,
  });
}

/** Emit a no-placement event. Fires once per tick when pickPlacement
 *  returns without a placement, so the build-trace observer can replace
 *  its previous "reason not emitted" placeholder with an actual cause
 *  bucket. Pair with the immediately-preceding `target-selected` event
 *  (when a target was picked) to attribute the failure to the rect. */
export function emitNoPlacementDiag(
  playerId: ValidPlayerId,
  round: number,
  reason: NoPlacementReason,
  detail?: string,
): void {
  if (!diagHook) return;
  diagHook({
    kind: "no-placement",
    playerId,
    round,
    reason,
    detail,
  });
}

/** Emit a desperate-fired event. Fires once per tick when the last-resort
 *  interior-discard fallback (see ai-build-desperate.ts) succeeds — the
 *  player had zero enclosed alive towers AND every exterior path returned
 *  null AND some bag-pool piece could still close a future ring. Lets
 *  diag consumers identify games where the fallback materially changed
 *  AI behavior (e.g. survival-suite per-seed log attribution). */
export function emitDesperateFiredDiag(
  playerId: ValidPlayerId,
  round: number,
  row: number,
  col: number,
  pieceShapeName: string,
): void {
  if (!diagHook) return;
  diagHook({
    kind: "desperate-fired",
    playerId,
    round,
    row,
    col,
    pieceShapeName,
  });
}

/** Emit a target-selected event. Constructs the event object only when a
 *  hook is installed — production callers pay one branch and no allocation. */
export function emitTargetSelectedDiag(
  playerId: ValidPlayerId,
  round: number,
  path: SelectTargetPath,
  targetRect: TileRect | null,
  targetGaps: ReadonlySet<TileKey>,
  chosenTowerIndex: TowerIdx | undefined,
  upcomingPieces: readonly string[],
  upcomingPieceFitsTarget: readonly boolean[],
  alternatives: readonly TargetAlternative[],
  pieceShapeName: string,
): void {
  if (!diagHook) return;
  diagHook({
    kind: "target-selected",
    playerId,
    round,
    path,
    targetRect,
    targetGaps,
    chosenTowerIndex,
    upcomingPieces,
    upcomingPieceFitsTarget,
    alternatives,
    currentPieceShapeName: pieceShapeName,
  });
}
