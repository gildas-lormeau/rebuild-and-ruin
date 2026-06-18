/** Cross-domain decision state for the inter-round dialog phases (life-lost,
 *  upgrade-pick). These structs are the shared scratchpad the AI controller,
 *  the runtime orchestrator, and the renderer all read and mutate as the
 *  dialog plays out — the AI drives the same `choice` / `focusedCard` /
 *  `pickedAtTimer` fields a human's input would, keeping AI play deterministic
 *  and watchable. They are decision state, not UI chrome (no `Mode` / ui dep),
 *  so they live in core alongside the controller contract that operates on
 *  them — the genuinely-UI dialog types stay in `shared/ui/interaction-types`. */

import type { ValidPlayerId } from "./player-slot.ts";
import type { UpgradeId } from "./upgrade-defs.ts";

export enum LifeLostChoice {
  PENDING = "pending",
  CONTINUE = "continue",
  ABANDON = "abandon",
}

export type ResolvedChoice = LifeLostChoice.CONTINUE | LifeLostChoice.ABANDON;

export interface LifeLostEntry {
  playerId: ValidPlayerId;
  lives: number;
  /** True when this entry auto-resolves (no local human input needed). */
  autoResolve: boolean;
  choice: LifeLostChoice;
  autoTimer: number;
  /** Which button is focused: LIFE_LOST_FOCUS_CONTINUE (0) or LIFE_LOST_FOCUS_ABANDON (1). */
  focusedButton: number;
}

export interface LifeLostDialogState {
  entries: LifeLostEntry[];
  timer: number;
}

export interface UpgradePickEntry {
  playerId: ValidPlayerId;
  offers: readonly [UpgradeId, UpgradeId, UpgradeId];
  choice: UpgradeId | null;
  /** True when this entry auto-resolves (no local human input needed). */
  autoResolve: boolean;
  autoTimer: number;
  /** Which offer card is focused (0, 1, or 2). */
  focusedCard: number;
  /** Dialog.timer value when `choice` flipped from null to set — drives the
   *  reveal pulse animation. null while pending. */
  pickedAtTimer: number | null;
}

export interface UpgradePickDialogState {
  entries: UpgradePickEntry[];
  timer: number;
}

export interface AutoResolveDeps {
  readonly remotePlayerSlots: ReadonlySet<ValidPlayerId>;
  /** True if this player's entry waits for local UI input (i.e. should
   *  NOT auto-resolve). Wired from the controller's
   *  `autoResolvesUpgradePick()` / `isHuman()` check depending on the
   *  dialog. */
  readonly needsLocalInput: (playerId: ValidPlayerId) => boolean;
}

/** Which button is focused in the life-lost dialog. */
export const LIFE_LOST_FOCUS_CONTINUE = 0;
export const LIFE_LOST_FOCUS_ABANDON = 1;

/** True when this player's dialog entry should auto-resolve (no local
 *  input needed): the slot is driven by a local AI controller AND not
 *  owned by a remote human. Role-independent — on every peer, a remote
 *  human's entry waits for the wire choice (lockstep `applyAt`; the
 *  `DIALOG_FORCE_GRACE` backstop covers a vanished owner), and
 *  mirror-simulated AI slots resolve locally from state. The old
 *  non-host branch (`playerId !== myPlayerId`) made non-host peers
 *  PREDICT a real remote human's choice with the locally-installed AI
 *  controller — forking the sims whenever the prediction disagreed with
 *  the human's actual pick. It dated from a never-built design where
 *  watchers received host-broadcast dialog state. */
export function shouldAutoResolve(
  playerId: ValidPlayerId,
  deps: AutoResolveDeps,
): boolean {
  return (
    !deps.needsLocalInput(playerId) && !deps.remotePlayerSlots.has(playerId)
  );
}
