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
import type { RuntimeState } from "../state.ts";

interface ScoreDeltaDeps {
  readonly runtimeState: RuntimeState;
}

/** Public score-delta animation handle exposed on `GameRuntime`. Tick
 *  scope: mode-independent (the timer counts down regardless of mode,
 *  including during banner/castle-build animations). Driven by `tick(dt)`
 *  from the main loop; visibility is on the runtime's overlay state. */
export interface RuntimeScoreDelta {
  /** Set the round's pre-build scores. Sole producer: ROUND_END's mutate
   *  captures them right before `finalizeRound` mutates scores via the
   *  territory + life-penalty awards — every peer (host and watcher) runs
   *  that mutate locally. */
  setPreScores: (scores: readonly number[]) => void;
  /** Show animated score deltas. `onDone` fires once when animation finishes
   *  (or immediately if no positive deltas exist). Calling while an overlay
   *  is active REPLACES it — the previous `onDone` is dropped, banner-style
   *  (a FULL_STATE apply mid-overlay re-dispatches round-end). */
  show: (onDone: () => void) => void;
  /** Tick the display timer (called every frame from mainLoop). */
  tick: (dt: number) => void;
  /** Finish an active overlay immediately: clear the display and fire the
   *  pending `runDisplay` continuation, exactly as a natural timer expiry
   *  would. No-op when no overlay is active. Host-promotion repair — the
   *  round-end fast-forward (`forceResolveRoundEndPhase`) uses this to
   *  hand control to the life-lost dialog step synchronously instead of
   *  tearing the chain down (which would orphan the round-end routing). */
  finishNow: () => void;
  /** Animation progress 0→1 (0 = just started, 1 = done). */
  progress: () => number;
  /** Clear all score delta state (timer, deltas, pending callback). Safe to
   *  call at any time — host-promote relies on this to drop a stale
   *  `runDisplay` callback when promotion lands mid-overlay. */
  reset: () => void;
}

export function createScoreDeltaSystem(
  deps: ScoreDeltaDeps,
): RuntimeScoreDelta {
  const { runtimeState } = deps;

  /** Fires when the delta animation finishes. */
  let pendingDoneCb: (() => void) | undefined;

  function setPreScores(scores: readonly number[]): void {
    runtimeState.scoreDisplay.preScores = scores;
  }

  function show(onDone: () => void): void {
    const scoreDisplay = runtimeState.scoreDisplay;
    // Replace semantics (mirrors showBanner): a second show() while the
    // overlay is still ticking — a FULL_STATE apply landing mid-overlay
    // makes this peer re-dispatch round-end — drops the stale chain's
    // continuation and restarts the overlay for the new chain. Letting
    // both continuations fire routes postDisplay twice; the stale one
    // then dispatches from a phase the fresh chain already advanced
    // (source-phase guard throw — see the mid-score-overlay test in
    // test/network-vs-local.test.ts).
    pendingDoneCb = undefined;
    const players = runtimeState.state.players;
    scoreDisplay.deltas = computeScoreDeltas(
      players,
      scoreDisplay.preScores,
    ).map((delta) => {
      // REACHABLE null: a player queued for reselect has homeTower nulled
      // by the life penalty's board reset but can still close the round
      // with a positive delta (territory scored before the penalty) —
      // seed 0 classic hits this on its first reselect. Their delta
      // paints at the map origin; a nicer anchor (last home zone) would
      // need state the reset already discarded.
      const homeTower = players[delta.playerId]!.homeTower;
      const px = homeTower ? towerCenterPx(homeTower) : { x: 0, y: 0 };
      return { ...delta, cx: px.x, cy: px.y - TILE_SIZE };
    });

    if (scoreDisplay.deltas.length > 0) {
      // Camera is already at fullMapVp — the score overlay is reached via
      // `runTransition`, which snaps the camera to fullmap at dispatch.
      scoreDisplay.deltaTimer = SCORE_DELTA_DISPLAY_TIME;
      pendingDoneCb = onDone;
      emitGameEvent(runtimeState.state.bus, GAME_EVENT.SCORE_OVERLAY_START, {
        round: runtimeState.state.round,
      });
    } else {
      // Also kills a replaced overlay's leftover timer — without this an
      // empty re-show would leave the old timer draining toward an
      // orphaned SCORE_OVERLAY_END.
      scoreDisplay.deltaTimer = 0;
      onDone();
    }
  }

  /** Tick the score delta display timer (mode-independent — counts during banner/castle-build).
   *  Lifecycle: show() sets deltas+timer+onDone → this ticks down →
   *  clears deltas and fires onDone exactly once when the timer expires.
   *  Re-entrancy: onDone must NOT call show() — each call would restart
   *  the overlay and the display would never end. */
  function tick(dt: number): void {
    const scoreDisplay = runtimeState.scoreDisplay;
    if (scoreDisplay.deltaTimer <= 0) return;
    scoreDisplay.deltaTimer -= dt;
    if (scoreDisplay.deltaTimer <= 0) finishOverlay();
  }

  /** Shared expiry tail: clear the display, emit the END beat, fire the
   *  continuation once. Reached by the natural tick countdown and by
   *  `finishNow` (host-promotion fast-forward). */
  function finishOverlay(): void {
    const scoreDisplay = runtimeState.scoreDisplay;
    scoreDisplay.deltas = [];
    scoreDisplay.deltaTimer = 0;
    emitGameEvent(runtimeState.state.bus, GAME_EVENT.SCORE_OVERLAY_END, {
      round: runtimeState.state.round,
    });
    const callback = pendingDoneCb;
    pendingDoneCb = undefined;
    callback?.();
  }

  function finishNow(): void {
    if (runtimeState.scoreDisplay.deltaTimer <= 0) return;
    finishOverlay();
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
    setPreScores,
    show,
    tick,
    finishNow,
    progress,
    reset,
  };
}
