/**
 * AI cannon-phase state machine — cannon placement with cursor animation
 * and mode switching.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { canPlaceCannon } from "../game/index.ts";
import { CannonMode } from "../shared/core/battle-types.ts";
import type { TilePos } from "../shared/core/geometry-types.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { type Player } from "../shared/core/player-types.ts";
import type {
  CannonPlacementPreview,
  CannonViewState,
  PlaceCannonIntent,
} from "../shared/core/system-interfaces.ts";
import { STEP } from "./ai-constants.ts";
import type {
  AiStrategy,
  CannonPlacement,
  CannonPlacementContext,
} from "./ai-strategy.ts";

/** Subset of AiController accessed by cannon-phase logic.
 *  Exported so controller-ai.ts can statically assert AiController implements
 *  every phase's Host (see the `satisfies` check at the bottom of that file). */
export interface CannonHost {
  readonly playerId: ValidPlayerSlot;
  readonly strategy: AiStrategy;
  cannonCursor: TilePos;
  readonly cannonCursorSpeed: number;
  readonly boostThreshold: number;
  /** Returns `(base + rng * spread) * delayScale` — humanizes AI timing per difficulty. */
  scaledDelay(base: number, spread: number): number;
  stepTileCursorToward(
    cursor: TilePos,
    targetRow: number,
    targetCol: number,
    baseSpeed: number,
    boostThreshold: number,
  ): boolean;
}

type CannonState =
  | { step: "idle" }
  | { step: "thinking"; timer: number }
  | { step: "mode_switching"; timer: number }
  | { step: "moving" }
  | { step: "dwelling"; timer: number };

interface CannonPhase {
  state: CannonState;
  /** Per-phase placement context. `undefined` before init and once the
   *  strategy reports no more placements available (phase complete). */
  ctx: CannonPlacementContext | undefined;
  /** The placement currently being animated (set by THINKING, consumed
   *  by DWELLING). Separate from `ctx` so the mode/position the cursor
   *  is heading toward is stable across MODE_SWITCHING → MOVING →
   *  DWELLING transitions. */
  currentTarget: CannonPlacement | undefined;
  maxSlots: number;
  displayedMode: CannonMode | undefined;
}

/** Pause after placing or initializing before thinking about the next cannon. */
const POST_PLACE_DELAY_SEC = 0.3;
const POST_PLACE_SPREAD_SEC = 0.4;
/** Pause during cannon mode switch animation (e.g. normal → balloon). */
const MODE_SWITCH_DELAY_SEC = 0.25;
const MODE_SWITCH_SPREAD_SEC = 0.2;
/** Pause on target tile before attempting placement. */
const PRE_PLACE_DELAY_SEC = 0.2;
const PRE_PLACE_SPREAD_SEC = 0.3;
/** AI cannon-phase cursor speed in tiles per second, indexed by cursorSkill-1
 *  (skill 1→[0], 2→[1], 3→[2]). */
export const CANNON_CURSOR_SPEEDS = [3, 4, 5] as const;

export function createCannonPhase(): CannonPhase {
  return {
    state: { step: STEP.IDLE },
    ctx: undefined,
    currentTarget: undefined,
    maxSlots: 0,
    displayedMode: undefined,
  };
}

export function resetCannonPhase(phase: CannonPhase): void {
  phase.state = { step: STEP.IDLE };
  phase.ctx = undefined;
  phase.currentTarget = undefined;
  phase.maxSlots = 0;
  phase.displayedMode = undefined;
}

/** Set up the cannon-phase placement context and enter THINKING. No
 *  placements happen here — each cannon is decided on the fly during
 *  the animation loop via `strategy.nextCannonPlacement`. */
export function initCannon(
  host: CannonHost,
  phase: CannonPhase,
  state: CannonViewState,
  maxSlots: number,
): void {
  phase.ctx = host.strategy.initCannonPhase(
    state.players[host.playerId]!,
    maxSlots,
    state,
  );
  phase.currentTarget = undefined;
  phase.maxSlots = maxSlots;
  phase.displayedMode = undefined;
  phase.state = {
    step: STEP.THINKING,
    timer: host.scaledDelay(POST_PLACE_DELAY_SEC, POST_PLACE_SPREAD_SEC),
  };
}

export function isCannonDone(phase: CannonPhase): boolean {
  return phase.state.step === STEP.IDLE && phase.ctx === undefined;
}

