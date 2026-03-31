/**
 * AI build-phase state machine — piece placement with cursor animation
 * and concurrent rotation.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { STEP } from "./ai-constants.ts";
import type { AiStrategy } from "./ai-strategy.ts";
import { canPlacePiece, placePiece } from "./build-system.ts";
import type { PiecePlacementPreview } from "./controller-interfaces.ts";
import type { TilePos } from "./geometry-types.ts";
import { GRID_COLS, GRID_ROWS } from "./grid.ts";
import { type PieceShape, rotateCW } from "./pieces.ts";
import { towerCenter } from "./spatial.ts";
import { type GameState, isPlayerAlive } from "./types.ts";

/** Subset of AiController accessed by build-phase logic. */
interface BuildHost {
  readonly playerId: number;
  readonly strategy: AiStrategy;
  buildCursor: TilePos;
  currentPiece: PieceShape | null;
  readonly buildCursorSpeed: number;
  readonly boostThreshold: number;
  scaledDelay(base: number, spread: number): number;
  advanceBag(_placed: true): void;
  clampBuildCursor(piece: PieceShape | null): void;
  stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
    dt: number,
  ): boolean;
}

type BuildTarget = { piece: PieceShape } & TilePos;

type BuildRotation = { seq: PieceShape[]; idx: number; timer: number };

type BuildState =
  | { step: typeof STEP.IDLE }
  | { step: typeof STEP.THINKING; timer: number }
  | { step: typeof STEP.MOVING; target: BuildTarget; rotation: BuildRotation }
  | {
      step: typeof STEP.DWELLING;
      target: BuildTarget;
      timer: number;
      retried: boolean;
    }
  | { step: typeof STEP.GAVE_UP; retryTimer: number };

interface BuildPhase {
  state: BuildState;
}

/** Base delay (seconds) per rotation animation frame. */
const ROTATION_FRAME_BASE = 0.12;
/** Random variation added to each rotation frame delay. */
const ROTATION_FRAME_RANGE = 0.08;
/** Base delay (seconds) before the first rotation frame starts. */
const ROTATION_INITIAL_BASE = 0.15;
/** Random variation added to the initial rotation delay. */
const ROTATION_INITIAL_RANGE = 0.1;
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
  const player = state.players[host.playerId];
  if (!isPlayerAlive(player)) return;
  const target = computeNextPlacement(host, state);
  if (target) {
    phase.state = {
      step: STEP.MOVING,
      target,
      rotation: buildRotationFor(host, target),
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
  dt: number,
): PiecePlacementPreview[] {
  if (!host.currentPiece) return [];
  const player = state.players[host.playerId];
  if (!isPlayerAlive(player)) return [];

  // Clamp cursor so phantom never extends beyond the grid
  const clampPiece =
    phase.state.step === STEP.MOVING || phase.state.step === STEP.DWELLING
      ? phase.state.target.piece
      : host.currentPiece;
  host.clampBuildCursor(clampPiece);

  switch (phase.state.step) {
    case STEP.IDLE:
      return [];

    case STEP.THINKING: {
      const bs = phase.state;
      if (bs.timer > 0) {
        bs.timer -= dt;
        return [phantomAtCursor(host, state)];
      }
      // Timer expired — compute next placement
      const target = computeNextPlacement(host, state);
      if (target) {
        phase.state = {
          step: STEP.MOVING,
          target,
          rotation: buildRotationFor(host, target),
        };
        return tickMoving(host, phase, state, dt);
      }
      if (state.timer > 2) {
        phase.state = { step: STEP.THINKING, timer: 1.0 };
      } else {
        phase.state = { step: STEP.GAVE_UP, retryTimer: 1.0 };
      }
      return [phantomAtCursor(host, state)];
    }

    case STEP.GAVE_UP: {
      const bs = phase.state;
      const home = player.homeTower
        ? towerCenter(player.homeTower)
        : host.buildCursor;
      host.stepTileCursorToward(
        host.buildCursor,
        Math.round(home.row),
        Math.round(home.col),
        host.buildCursorSpeed,
        Infinity,
        dt,
      );
      bs.retryTimer -= dt;
      if (bs.retryTimer <= 0) {
        const target = computeNextPlacement(host, state);
        if (target) {
          phase.state = {
            step: STEP.MOVING,
            target,
            rotation: buildRotationFor(host, target),
          };
        } else {
          bs.retryTimer = 1.0;
        }
      }
      return [phantomAtCursor(host, state)];
    }

    case STEP.MOVING:
      return tickMoving(host, phase, state, dt);

    case STEP.DWELLING: {
      const bs = phase.state;
      bs.timer -= dt;
      if (bs.timer <= 0) {
        const placed = placePiece(
          state,
          host.playerId,
          bs.target.piece,
          bs.target.row,
          bs.target.col,
        );
        if (placed) {
          host.advanceBag(true);
          phase.state = {
            step: STEP.THINKING,
            timer: host.scaledDelay(0.3, 0.4),
          };
          return [];
        }
        // Placement blocked (e.g. grunt moved onto target)
        if (!bs.retried) {
          bs.retried = true;
          bs.timer = 1.0;
        } else {
          phase.state = { step: STEP.THINKING, timer: 0.1 };
        }
        return [];
      }
      return [
        makePhantom(
          host.playerId,
          bs.target.piece,
          bs.target.row,
          bs.target.col,
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
  dt: number,
): PiecePlacementPreview[] {
  const bs = phase.state as Extract<BuildState, { step: typeof STEP.MOVING }>;
  const { target, rotation } = bs;

  // Tick rotation animation concurrently with movement
  if (rotation.idx < rotation.seq.length) {
    rotation.timer -= dt;
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
    dt,
  );
  if (arrived && rotation.idx >= rotation.seq.length) {
    phase.state = {
      step: STEP.DWELLING,
      target,
      timer: host.scaledDelay(0.2, 0.3),
      retried: false,
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
      canPlacePiece(state, host.playerId, movingPiece, curRow, curCol),
    ),
  ];
}

/** Build rotation animation sequence from current bag piece to target orientation. */
function buildRotationFor(host: BuildHost, target: BuildTarget): BuildRotation {
  const bag = host.currentPiece!;
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
  const piece = host.currentPiece!;
  const row = Math.round(host.buildCursor.row);
  const col = Math.round(host.buildCursor.col);
  return makePhantom(
    host.playerId,
    piece,
    row,
    col,
    canPlacePiece(state, host.playerId, piece, row, col),
  );
}

function makePhantom(
  playerId: number,
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
  if (!host.currentPiece) return null;
  const result = host.strategy.pickPlacement(
    state,
    host.playerId,
    host.currentPiece,
    {
      row: Math.round(host.buildCursor.row),
      col: Math.round(host.buildCursor.col),
    },
  );
  return result
    ? { piece: result.piece, row: result.row, col: result.col }
    : null;
}

/** Check if two pieces have the same shape (ignoring position). */
function sameShape(a: PieceShape, b: PieceShape): boolean {
  return pieceKey(a) === pieceKey(b);
}

/** Normalized key for a piece shape (origin-independent). */
function pieceKey(pieceShape: PieceShape): string {
  const minR = Math.min(...pieceShape.offsets.map((offset) => offset[0]));
  const minC = Math.min(...pieceShape.offsets.map((offset) => offset[1]));
  return [...pieceShape.offsets]
    .map(([r, c]) => [r - minR, c - minC] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((offset) => `${offset[0]},${offset[1]}`)
    .join(";");
}
