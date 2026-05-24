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
      pieceShapeName: string;
    };

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
    currentPieceShapeName: pieceShapeName,
  });
}
