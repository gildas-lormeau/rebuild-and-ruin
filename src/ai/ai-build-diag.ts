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
 *  Internal for commit 1 — exported once commit 2 plumbs values from the
 *  sub-helpers and ai-build-target.ts needs to construct GateReason values. */
type GateReason =
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

/** Emit a target-selected event. Constructs the event object only when a
 *  hook is installed — production callers pay one branch and no allocation.
 *  gateReasons stays empty until commit 2 wires the sub-helper accumulator. */
export function emitTargetSelectedDiag(
  playerId: ValidPlayerId,
  round: number,
  path: SelectTargetPath,
  targetRect: TileRect | null,
  targetGaps: ReadonlySet<TileKey>,
  chosenTowerIndex: TowerIdx | undefined,
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
    gateReasons: [],
    currentPieceShapeName: pieceShapeName,
  });
}
