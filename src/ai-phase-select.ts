/**
 * AI selection-phase state machine — tower browsing and confirmation.
 *
 * Extracted from AiController so each phase's logic is independently
 * readable and testable.
 */

import { Step } from "./ai-constants.ts";
import type { AiStrategy } from "./ai-strategy.ts";
import { selectPlayerTower } from "./game-engine.ts";
import type { GameState } from "./types.ts";

/** Subset of AiController accessed by selection-phase logic. */
interface SelectionHost {
  readonly playerId: number;
  readonly strategy: AiStrategy;
  scaledDelay(base: number, spread: number): number;
}

type SelectionState =
  | { step: typeof Step.IDLE }
  | {
      step: typeof Step.BROWSING;
      queue: number[];
      dwell: number;
      confirmDelay: number;
    }
  | { step: typeof Step.CONFIRMING; timer: number };

interface SelectionPhase {
  state: SelectionState;
}

export function createSelectionPhase(): SelectionPhase {
  return { state: { step: Step.IDLE } };
}

export function resetSelectionPhase(phase: SelectionPhase): void {
  phase.state = { step: Step.IDLE };
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
  const chosenTower = host.strategy.selectTower(state.map, zone);

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
    step: Step.BROWSING,
    queue,
    dwell: host.scaledDelay(0.8, 0.6),
    confirmDelay: host.scaledDelay(1.0, 0.6),
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
  state?: GameState,
): boolean {
  switch (phase.state.step) {
    case Step.IDLE:
      return false;
    case Step.BROWSING: {
      const bs = phase.state;
      bs.dwell -= dt;
      if (bs.dwell <= 0 && bs.queue.length > 1) {
        bs.queue.shift();
        bs.dwell = host.scaledDelay(0.8, 0.6);
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
        phase.state = { step: Step.CONFIRMING, timer: bs.confirmDelay };
      }
      return false;
    }
    case Step.CONFIRMING: {
      phase.state.timer -= dt;
      return phase.state.timer <= 0;
    }
  }
}
