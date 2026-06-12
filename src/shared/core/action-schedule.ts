/**
 * Lockstep scheduled-actions queue. Wire-broadcast inputs enqueue on
 * originator + receiver with `applyAt = senderSimTick + SAFETY` and fire in
 * `(applyAt, playerId)` order on every peer. Replaces "apply-now, broadcast,
 * apply-on-receipt" — that pattern let order-sensitive logic
 * (recheckTerritory → grunt RNG) diverge when the receiver applied later.
 */

import type { ValidPlayerId } from "./player-slot.ts";

export interface ScheduledAction<S> {
  /** Logical sim tick at which this action fires. Both originator and
   *  receiver schedule with the same `applyAt` so they fire in lockstep. */
  applyAt: number;
  /** Within-tick ordering tiebreaker. Conventionally the player slot id
   *  whose input produced this action — guarantees a total order across
   *  peers regardless of wire arrival order. */
  playerId: ValidPlayerId;
  /** Mutates state. Called exactly once when the action fires. */
  apply: (state: S) => void;
}

export interface ActionSchedule<S> {
  /** Enqueue an action. Order of enqueue is irrelevant — the drain sort
   *  ensures deterministic apply order. */
  schedule: (action: ScheduledAction<S>) => void;
  /** Apply every queued action whose `applyAt <= simTick`, in
   *  `(applyAt, playerId)` order. */
  drainUpTo: (simTick: number, state: S) => void;
  /** Drop queued actions with `applyAt <= simTick` WITHOUT applying them.
   *  Host-migration adoption: entries at or before the adopted snapshot's
   *  tick are already baked into the snapshot (the promoting host drains
   *  its queue right before serializing), so re-applying them would
   *  double-fire; entries after it are still-valid lockstep actions every
   *  peer — the new host included — drains at the same adopted tick, so a
   *  blanket `reset` would drop them on adopters only. */
  discardUpTo: (simTick: number) => void;
  /** Pending count. Test-only; production code should not branch on this. */
  size: () => number;
  /** Drop all queued actions (e.g. on rematch / returnToLobby). */
  reset: () => void;
}

/** Lockstep buffer depth in sim ticks. Must exceed the worst-case
 *  cross-peer wire latency. At 60Hz sim this absorbs ~133ms of jitter,
 *  comfortably above typical LAN/WAN WebSocket round-trips. Hardcoded —
 *  every originator stamps with this same constant. */
export const DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS = 8;

export function createActionSchedule<S>(): ActionSchedule<S> {
  const queue: ScheduledAction<S>[] = [];

  return {
    schedule(action) {
      queue.push(action);
    },
    drainUpTo(simTick, state) {
      if (queue.length === 0) return;
      queue.sort((a, b) =>
        a.applyAt !== b.applyAt
          ? a.applyAt - b.applyAt
          : a.playerId - b.playerId,
      );
      let drained = 0;
      while (drained < queue.length && queue[drained]!.applyAt <= simTick) {
        queue[drained]!.apply(state);
        drained++;
      }
      if (drained > 0) queue.splice(0, drained);
    },
    discardUpTo(simTick) {
      for (let idx = queue.length - 1; idx >= 0; idx--) {
        if (queue[idx]!.applyAt <= simTick) queue.splice(idx, 1);
      }
    },
    size() {
      return queue.length;
    },
    reset() {
      queue.length = 0;
    },
  };
}
