/**
 * Score delta display sub-system — animated score deltas after the
 * build phase. Ticked from the main loop outside the mode dispatch (the
 * round-end overlay runs in Mode.TRANSITION, which `tickMode` doesn't
 * route here), but gated like the rest of the sim: frozen by pause and
 * by the non-ticking menu modes (mid-game OPTIONS / CONTROLS).
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
 *  scope: every gameplay mode while unpaused (the round-end overlay
 *  spans Mode.TRANSITION, so the main loop ticks this outside the mode
 *  dispatch); frozen with the rest of the sim by pause and the menu
 *  modes. Visibility is on the runtime's overlay state. */
export interface RuntimeScoreDelta {
  /** Set the round's pre-build scores. Sole producer: `enter-round-end`'s
   *  mutate captures them right before `finalizeRound` mutates scores via
   *  the territory + life-penalty awards — every peer (host and watcher)
   *  runs that mutate locally. */
  setPreScores: (scores: readonly number[]) => void;
  /** Start the animated score-delta overlay (the ROUND_END score beat).
   *  No completion callback — the self-driving `tickRoundEndPhase` polls
   *  `isActive()` to know when to advance to the life-lost dialog beat.
   *  Calling while an overlay is active REPLACES it. */
  start: () => void;
  /** True while the overlay is still animating (timer not yet expired).
   *  The round-end tick waits on this before the dialog beat. */
  isActive: () => boolean;
  /** Tick the display timer (called every frame from mainLoop). Clears the
   *  deltas and emits SCORE_OVERLAY_END when the timer expires. */
  tick: (dt: number) => void;
  /** Animation progress 0→1 (0 = just started, 1 = done). */
  progress: () => number;
  /** Clear all score delta state (timer, deltas). Safe to call at any time —
   *  host-promote teardown uses it to drop a mid-tick overlay; the promoted
   *  peer re-enters the ROUND_END window and rebuilds. */
  reset: () => void;
}

export function createScoreDeltaSystem(
  deps: ScoreDeltaDeps,
): RuntimeScoreDelta {
  const { runtimeState } = deps;

  function setPreScores(scores: readonly number[]): void {
    runtimeState.scoreDisplay.preScores = scores;
  }

  function start(): void {
    const scoreDisplay = runtimeState.scoreDisplay;
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
      // Camera is already at fullMapVp — `enter-round-end` snaps it before
      // starting the overlay.
      scoreDisplay.deltaTimer = SCORE_DELTA_DISPLAY_TIME;
      emitGameEvent(runtimeState.state.bus, GAME_EVENT.SCORE_OVERLAY_START, {
        round: runtimeState.state.round,
      });
    } else {
      // No positive deltas: nothing to animate. Leaving the timer at 0
      // makes `isActive()` false so the tick advances straight to the
      // dialog beat. Also kills a replaced overlay's leftover timer.
      scoreDisplay.deltaTimer = 0;
    }
  }

  function isActive(): boolean {
    return runtimeState.scoreDisplay.deltaTimer > 0;
  }

  /** Tick the score delta display timer (runs in every unpaused
   *  gameplay mode, including the TRANSITION score-overlay window).
   *  Lifecycle: start() sets deltas+timer → this ticks down → clears the
   *  deltas and emits SCORE_OVERLAY_END when the timer expires. The
   *  self-driving `tickRoundEndPhase` then observes `isActive()` false and
   *  advances to the life-lost dialog beat. */
  function tick(dt: number): void {
    const scoreDisplay = runtimeState.scoreDisplay;
    if (scoreDisplay.deltaTimer <= 0) return;
    scoreDisplay.deltaTimer -= dt;
    if (scoreDisplay.deltaTimer <= 0) finishOverlay();
  }

  /** Expiry tail: clear the display and emit the END beat. */
  function finishOverlay(): void {
    const scoreDisplay = runtimeState.scoreDisplay;
    scoreDisplay.deltas = [];
    scoreDisplay.deltaTimer = 0;
    emitGameEvent(runtimeState.state.bus, GAME_EVENT.SCORE_OVERLAY_END, {
      round: runtimeState.state.round,
    });
  }

  function progress(): number {
    const { deltaTimer } = runtimeState.scoreDisplay;
    if (deltaTimer <= 0) return 1;
    return 1 - deltaTimer / SCORE_DELTA_DISPLAY_TIME;
  }

  function reset(): void {
    runtimeState.scoreDisplay.deltas = [];
    runtimeState.scoreDisplay.deltaTimer = 0;
    runtimeState.scoreDisplay.preScores = [];
  }

  return {
    setPreScores,
    start,
    isActive,
    tick,
    progress,
    reset,
  };
}
