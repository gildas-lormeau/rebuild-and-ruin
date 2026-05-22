/**
 * Score delta display sub-system — animated score deltas after the
 * build phase. Tick scope is mode-independent — the timer counts down
 * unconditionally from the main loop, including during banner/castle-
 * build animations.
 */

import { computeScoreDeltas } from "../../game/index.ts";
import { SCORE_DELTA_DISPLAY_TIME } from "../../shared/core/game-constants.ts";
import { emitGameEvent, GAME_EVENT } from "../../shared/core/game-event-bus.ts";
import { TILE_SIZE } from "../../shared/core/grid.ts";
import { towerCenterPx } from "../../shared/core/spatial.ts";
import type { RuntimeState } from "../runtime-state.ts";
import type { RuntimeScoreDelta } from "../runtime-types.ts";

interface ScoreDeltaDeps {
  readonly runtimeState: RuntimeState;
}

export function createScoreDeltaSystem(
  deps: ScoreDeltaDeps,
): RuntimeScoreDelta {
  const { runtimeState } = deps;

  /** Fires when the delta animation finishes. */
  let pendingDoneCb: (() => void) | undefined;

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
      // Camera is already at fullMapVp — the score overlay is reached via
      // `runTransition`, whose display chain was gated on camera convergence.
      scoreDisplay.deltaTimer = SCORE_DELTA_DISPLAY_TIME;
      pendingDoneCb = onDone;
      emitGameEvent(runtimeState.state.bus, GAME_EVENT.SCORE_OVERLAY_START, {
        round: runtimeState.state.round,
      });
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
      emitGameEvent(runtimeState.state.bus, GAME_EVENT.SCORE_OVERLAY_END, {
        round: runtimeState.state.round,
      });
      const callback = pendingDoneCb;
      pendingDoneCb = undefined;
      callback?.();
    }
  }

  function progress(): number {
    const { deltaTimer } = runtimeState.scoreDisplay;
    if (deltaTimer <= 0) return 1;
    return 1 - deltaTimer / SCORE_DELTA_DISPLAY_TIME;
  }

  function reset(): void {
    runtimeState.scoreDisplay.deltas = [];
    runtimeState.scoreDisplay.deltaTimer = 0;
    pendingDoneCb = undefined;
    runtimeState.scoreDisplay.preScores = [];
  }

  return {
    capturePreScores,
    setPreScores,
    show,
    tick,
    progress,
    reset,
  };
}
