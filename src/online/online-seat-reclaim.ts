/**
 * Lockstep seat reclaim — the exact inverse of `online-seat-takeover.ts`.
 * A seat an AI took over (its human left) is handed BACK to that human
 * after they rejoin: the host stamps `applyAt = simTick + SAFETY` and
 * broadcasts SEAT_RECLAIM; every peer flips the seat sets at that tick.
 * See `applySeatReclaim` for the owner-vs-remote asymmetry and why the
 * stamp (not the controller swap) is the only lockstep-critical step.
 */

import type {
  ActionSchedule,
  ScheduledAction,
} from "../shared/core/action-schedule.ts";
import type { ValidPlayerId } from "../shared/core/player-slot.ts";
import type { GameState } from "../shared/core/types.ts";
import type { OnlineSession } from "./online-session.ts";

/** Session slice the reclaim mutates — the slot-set pair plus the local
 *  seat id that decides owner vs. remote. `lobby.joined` (the triple's
 *  third leg) rides separately via `getLobbyJoined`, matching
 *  `SeatTakeoverSession`. Not exported until a cross-module consumer
 *  lands (the 3c rejoin wiring). */
type SeatReclaimSession = Pick<
  OnlineSession,
  "remotePlayerSlots" | "occupiedSlots" | "myPlayerId"
>;

export interface SeatReclaimDeps {
  session: SeatReclaimSession;
  /** Live lobby.joined array — re-read per apply (swapped per room). */
  getLobbyJoined: () => boolean[];
  schedule: ActionSchedule<GameState>["schedule"];
  /** Owner-only, rng-neutral hook: swap the reclaimed seat's dormant
   *  mirror-sim AI controller for the returning human's controller and
   *  wire up its input. Called inside the lockstep apply ONLY when
   *  `playerId === session.myPlayerId`. Safe to run at any tick relative
   *  to the flip because it consumes no `state.rng` — the flip itself is
   *  the only lockstep-critical step. */
  installOwnerController: (playerId: ValidPlayerId, state: GameState) => void;
  log: (msg: string) => void;
}

/** Park the stamped reclaim on the lockstep queue (host at
 *  REQUEST_SEAT_RECLAIM receipt, watchers + the rejoiner at SEAT_RECLAIM
 *  receipt). Idempotent at apply time, so a duplicate stamp — re-issued
 *  across a host migration, say — is harmless. */
export function scheduleSeatReclaim(
  deps: SeatReclaimDeps,
  playerId: ValidPlayerId,
  applyAt: number,
): void {
  const action: ScheduledAction<GameState> = {
    applyAt,
    playerId,
    apply: (state) => applySeatReclaim(state, playerId, deps),
  };
  deps.schedule(action);
}

/** The lockstep flip: runs inside the drain at the stamped tick on every
 *  peer. Re-seats the slot (occupiedSlots + lobby.joined); on the owner it
 *  installs the human controller and stays local, on everyone else it
 *  re-enters `remotePlayerSlots` so the seat is wire-driven again. */
function applySeatReclaim(
  state: GameState,
  playerId: ValidPlayerId,
  deps: SeatReclaimDeps,
): void {
  const { session } = deps;
  // Idempotent: the seat is unoccupied exactly while an AI holds it
  // (takeover cleared it). Once re-seated, a re-applied reclaim is a no-op.
  if (session.occupiedSlots.has(playerId)) return;
  session.occupiedSlots.add(playerId);
  deps.getLobbyJoined()[playerId] = true;
  if (playerId === session.myPlayerId) {
    // Owner (the rejoiner): drive locally — stays OUT of remotePlayerSlots
    // so the tick loop runs its controller; swap dormant AI → human.
    deps.installOwnerController(playerId, state);
    deps.log(
      `seat_reclaim applied: P${playerId} → local human @${state.simTick}`,
    );
    return;
  }
  // Non-owner: the seat is a remote human again — into remotePlayerSlots
  // (preserving remotePlayerSlots ⊆ occupiedSlots) so the tick loop stops
  // mirror-simulating it and applies the owner's wire actions instead.
  session.remotePlayerSlots.add(playerId);
  deps.log(
    `seat_reclaim applied: P${playerId} → remote human @${state.simTick}`,
  );
}
