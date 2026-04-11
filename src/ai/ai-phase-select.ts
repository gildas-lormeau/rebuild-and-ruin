/**
 * AI selection-phase state machine — tower browsing and confirmation.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { selectPlayerTower } from "../game/index.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { GameViewState } from "../shared/system-interfaces.ts";
import { STEP } from "./ai-constants.ts";
import type { AiStrategy } from "./ai-strategy.ts";

/** Minimal subset of AiController needed by this phase module.
 *  Convention: each ai-phase-*.ts defines its own Host interface to decouple
 *  phase logic from the full controller, keeping modules independently testable.
 *  Exported so controller-ai.ts can statically assert AiController implements
 *  every phase's Host (see the `satisfies` check at the bottom of that file). */
export interface SelectionHost {
  readonly playerId: ValidPlayerSlot;
  readonly strategy: AiStrategy;
  /** Returns `(base + rng * spread) * delayScale` — humanizes AI timing per difficulty. */
  scaledDelay(base: number, spread: number): number;
}

type AiSelectionState =
  | { step: "idle" }
  | {
      step: "browsing";
      queue: number[];
      browseTimer: number;
      confirmInitialDelay: number;
    }
  | { step: "confirming"; timer: number };

interface SelectionPhase {
  state: AiSelectionState;
}

export function createSelectionPhase(): SelectionPhase {
  return { state: { step: STEP.IDLE } };
}

export function resetSelectionPhase(phase: SelectionPhase): void {
  phase.state = { step: STEP.IDLE };
}

/** Pick a tower and begin the browse → confirm animation. */
export function initSelection(
  host: SelectionHost,
  phase: SelectionPhase,
  state: GameViewState,
  zone: number,
): void {
  const player = state.players[host.playerId];
  if (!player) return;
  const chosenTower = host.strategy.chooseBestTower(state.map, zone);

  // Build browse queue: visit 1-3 random zone towers before the chosen one
  const zoneTowers = state.map.towers.filter((tower) => tower.zone === zone);
  const others = zoneTowers.filter((tower) => tower !== chosenTower);
  const browseCount = Math.min(
    others.length,
    1 + Math.floor(host.strategy.rng.next() * 3),
  );
  // Shuffle and take browseCount
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(host.strategy.rng.next() * (i + 1));
    [others[i], others[j]] = [others[j]!, others[i]!];
  }
  const queue = others.slice(0, browseCount).map((tower) => tower.index);
  if (chosenTower) queue.push(chosenTower.index);

  phase.state = {
    step: STEP.BROWSING,
    queue,
    browseTimer: host.scaledDelay(0.8, 0.6),
    confirmInitialDelay: host.scaledDelay(1.0, 0.6),
  };

  // Start at first tower in browse queue
  const firstIdx = queue[0];
  const firstTower =
    firstIdx !== undefined ? state.map.towers[firstIdx] : chosenTower;
  if (firstTower) selectPlayerTower(player, firstTower);
}

/** Advance the selection state machine. Returns true when confirmed. */
export function tickSelection(
  host: SelectionHost,
  phase: SelectionPhase,
  dt: number,
  // Optional: selection phase can tick without state during initial lobby setup.
  state?: GameViewState,
): boolean {
  switch (phase.state.step) {
    case STEP.IDLE:
      return false;
    case STEP.BROWSING: {
      const battleState = phase.state;
      battleState.browseTimer -= dt;
      if (battleState.browseTimer <= 0 && battleState.queue.length > 1) {
        battleState.queue.shift();
        battleState.browseTimer = host.scaledDelay(0.8, 0.6);
        if (state) {
          const nextIdx = battleState.queue[0];
          const nextTower =
            nextIdx !== undefined ? state.map.towers[nextIdx] : undefined;
          const browsePlayer = state.players[host.playerId];
          if (nextTower && browsePlayer)
            selectPlayerTower(browsePlayer, nextTower);
        }
        return false;
      }
      if (battleState.queue.length <= 1) {
        phase.state = {
          step: STEP.CONFIRMING,
          timer: battleState.confirmInitialDelay,
        };
      }
      return false;
    }
    case STEP.CONFIRMING: {
      phase.state.timer -= dt;
      return phase.state.timer <= 0;
    }
  }
}
