/**
 * AI life-lost decision.
 *
 * Mirrors ai-upgrade-pick.ts — owns the AI decision for the life-lost
 * dialog so `game/life-lost.ts` doesn't hard-code a choice. Today the
 * AI always picks CONTINUE; future strategies (surrender when hopeless,
 * abandon low-score games) hook in here.
 */

import type { GameViewState } from "../shared/core/system-interfaces.ts";
import {
  LifeLostChoice,
  type LifeLostEntry,
  type ResolvedChoice,
} from "../shared/ui/interaction-types.ts";

/** AI decision for a pending life-lost entry. */
export function aiChooseLifeLost(
  _entry: LifeLostEntry,
  _state: GameViewState,
): ResolvedChoice {
  return LifeLostChoice.CONTINUE;
}
