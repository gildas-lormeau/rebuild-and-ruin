/**
 * AI cannon-phase state machine — cannon placement with cursor animation
 * and mode switching.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { STEP } from "./ai-constants.ts";
import type { AiStrategy, CannonPlacement } from "./ai-strategy.ts";
import { canPlaceCannon, placeCannon } from "./cannon-system.ts";
import type { CannonPlacementPreview } from "./controller-interfaces.ts";
import type { TilePos } from "./geometry-types.ts";
import {
  CannonMode,
  type GameState,
  isPlayerAlive,
  type Player,
} from "./types.ts";

/** Subset of AiController accessed by cannon-phase logic. */
interface CannonHost {
  readonly playerId: number;
  readonly strategy: AiStrategy;
  cannonCursor: TilePos;
  readonly cannonCursorSpeed: number;
  readonly boostThreshold: number;
  scaledDelay(base: number, spread: number): number;
  stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
    dt: number,
  ): boolean;
}

type CannonState =
  | { step: typeof STEP.IDLE }
  | { step: typeof STEP.THINKING; timer: number }
  | { step: typeof STEP.MODE_SWITCHING; timer: number }
  | { step: typeof STEP.MOVING }
  | { step: typeof STEP.DWELLING; timer: number };

interface CannonPhase {
  state: CannonState;
  queue: CannonPlacement[];
  maxSlots: number;
  displayedMode: CannonMode | undefined;
}

/** AI cannon-phase cursor speed in tiles per second, indexed by cursorSkill-1
 *  (skill 1→[0], 2→[1], 3→[2]). */
export const CANNON_CURSOR_SPEEDS = [3, 4, 5] as const;

export function createCannonPhase(): CannonPhase {
  return {
    state: { step: STEP.IDLE },
    queue: [],
    maxSlots: 0,
    displayedMode: undefined,
  };
}

export function resetCannonPhase(phase: CannonPhase): void {
  phase.state = { step: STEP.IDLE };
  phase.queue = [];
  phase.maxSlots = 0;
}

/** Ask the strategy for cannon placements and begin the queue. */
export function initCannon(
  host: CannonHost,
  phase: CannonPhase,
  state: GameState,
  maxSlots: number,
): void {
  const player = state.players[host.playerId];
  if (!isPlayerAlive(player)) return;
  phase.queue = host.strategy.placeCannons(player, maxSlots, state);
  phase.maxSlots = maxSlots;
  phase.displayedMode = undefined;
  phase.state = {
    step: STEP.THINKING,
    timer: host.scaledDelay(0.3, 0.4),
  };
}

export function isCannonDone(phase: CannonPhase): boolean {
  return phase.queue.length === 0 && phase.state.step === STEP.IDLE;
}

/** Place all remaining queued cannons instantly (timer expired). */
export function flushCannon(
  phase: CannonPhase,
  state: GameState,
  playerId: number,
  maxSlots: number,
): void {
  const player = state.players[playerId];
  if (!isPlayerAlive(player)) return;
  for (const target of phase.queue) {
    const mode = target.mode;
    if (canPlaceCannon(player, target.row, target.col, mode, state)) {
      placeCannon(player, target.row, target.col, maxSlots, mode, state);
    }
  }
  phase.queue = [];
  phase.state = { step: STEP.IDLE };
}

export function tickCannon(
  host: CannonHost,
  phase: CannonPhase,
  state: GameState,
  dt: number,
): CannonPlacementPreview | null {
  const player = state.players[host.playerId];
  if (!isPlayerAlive(player)) return null;

  switch (phase.state.step) {
    case STEP.IDLE:
      return null;

    case STEP.THINKING: {
      phase.state.timer -= dt;
      if (phase.state.timer > 0) return null;
      if (phase.queue.length === 0) {
        phase.state = { step: STEP.IDLE };
        return null;
      }
      // Check if mode switch is needed
      const target = phase.queue[0]!;
      if (target.mode !== phase.displayedMode) {
        phase.displayedMode = target.mode;
        phase.state = {
          step: STEP.MODE_SWITCHING,
          timer: host.scaledDelay(0.25, 0.2),
        };
        return phantomAt(
          host.playerId,
          phase,
          Math.round(host.cannonCursor.row),
          Math.round(host.cannonCursor.col),
          false,
        );
      }
      phase.state = { step: STEP.MOVING };
      return tickMoving(host, phase, state, player, dt);
    }

    case STEP.MODE_SWITCHING: {
      phase.state.timer -= dt;
      if (phase.state.timer <= 0) {
        phase.state = { step: STEP.MOVING };
      }
      return phantomAt(
        host.playerId,
        phase,
        Math.round(host.cannonCursor.row),
        Math.round(host.cannonCursor.col),
        false,
      );
    }

    case STEP.MOVING:
      return tickMoving(host, phase, state, player, dt);

    case STEP.DWELLING: {
      phase.state.timer -= dt;
      if (phase.state.timer <= 0) {
        const target = phase.queue[0]!;
        const targetMode = target.mode;
        if (canPlaceCannon(player, target.row, target.col, targetMode, state)) {
          placeCannon(
            player,
            target.row,
            target.col,
            phase.maxSlots,
            targetMode,
            state,
          );
        }
        phase.queue.shift();
        phase.state = {
          step: STEP.THINKING,
          timer: host.scaledDelay(0.3, 0.4),
        };
        return null;
      }
      const target = phase.queue[0]!;
      return phantomAt(host.playerId, phase, target.row, target.col, true);
    }
  }
}

function tickMoving(
  host: CannonHost,
  phase: CannonPhase,
  state: GameState,
  player: Player,
  dt: number,
): CannonPlacementPreview {
  const target = phase.queue[0]!;
  const targetMode = target.mode;
  if (
    host.stepTileCursorToward(
      host.cannonCursor,
      target.row,
      target.col,
      host.cannonCursorSpeed,
      host.boostThreshold,
      dt,
    )
  ) {
    phase.state = {
      step: STEP.DWELLING,
      timer: host.scaledDelay(0.2, 0.3),
    };
  }
  const curRow = Math.round(host.cannonCursor.row);
  const curCol = Math.round(host.cannonCursor.col);
  const atTarget = curRow === target.row && curCol === target.col;
  return {
    row: curRow,
    col: curCol,
    valid:
      atTarget && canPlaceCannon(player, curRow, curCol, targetMode, state),
    mode: targetMode,
    playerId: host.playerId,
  };
}

function phantomAt(
  playerId: number,
  phase: CannonPhase,
  row: number,
  col: number,
  valid: boolean,
): CannonPlacementPreview {
  const target = phase.queue[0]!;
  const targetMode = target.mode;
  return {
    row,
    col,
    valid,
    mode: targetMode,
    playerId,
  };
}
