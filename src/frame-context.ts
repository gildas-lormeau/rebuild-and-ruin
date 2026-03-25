/**
 * FrameContext — read-only derived state computed once per frame.
 *
 * Replaces scattered getter calls across sub-systems with a single
 * snapshot.  When a new "blocking" condition is added (e.g. tutorial
 * popup), add it to computeFrameContext and every system that reads
 * `shouldUnzoom` / `inputBlocked` picks it up automatically.
 */

import { Mode } from "./game-ui-types.ts";
import { IS_TOUCH_DEVICE } from "./platform.ts";
import { PHASE_ENDING_THRESHOLD, Phase } from "./types.ts";

export interface FrameContext {
  // Identity
  readonly myPlayerId: number;
  readonly firstHumanPlayerId: number;
  readonly isHost: boolean;

  // Mode / Phase
  readonly mode: Mode;
  readonly phase: Phase;

  // Overlay flags
  readonly paused: boolean;
  readonly quitPending: boolean;
  readonly hasLifeLostDialog: boolean;
  readonly isSelectionReady: boolean;

  // Composite guards
  /** UI overlay suppresses gameplay (pause, quit dialog, life-lost). */
  readonly uiBlocking: boolean;
  /** Phase timer about to expire (< PHASE_ENDING_THRESHOLD) on non-touch. */
  readonly phaseEnding: boolean;
  /** Camera should unzoom (uiBlocking OR phaseEnding). */
  readonly shouldUnzoom: boolean;
}

interface FrameContextInputs {
  mode: Mode;
  phase: Phase;
  timer: number;
  paused: boolean;
  quitPending: boolean;
  hasLifeLostDialog: boolean;
  isSelectionReady: boolean;
  myPlayerId: number;
  firstHumanPlayerId: number;
  isHost: boolean;
  mobileAutoZoom: boolean;
}

export function computeFrameContext(inputs: FrameContextInputs): FrameContext {
  const { mode, phase, timer, paused, quitPending, hasLifeLostDialog,
    isSelectionReady, myPlayerId, firstHumanPlayerId, isHost, mobileAutoZoom } = inputs;

  const uiBlocking = paused || quitPending || hasLifeLostDialog;

  const timedPhase = phase === Phase.WALL_BUILD || phase === Phase.CANNON_PLACE || phase === Phase.BATTLE;
  const phaseEnding = !mobileAutoZoom && !IS_TOUCH_DEVICE && timer > 0 &&
    timer <= PHASE_ENDING_THRESHOLD && timedPhase;

  const shouldUnzoom = uiBlocking || phaseEnding;

  return {
    myPlayerId,
    firstHumanPlayerId,
    isHost,
    mode,
    phase,
    paused,
    quitPending,
    hasLifeLostDialog,
    isSelectionReady,
    uiBlocking,
    phaseEnding,
    shouldUnzoom,
  };
}
