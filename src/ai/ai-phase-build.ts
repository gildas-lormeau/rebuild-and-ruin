/**
 * AI build-phase state machine — piece placement with cursor animation
 * and concurrent rotation.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { canPlacePiece } from "../game/index.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "../shared/core/grid.ts";
import { type PieceShape, rotateCW, sameShape } from "../shared/core/pieces.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { towerCenterTile } from "../shared/core/spatial.ts";
import type {
  PiecePlacementPreview,
  PlacePieceIntent,
} from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { STEP, secondsToTicks } from "./ai-constants.ts";
import type { AiStrategy } from "./ai-strategy.ts";

/** Subset of AiController accessed by build-phase logic.
 *  Exported so controller-ai.ts can statically assert AiController implements
 *  every phase's Host (see the `satisfies` check at the bottom of that file). */
export interface BuildHost {
  readonly playerId: ValidPlayerSlot;
  readonly strategy: AiStrategy;
  buildCursor: TilePos;
  readonly buildCursorSpeed: number;
  readonly boostThreshold: number;
  /** Returns `(base + rng * spread) * delayScale` — humanizes AI timing per difficulty. */
  scaledDelay(base: number, spread: number): number;
  clampBuildCursor(piece: PieceShape | undefined): void;
  stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
  ): boolean;
}

type BuildTarget = { piece: PieceShape } & TilePos;

type BuildRotation = { seq: PieceShape[]; idx: number; timer: number };

type BuildState =
  | { step: "idle" }
  | { step: "thinking"; timer: number }
  | { step: "moving"; target: BuildTarget; rotation: BuildRotation }
  | {
      step: "dwelling";
      target: BuildTarget;
      timer: number;
      hasRetried: boolean;
    }
  | { step: "gave_up"; retryTimer: number };

interface BuildPhase {
  state: BuildState;
}

/** Base delay per rotation animation frame (ticks). */
const ROTATION_FRAME_BASE = secondsToTicks(0.12);
/** Random variation added to each rotation frame delay (ticks). */
const ROTATION_FRAME_RANGE = secondsToTicks(0.08);
/** Base delay before the first rotation frame starts (ticks). */
const ROTATION_INITIAL_BASE = secondsToTicks(0.15);
/** Random variation added to the initial rotation delay (ticks). */
const ROTATION_INITIAL_RANGE = secondsToTicks(0.1);
/** Pause after placing a piece before thinking about the next one. */
const POST_PLACE_DELAY_SEC = 0.3;
const POST_PLACE_SPREAD_SEC = 0.4;
/** Pause on target tile before attempting placement. */
const PRE_PLACE_DELAY_SEC = 0.2;
const PRE_PLACE_SPREAD_SEC = 0.3;
/** Wait time when placement is blocked and retrying (ticks). */
const BLOCKED_RETRY_DELAY = secondsToTicks(1.0);
/** Minimum re-think delay after a blocked retry (ticks). */
const QUICK_RETHINK_DELAY = secondsToTicks(0.1);
/** AI build-phase cursor speed in tiles per second, indexed by cursorSkill-1
 *  (skill 1→[0], 2→[1], 3→[2]).
 *  Reduced from [8,12,14] to compensate for Manhattan movement being faster
 *  than the old diagonal (Euclidean) movement on non-axis-aligned paths. */
export const BUILD_CURSOR_SPEEDS = [5, 8, 10] as const;

export function createBuildPhase(): BuildPhase {
  return { state: { step: STEP.IDLE } };
}

export function resetBuildPhase(phase: BuildPhase): void {
  phase.state = { step: STEP.IDLE };
}

/** Compute the first placement target and enter MOVING or THINKING state. */
export function initBuild(
  host: BuildHost,
  phase: BuildPhase,
  state: GameState,
): void {
  const target = computeNextPlacement(host, state);
  if (target) {
    phase.state = {
      step: STEP.MOVING,
      target,
      rotation: buildRotationFor(host, state, target),
    };
  } else {
    phase.state = { step: STEP.THINKING, timer: 0 };
  }
}

