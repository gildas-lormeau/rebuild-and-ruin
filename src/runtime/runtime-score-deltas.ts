/**
 * Score delta display sub-system — owns the lifecycle of showing
 * animated score deltas after the build phase.
 *
 * Previously scattered across runtime-selection.ts (show),
 * runtime.ts (tick), and runtime-phase-ticks.ts (guard + capture).
 * Colocated here for clarity.
 */

import { SCORE_DELTA_DISPLAY_TIME } from "../shared/game-constants.ts";
import { TILE_SIZE } from "../shared/grid.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { towerCenterPx } from "../shared/spatial.ts";
import { fireOnce } from "../shared/utils.ts";
import type { RuntimeState, ScoreDisplayState } from "./runtime-state.ts";

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
  /** True while the score delta animation is playing (blocks build phase tick). */
  isActive: () => boolean;
  /** Clear all score delta state. Safe to call at any time. */
  reset: () => void;
}

export function createScoreDeltaSystem(deps: ScoreDeltaDeps): ScoreDeltaSystem {
  const { runtimeState } = deps;
  const sd = (): ScoreDisplayState => runtimeState.scoreDisplay;

  function capturePreScores(): void {
    sd().preScores = runtimeState.state.players.map((player) => player.score);
  }

  function setPreScores(scores: readonly number[]): void {
    sd().preScores = scores;
  }

  function show(onDone: () => void): void {
    // Guard: prevent re-entrancy (onDone callbacks must not restart the display)
    if (sd().deltaTimer > 0) {
      onDone();
      return;
    }
    // Compute score deltas from the build phase (with display coordinates)
    sd().deltas = runtimeState.state.players
      .map((player, i) => {
        const ht = player.homeTower;
        const px = ht ? towerCenterPx(ht) : { x: 0, y: 0 };
        return {
          playerId: i as ValidPlayerSlot,
          delta: player.score - (sd().preScores[i] ?? 0),
          total: player.score,
          cx: px.x,
          cy: px.y - TILE_SIZE, // just above the tower
        };
      })
      .filter(
        (scoreDelta) =>
          scoreDelta.delta > 0 &&
          !runtimeState.state.players[scoreDelta.playerId]!.eliminated,
      );

    if (sd().deltas.length > 0) {
      deps.clearPhaseZoom();
      sd().deltaTimer = SCORE_DELTA_DISPLAY_TIME;
      sd().deltaOnDone = onDone;
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
    if (sd().deltaTimer <= 0) return;
    sd().deltaTimer -= dt;
    if (sd().deltaTimer <= 0) {
      sd().deltas = [];
      sd().deltaTimer = 0;
      // fireOnce: invokes scoreDisplay.deltaOnDone at most once, then clears it
      fireOnce(runtimeState.scoreDisplay, "deltaOnDone");
    }
  }

  function isActive(): boolean {
    return sd().deltaOnDone !== null;
  }

  function reset(): void {
    sd().deltas = [];
    sd().deltaTimer = 0;
    sd().deltaOnDone = null;
    sd().preScores = [];
  }

  return { capturePreScores, setPreScores, show, tick, isActive, reset };
}
