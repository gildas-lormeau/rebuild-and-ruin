/**
 * Lockstep seat takeover — a departed player's seat flips to local AI
 * at a tick every peer shares. PLAYER_LEFT receipt is wall-clock, and
 * flipping the slot sets there races the tick-synchronized boundary
 * instants that read them (phase-entry init, dialog autoResolve freeze,
 * selection entry). The host stamps `applyAt = simTick + SAFETY`,
 * broadcasts SEAT_TAKEOVER; every peer applies flip + brain init at it.
 */

import type {
  ActionSchedule,
  ScheduledAction,
} from "../shared/core/action-schedule.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import { isPlayerEliminated } from "../shared/core/player-types.ts";
import type { PlayerController } from "../shared/core/system-interfaces.ts";
import type { GameState } from "../shared/core/types.ts";
import { primeAiControllerForPhase } from "./online-host-promotion.ts";
import type { OnlineSession } from "./online-session.ts";

/** Session slice the takeover mutates — the slot-set pair plus the
 *  pending ledger. `lobby.joined` (the triple's third leg) rides
 *  separately via `getLobbyJoined` because the lobby array is swapped
 *  per room, not per session. */
export type SeatTakeoverSession = Pick<
  OnlineSession,
  "remotePlayerSlots" | "occupiedSlots" | "pendingSeatTakeovers"
>;

export interface SeatTakeoverDeps {
  session: SeatTakeoverSession;
  /** Live lobby.joined array — re-read per apply (swapped per room). */
  getLobbyJoined: () => boolean[];
  schedule: ActionSchedule<GameState>["schedule"];
  getControllers: () => readonly PlayerController[];
  /** Adopt the seat's open life-lost / upgrade-pick entry to the
   *  just-installed takeover AI (`GameRuntime.adoptDialogSeat`). Without
   *  it a mid-dialog takeover stalls the entry to the max-timer ABANDON. */
  adoptDialogSeat: (playerId: ValidPlayerId) => void;
  log: (msg: string) => void;
}

/** Park the stamped flip on the lockstep queue (host at PLAYER_LEFT
 *  receipt, watchers at SEAT_TAKEOVER receipt, the promoted host's
 *  pending flush). Overwrites an unstamped pending entry with the
 *  shared tick; duplicate stamps are harmless — the apply's
 *  `remotePlayerSlots` guard makes the second a no-op. */
export function scheduleSeatTakeover(
  deps: SeatTakeoverDeps,
  playerId: ValidPlayerId,
  applyAt: number,
): void {
  deps.session.pendingSeatTakeovers.set(playerId, applyAt);
  const action: ScheduledAction<GameState> = {
    applyAt,
    playerId,
    apply: (state) => applySeatTakeover(state, playerId, deps),
  };
  deps.schedule(action);
}

/** The lockstep flip: runs inside the drain at the stamped tick on every
 *  peer. A takeover mid-phase is a one-seat adoption — the brain restarts
 *  from the live state at a shared tick, drawing from the same
 *  `state.rng` cursor on every peer. During CASTLE_SELECT the brain init
 *  is skipped (`primeAiControllerForPhase`): the seat's frozen-remote
 *  selection entry resolves via the cycle's timer backstop, uniformly.
 *  An open life-lost / upgrade-pick entry is adopted to the takeover AI
 *  (`adoptDialogSeat`): its `autoResolve` was frozen to the departed
 *  human, so left alone it would stall to the max-timer ABANDON instead
 *  of the AI playing the seat. The flip is shared-RNG-neutral. */
function applySeatTakeover(
  state: GameState,
  playerId: ValidPlayerId,
  deps: SeatTakeoverDeps,
): void {
  if (!deps.session.remotePlayerSlots.has(playerId)) return;
  clearSeatSlots(deps.session, deps.getLobbyJoined(), playerId);
  deps.session.pendingSeatTakeovers.delete(playerId);
  deps.log(`seat_takeover applied: P${playerId} → local AI @${state.simTick}`);
  const ctrl = deps.getControllers()[playerId];
  const player = state.players[playerId];
  if (!ctrl || ctrl.kind !== "ai" || !player || isPlayerEliminated(player)) {
    return;
  }
  primeAiControllerForPhase(state, ctrl);
  // Hand any open life-lost / upgrade-pick entry for this seat to the AI
  // we just primed, so it plays the dialog instead of the entry stalling
  // to the max-timer ABANDON. Runs at the shared drain tick on every peer.
  deps.adoptDialogSeat(playerId);
}

/** Flip the slot-set triple in one place — the lifecycle handler's
 *  clearLobbySlot invariant (occupiedSlots, remotePlayerSlots, and
 *  lobby.joined always mutate together), shared with the adoption
 *  reconcile in online-rehydrate.ts. */
export function clearSeatSlots(
  session: SeatTakeoverSession,
  lobbyJoined: boolean[],
  playerId: ValidPlayerId,
): void {
  lobbyJoined[playerId] = false;
  session.occupiedSlots.delete(playerId);
  session.remotePlayerSlots.delete(playerId);
}