export function finalizeBuild(
  host: BuildHost,
  phase: BuildPhase,
  state: GameState,
): void {
  phase.state = { step: STEP.IDLE };
  host.strategy.assessBuildEnd(state, host.playerId);
}

export function tickBuild(
  host: BuildHost,
  phase: BuildPhase,
  state: GameState,
  executePlace: (intent: PlacePieceIntent) => boolean,
): PiecePlacementPreview[] {
  const currentPiece = state.players[host.playerId]?.currentPiece;
  if (!currentPiece) return [];

  // Clamp cursor so phantom never extends beyond the grid
  const clampPiece =
    phase.state.step === STEP.MOVING || phase.state.step === STEP.DWELLING
      ? phase.state.target.piece
      : currentPiece;
  host.clampBuildCursor(clampPiece);

  switch (phase.state.step) {
    case STEP.IDLE:
      return [];

    case STEP.THINKING: {
      const phaseState = phase.state;
      if (phaseState.timer > 0) {
        phaseState.timer--;
        return [phantomAtCursor(host, state)];
      }
      // Timer expired — compute next placement
      const target = computeNextPlacement(host, state);
      if (target) {
        phase.state = {
          step: STEP.MOVING,
          target,
          rotation: buildRotationFor(host, state, target),
        };
        return tickMoving(host, phase, state);
      }
      if (state.timer > 2) {
        phase.state = { step: STEP.THINKING, timer: secondsToTicks(1.0) };
      } else {
        phase.state = { step: STEP.GAVE_UP, retryTimer: secondsToTicks(1.0) };
      }
      return [phantomAtCursor(host, state)];
    }

    case STEP.GAVE_UP: {
      const phaseState = phase.state;
      const homeTower = state.players[host.playerId]?.homeTower;
      const home = homeTower ? towerCenterTile(homeTower) : host.buildCursor;
      host.stepTileCursorToward(
        host.buildCursor,
        home.row,
        home.col,
        host.buildCursorSpeed,
        Infinity,
      );
      phaseState.retryTimer--;
      if (phaseState.retryTimer <= 0) {
        const target = computeNextPlacement(host, state);
        if (target) {
          phase.state = {
            step: STEP.MOVING,
            target,
            rotation: buildRotationFor(host, state, target),
          };
        } else {
          phaseState.retryTimer = secondsToTicks(1.0);
        }
      }
      return [phantomAtCursor(host, state)];
    }

    case STEP.MOVING:
      return tickMoving(host, phase, state);

    case STEP.DWELLING: {
      const phaseState = phase.state;
      phaseState.timer--;
      if (phaseState.timer <= 0) {
        const placed = executePlace({
          playerId: host.playerId,
          piece: phaseState.target.piece,
          row: phaseState.target.row,
          col: phaseState.target.col,
        });
        if (placed) {
          phase.state = {
            step: STEP.THINKING,
            timer: host.scaledDelay(
              POST_PLACE_DELAY_SEC,
              POST_PLACE_SPREAD_SEC,
            ),
          };
          return [];
        }
        // Placement blocked (e.g. grunt moved onto target)
        if (!phaseState.hasRetried) {
          phaseState.hasRetried = true;
          phaseState.timer = BLOCKED_RETRY_DELAY;
        } else {
          phase.state = { step: STEP.THINKING, timer: QUICK_RETHINK_DELAY };
        }
        return [];
      }
      return [
        makePhantom(
          host.playerId,
          phaseState.target.piece,
          phaseState.target.row,
          phaseState.target.col,
          true,
        ),
      ];
    }
  }
}