/** Place all remaining cannons instantly (phase timer expired). Drains
 *  the in-flight target first (if any), then loops `nextCannonPlacement`
 *  until the strategy returns undefined. */
export function flushCannon(
  host: CannonHost,
  phase: CannonPhase,
  state: CannonViewState,
  executePlaceCannon: (intent: PlaceCannonIntent) => boolean,
): void {
  if (phase.currentTarget) {
    executePlaceCannon({
      playerId: host.playerId,
      row: phase.currentTarget.row,
      col: phase.currentTarget.col,
      mode: phase.currentTarget.mode,
    });
    phase.currentTarget = undefined;
  }
  if (phase.ctx) {
    const player = state.players[host.playerId]!;
    while (true) {
      const target = host.strategy.nextCannonPlacement(
        player,
        phase.maxSlots,
        state,
        phase.ctx,
      );
      if (!target) break;
      executePlaceCannon({
        playerId: host.playerId,
        row: target.row,
        col: target.col,
        mode: target.mode,
      });
    }
  }
  phase.ctx = undefined;
  phase.state = { step: STEP.IDLE };
}

export function tickCannon(
  host: CannonHost,
  phase: CannonPhase,
  state: CannonViewState,
  executePlaceCannon: (intent: PlaceCannonIntent) => boolean,
): CannonPlacementPreview | null {
  const player = state.players[host.playerId]!;

  switch (phase.state.step) {
    case STEP.IDLE:
      return null;

    case STEP.THINKING: {
      phase.state.timer--;
      if (phase.state.timer > 0) return null;
      // Decide the next placement on the fly. `ctx` is cleared when the
      // strategy returns undefined so `isCannonDone` reads true cleanly.
      if (!phase.ctx) {
        phase.state = { step: STEP.IDLE };
        return null;
      }
      const target = host.strategy.nextCannonPlacement(
        player,
        phase.maxSlots,
        state,
        phase.ctx,
      );
      if (!target) {
        phase.ctx = undefined;
        phase.state = { step: STEP.IDLE };
        return null;
      }
      phase.currentTarget = target;
      if (target.mode !== phase.displayedMode) {
        phase.displayedMode = target.mode;
        phase.state = {
          step: STEP.MODE_SWITCHING,
          timer: host.scaledDelay(
            MODE_SWITCH_DELAY_SEC,
            MODE_SWITCH_SPREAD_SEC,
          ),
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
      return tickMoving(host, phase, state, player);
    }

    case STEP.MODE_SWITCHING: {
      phase.state.timer--;
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
      return tickMoving(host, phase, state, player);

    case STEP.DWELLING: {
      phase.state.timer--;
      if (phase.state.timer <= 0) {
        const target = phase.currentTarget;
        if (!target) {
          phase.state = { step: STEP.IDLE };
          return null;
        }
        executePlaceCannon({
          playerId: host.playerId,
          row: target.row,
          col: target.col,
          mode: target.mode,
        });
        phase.currentTarget = undefined;
        phase.state = {
          step: STEP.THINKING,
          timer: host.scaledDelay(POST_PLACE_DELAY_SEC, POST_PLACE_SPREAD_SEC),
        };
        return null;
      }
      const target = phase.currentTarget;
      if (!target) return null;
      return phantomAt(host.playerId, phase, target.row, target.col, true);
    }
  }
}

function tickMoving(
  host: CannonHost,
  phase: CannonPhase,
  state: CannonViewState,
  player: Player,
): CannonPlacementPreview | null {
  const target = phase.currentTarget;
  if (!target) return null;
  const targetMode = target.mode;
  if (
    host.stepTileCursorToward(
      host.cannonCursor,
      target.row,
      target.col,
      host.cannonCursorSpeed,
      host.boostThreshold,
    )
  ) {
    phase.state = {
      step: STEP.DWELLING,
      timer: host.scaledDelay(PRE_PLACE_DELAY_SEC, PRE_PLACE_SPREAD_SEC),
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
  playerId: ValidPlayerSlot,
  phase: CannonPhase,
  row: number,
  col: number,
  valid: boolean,
): CannonPlacementPreview | null {
  const target = phase.currentTarget;
  if (!target) return null;
  const targetMode = target.mode;
  return {
    row,
    col,
    valid,
    mode: targetMode,
    playerId,
  };
}
