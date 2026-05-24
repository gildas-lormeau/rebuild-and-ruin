/**
 * AI build-phase diagnostic hook — test-only instrumentation surface.
 * See docs/superpowers/specs/2026-05-24-ai-build-phase-diagnostics-design.md
 * for the three diagnostic angles and the production-cost contract.
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

/** Per-tick record of which gates fired inside the selectTarget pipeline.
 *  Sub-helpers push to an optional accumulator threaded through; selectTarget
 *  attaches the accumulated list to the target-selected event. Runner groups
 *  these into GateFireCounts to surface which architectural lever is binding
 *  for each stall sub-mode. */
export type GateReason =
  | { gate: "canPieceFillAnyGap"; passed: boolean; site: "home" | "expand" }
  | {
      gate: "canFillAfterPlugging";
      passed: boolean;
      site: "home" | "sec" | "expand";
      towerIdx?: TowerIdx;
    }
  | {
      gate: "manageableGapLimitBypass";
      site: "sec";
      gapCount: number;
      towerIdx: TowerIdx;
    }
  | {
      gate: "effectiveSkipHome";
      reason: "home-dead" | "home-enclosed" | "home-gap-overflow";
    }
  | {
      gate: "strategicFallbackInvoked";
      resultPath: "STRAT_RECT" | "STRAT_NONE";
    };

type AiBuildDiagEvent =
  | {
      kind: "target-selected";
      playerId: ValidPlayerId;
      round: number;
      path: SelectTargetPath;
      targetRect: TileRect | null;
      targetGaps: ReadonlySet<TileKey>;
      chosenTowerIndex: TowerIdx | undefined;
      gateReasons: readonly GateReason[];
      currentPieceShapeName: string;
    }
  | {
      kind: "wall-placed";
      playerId: ValidPlayerId;
      round: number;
      cells: readonly TileKey[];
      targetGaps: ReadonlySet<TileKey>;
      targetRect: TileRect | null;
      pieceShapeName: string;
    }
  | {
      kind: "build-phase-end";
      playerId: ValidPlayerId;
      round: number;
      finalRect: TileRect | null;
      finalGaps: ReadonlySet<TileKey>;
    };

export type AiBuildDiagHook = (event: AiBuildDiagEvent) => void;

let diagHook: AiBuildDiagHook | undefined = undefined;

export function setAiBuildDiagHook(hook: AiBuildDiagHook | undefined): void {
  diagHook = hook;
}

/** Returns whether a diag hook is installed. Callers gate accumulator-array
 *  allocation behind this to avoid production cost when nobody listens. */
export function isAiBuildDiagHookActive(): boolean {
  return diagHook !== undefined;
}

/** Emit a build-phase-end event. Carries the AI's last computed target
 *  (rect + gap set) so the runner can run piece-shape coverage analysis
 *  against the un-closed gaps at end of phase. Fires once per player per
 *  WALL_BUILD phase from assessBuildEnd. */
export function emitBuildPhaseEndDiag(
  playerId: ValidPlayerId,
  round: number,
  finalRect: TileRect | null,
  finalGaps: ReadonlySet<TileKey>,
): void {
  if (!diagHook) return;
  diagHook({
    kind: "build-phase-end",
    playerId,
    round,
    finalRect,
    finalGaps,
  });
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
  gateReasons: readonly GateReason[],
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
    gateReasons,
    currentPieceShapeName: pieceShapeName,
  });
}