/** Handle "moving toward target" state with concurrent rotation animation. */
function tickMoving(
  host: BuildHost,
  phase: BuildPhase,
  state: GameState,
): PiecePlacementPreview[] {
  const phaseState = phase.state as Extract<BuildState, { step: "moving" }>;
  const { target, rotation } = phaseState;

  // Tick rotation animation concurrently with movement
  if (rotation.idx < rotation.seq.length) {
    rotation.timer--;
    if (rotation.timer <= 0) {
      rotation.idx++;
      if (rotation.idx < rotation.seq.length) {
        rotation.timer =
          ROTATION_FRAME_BASE + host.strategy.rng.next() * ROTATION_FRAME_RANGE;
      }
    }
  }

  // Move cursor toward target
  const arrived = host.stepTileCursorToward(
    host.buildCursor,
    target.row,
    target.col,
    host.buildCursorSpeed,
    host.boostThreshold,
  );
  if (arrived && rotation.idx >= rotation.seq.length) {
    phase.state = {
      step: STEP.DWELLING,
      target,
      timer: host.scaledDelay(PRE_PLACE_DELAY_SEC, PRE_PLACE_SPREAD_SEC),
      hasRetried: false,
    };
  }

  // Show phantom at current cursor position — use current rotation frame
  const movingPiece =
    rotation.idx < rotation.seq.length
      ? rotation.seq[Math.min(rotation.idx, rotation.seq.length - 1)]!
      : target.piece;
  const pivotDr = target.piece.pivot[0] - movingPiece.pivot[0];
  const pivotDc = target.piece.pivot[1] - movingPiece.pivot[1];
  const curRow = Math.max(
    0,
    Math.min(
      Math.round(host.buildCursor.row) + pivotDr,
      GRID_ROWS - movingPiece.height,
    ),
  );
  const curCol = Math.max(
    0,
    Math.min(
      Math.round(host.buildCursor.col) + pivotDc,
      GRID_COLS - movingPiece.width,
    ),
  );
  return [
    makePhantom(
      host.playerId,
      movingPiece,
      curRow,
      curCol,
      canPlacePiece(state, host.playerId, movingPiece.offsets, curRow, curCol),
    ),
  ];
}

/** Build rotation animation sequence from current bag piece to target orientation. */
function buildRotationFor(
  host: BuildHost,
  state: GameState,
  target: BuildTarget,
): BuildRotation {
  const bag = state.players[host.playerId]!.currentPiece!;
  if (sameShape(bag, target.piece)) {
    return { seq: [], idx: 0, timer: 0 };
  }
  const seq: PieceShape[] = [bag];
  let cur = bag;
  for (let i = 0; i < 3; i++) {
    cur = rotateCW(cur);
    if (sameShape(cur, target.piece)) {
      seq.push(target.piece);
      break;
    }
    seq.push(cur);
  }
  return {
    seq,
    idx: 0,
    timer:
      ROTATION_INITIAL_BASE + host.strategy.rng.next() * ROTATION_INITIAL_RANGE,
  };
}

function phantomAtCursor(
  host: BuildHost,
  state: GameState,
): PiecePlacementPreview {
  const piece = state.players[host.playerId]!.currentPiece!;
  const row = Math.round(host.buildCursor.row);
  const col = Math.round(host.buildCursor.col);
  return makePhantom(
    host.playerId,
    piece,
    row,
    col,
    canPlacePiece(state, host.playerId, piece.offsets, row, col),
  );
}

function makePhantom(
  playerId: ValidPlayerSlot,
  shape: PieceShape,
  row: number,
  col: number,
  valid: boolean,
): PiecePlacementPreview {
  return { offsets: shape.offsets, row, col, valid, playerId };
}

function computeNextPlacement(
  host: BuildHost,
  state: GameState,
): BuildTarget | null {
  const currentPiece = state.players[host.playerId]?.currentPiece;
  if (!currentPiece) return null;
  const result = host.strategy.pickPlacement(
    state,
    host.playerId,
    currentPiece,
    {
      row: Math.round(host.buildCursor.row),
      col: Math.round(host.buildCursor.col),
    },
  );
  return result
    ? { piece: result.piece, row: result.row, col: result.col }
    : null;
}
