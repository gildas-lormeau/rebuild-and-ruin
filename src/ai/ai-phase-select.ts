/**
 * AI selection-phase state machine — tower browsing and confirmation.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { selectPlayerTower } from "../game/game-engine.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import type { GameState } from "../shared/types.ts";
import { STEP } from "./ai-constants.ts";
import type { AiStrategy } from "./ai-strategy.ts";

/** Minimal subset of AiController needed by this phase module.
 *  Convention: each ai-phase-*.ts defines its own Host interface to decouple
 *  phase logic from the full controller, keeping modules independently testable. */
interface SelectionHost {
  readonly playerId: ValidPlayerSlot;
  readonly strategy: AiStrategy;
  /** Returns `(base + rng * spread) * delayScale` — humanizes AI timing per difficulty. */
  scaledDelay(base: number, spread: number): number;
}

type AiSelectionState =
  | { step: typeof STEP.IDLE }
  | {
      step: typeof STEP.BROWSING;
      queue: number[];
      browseTimer: number;
      confirmInitialDelay: number;
    }
  | { step: typeof STEP.CONFIRMING; timer: number };

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
  state: GameState,
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
  state?: GameState,
): boolean {
  switch (phase.state.step) {
    case STEP.IDLE:
      return false;
    case STEP.BROWSING: {
      const bs = phase.state;
      bs.browseTimer -= dt;
      if (bs.browseTimer <= 0 && bs.queue.length > 1) {
        bs.queue.shift();
        bs.browseTimer = host.scaledDelay(0.8, 0.6);
        if (state) {
          const nextIdx = bs.queue[0];
          const nextTower =
            nextIdx !== undefined ? state.map.towers[nextIdx] : undefined;
          const browsePlayer = state.players[host.playerId];
          if (nextTower && browsePlayer)
            selectPlayerTower(browsePlayer, nextTower);
        }
        return false;
      }
      if (bs.queue.length <= 1) {
        phase.state = { step: STEP.CONFIRMING, timer: bs.confirmInitialDelay };
      }
      return false;
    }
    case STEP.CONFIRMING: {
      phase.state.timer -= dt;
      return phase.state.timer <= 0;
    }
  }
}
