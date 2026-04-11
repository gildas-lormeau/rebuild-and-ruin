/**
 * Score delta display sub-system — owns the lifecycle of showing
 * animated score deltas after the build phase.
 *
 * Completion callback pattern: `onDone` is stored on runtimeState
 * (not a local closure) because the timer ticks mode-independently
 * — it counts down even during banner/castle-build animations.
 * Invoked via fireOnce to guarantee single invocation.
 * See runtime-types.ts for CONTRAST with life-lost and upgrade-pick patterns.
 *
 * Previously scattered across runtime-selection.ts (show),
 * runtime-composition.ts (tick), and runtime-phase-ticks.ts (guard + capture).
 * Colocated here for clarity.
 */

import { computeScoreDeltas } from "../game/index.ts";
import { SCORE_DELTA_DISPLAY_TIME } from "../shared/game-constants.ts";
import { TILE_SIZE } from "../shared/grid.ts";
import { fireOnce } from "../shared/platform/utils.ts";
import { towerCenterPx } from "../shared/spatial.ts";
import type { RuntimeState } from "./runtime-state.ts";

interface ScoreDeltaDeps {
  readonly runtimeState: RuntimeState;
  readonly clearPhaseZoom: () => void;
}

interface ScoreDeltaSystem {
  /** Snapshot current player scores before the build phase starts. */
  capturePreScores: () => void;
  /** Set pre-scores directly (online watcher receives them from host). */
  setPreScores: (scores: readonly number[]) => void;
  /** Show animated score deltas. `onDone` fires once when animation finishes
   *  (or immediately if no positive deltas exist). */
  show: (onDone: () => void) => void;
  /** Tick the display timer (called every frame from mainLoop). */
  tick: (dt: number) => void;
  /** Animation progress 0→1 (0 = just started, 1 = done). */
  progress: () => number;
  /** True while the score delta animation is playing (blocks build phase tick). */
  isActive: () => boolean;
  /** Clear all score delta state. Safe to call at any time. */
  reset: () => void;
}

export function createScoreDeltaSystem(deps: ScoreDeltaDeps): ScoreDeltaSystem {
  const { runtimeState } = deps;

  function capturePreScores(): void {
    runtimeState.scoreDisplay.preScores = runtimeState.state.players.map(
      (player) => player.score,
    );
  }

  function setPreScores(scores: readonly number[]): void {
    runtimeState.scoreDisplay.preScores = scores;
  }

  function show(onDone: () => void): void {
    const scoreDisplay = runtimeState.scoreDisplay;
    // Guard: prevent re-entrancy (onDone callbacks must not restart the display)
    if (scoreDisplay.deltaTimer > 0) {
      onDone();
      return;
    }
    const players = runtimeState.state.players;
    scoreDisplay.deltas = computeScoreDeltas(
      players,
      scoreDisplay.preScores,
    ).map((delta) => {
      const homeTower = players[delta.playerId]!.homeTower;
      const px = homeTower ? towerCenterPx(homeTower) : { x: 0, y: 0 };
      return { ...delta, cx: px.x, cy: px.y - TILE_SIZE };
    });

    if (scoreDisplay.deltas.length > 0) {
      deps.clearPhaseZoom();
      scoreDisplay.deltaTimer = SCORE_DELTA_DISPLAY_TIME;
      scoreDisplay.deltaOnDone = onDone;
    } else {
      onDone();
    }
  }

  /** Tick the score delta display timer (mode-independent — counts during banner/castle-build).
   *  Lifecycle: show() sets deltas+timer+onDone → this ticks down →
   *  clears deltas and fires onDone exactly once when the timer expires.
   *  Re-entrancy: onDone must NOT call show() — that would restart
   *  the timer and create an infinite display loop. */
  function tick(dt: number): void {
    const scoreDisplay = runtimeState.scoreDisplay;
    if (scoreDisplay.deltaTimer <= 0) return;
    scoreDisplay.deltaTimer -= dt;
    if (scoreDisplay.deltaTimer <= 0) {
      scoreDisplay.deltas = [];
      scoreDisplay.deltaTimer = 0;
      // fireOnce: invokes scoreDisplay.deltaOnDone at most once, then clears it
      fireOnce(scoreDisplay, "deltaOnDone");
    }
  }

  function progress(): number {
    const { deltaTimer } = runtimeState.scoreDisplay;
    if (deltaTimer <= 0) return 1;
    return 1 - deltaTimer / SCORE_DELTA_DISPLAY_TIME;
  }

  function isActive(): boolean {
    return runtimeState.scoreDisplay.deltaTimer > 0;
  }

  function reset(): void {
    runtimeState.scoreDisplay.deltas = [];
    runtimeState.scoreDisplay.deltaTimer = 0;
    runtimeState.scoreDisplay.deltaOnDone = null;
    runtimeState.scoreDisplay.preScores = [];
  }

  return {
    capturePreScores,
    setPreScores,
    show,
    tick,
    progress,
    isActive,
    reset,
  };
}
