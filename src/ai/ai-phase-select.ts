/**
 * AI selection-phase state machine — tower browsing and confirmation.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import type { TowerIdx } from "../shared/core/geometry-types.ts";
import type { GameViewState } from "../shared/core/system-interfaces.ts";
import type { ZoneId } from "../shared/core/zone-id.ts";
import { selectPlayerTower } from "../shared/sim/player-rules.ts";
import { STEP } from "./ai-constants.ts";
import type { AiStrategy, SelectionHost } from "./ai-strategy-types.ts";

type AiSelectionState =
  | { step: "idle" }
  | {
      step: "browsing";
      queue: TowerIdx[];
      browseTimer: number;
      confirmInitialDelay: number;
    }
  | { step: "confirming"; timer: number }
  | { step: "confirmed" };

interface SelectionPhase {
  state: AiSelectionState;
  /** The brain's strategy — read for the chosen tower, browse rng, and the
   *  scaled browse/confirm delays. */
  readonly strategy: AiStrategy;
}

/** Minimum number of *other* towers to visit before the chosen one. */
const MIN_BROWSE_COUNT = 1;
/** Inclusive range of additional browses on top of `MIN_BROWSE_COUNT` —
 *  picked uniformly via `floor(rng * BROWSE_COUNT_RANGE)`, so the realized
 *  visit count is 1–3. */
const BROWSE_COUNT_RANGE = 3;
/** Dwell on each browsed tower before advancing to the next (pre-delayScale). */
const BROWSE_DELAY_SEC = 0.8;
const BROWSE_SPREAD_SEC = 0.6;
/** Pause on the final (chosen) tower before confirming the selection. */
const CONFIRM_INITIAL_DELAY_SEC = 1.0;
const CONFIRM_INITIAL_SPREAD_SEC = 0.6;

export function createSelectionPhase(strategy: AiStrategy): SelectionPhase {
  return { state: { step: STEP.IDLE }, strategy };
}

export function resetSelectionPhase(phase: SelectionPhase): void {
  phase.state = { step: STEP.IDLE };
}

/** Pick a tower and begin the browse → confirm animation. */
export function initSelection(
  host: SelectionHost,
  phase: SelectionPhase,
  state: GameViewState,
  zone: ZoneId,
): void {
  const player = state.players[host.playerId];
  if (!player) return;
  const { strategy } = phase;
  const chosenTower = strategy.chooseBestTower(state.map, zone);

  // Build browse queue: visit MIN_BROWSE_COUNT..MIN+RANGE-1 random zone towers
  // before the chosen one (currently 1–3).
  const zoneTowers = state.map.towers.filter((tower) => tower.zone === zone);
  const others = zoneTowers.filter((tower) => tower !== chosenTower);
  const browseCount = Math.min(
    others.length,
    MIN_BROWSE_COUNT + Math.floor(strategy.rng.next() * BROWSE_COUNT_RANGE),
  );
  // Shuffle and take browseCount
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(strategy.rng.next() * (i + 1));
    [others[i], others[j]] = [others[j]!, others[i]!];
  }
  const queue = others.slice(0, browseCount).map((tower) => tower.index);
  if (chosenTower) queue.push(chosenTower.index);

  phase.state = {
    step: STEP.BROWSING,
    queue,
    browseTimer: strategy.scaledDelay(BROWSE_DELAY_SEC, BROWSE_SPREAD_SEC),
    confirmInitialDelay: strategy.scaledDelay(
      CONFIRM_INITIAL_DELAY_SEC,
      CONFIRM_INITIAL_SPREAD_SEC,
    ),
  };

  // Start at first tower in browse queue
  const firstIdx = queue[0];
  const firstTower =
    firstIdx !== undefined ? state.map.towers[firstIdx] : chosenTower;
  if (firstTower) selectPlayerTower(player, firstTower);
}

/** Advance the selection state machine. Browses towers, then dwells, then
 *  transitions to the terminal CONFIRMED step. Query confirmation separately
 *  via `isSelectionConfirmed` — the tick itself no longer signals completion
 *  through a return value. */
export function tickSelection(
  host: SelectionHost,
  phase: SelectionPhase,
  // Optional: selection phase can tick without state during initial lobby setup.
  state?: GameViewState,
): void {
  switch (phase.state.step) {
    case STEP.IDLE:
    case STEP.CONFIRMED:
      return;
    case STEP.BROWSING: {
      const selectionState = phase.state;
      selectionState.browseTimer--;
      if (selectionState.browseTimer <= 0 && selectionState.queue.length > 1) {
        selectionState.queue.shift();
        selectionState.browseTimer = phase.strategy.scaledDelay(
          BROWSE_DELAY_SEC,
          BROWSE_SPREAD_SEC,
        );
        if (state) {
          const nextIdx = selectionState.queue[0];
          const nextTower =
            nextIdx !== undefined ? state.map.towers[nextIdx] : undefined;
          const browsePlayer = state.players[host.playerId];
          if (nextTower && browsePlayer)
            selectPlayerTower(browsePlayer, nextTower);
        }
        return;
      }
      if (selectionState.queue.length <= 1) {
        phase.state = {
          step: STEP.CONFIRMING,
          timer: selectionState.confirmInitialDelay,
        };
      }
      return;
    }
    case STEP.CONFIRMING: {
      phase.state.timer--;
      if (phase.state.timer <= 0) phase.state = { step: STEP.CONFIRMED };
      return;
    }
  }
}

/** True once the browse → dwell animation has completed and the AI has
 *  committed to its chosen home tower (terminal CONFIRMED step). */
export function isSelectionConfirmed(phase: SelectionPhase): boolean {
  return phase.state.step === STEP.CONFIRMED;
}
