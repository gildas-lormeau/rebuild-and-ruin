/**
 * Cross-peer desync detection (detection only, no recovery). The host samples its
 * shared-RNG cursor (`state.rng.getState()`, a pure read) each sim tick and sends
 * it tagged with the `simTick`; non-host peers compare against their OWN cursor at
 * the matching simTick (skewed peers → MUST key by simTick) and self-disconnect on
 * a mismatch, healing the room around the host. Post-R5b the cursor is board-
 * independent → a matching-tick mismatch is a true fork. See docs/runtime-invariants.md.
 */

import { MESSAGE, type ServerMessage } from "../protocol/protocol.ts";
import type { GameState } from "../shared/core/types.ts";

export interface HeartbeatMonitor {
  /** Call once per live sim tick, right after the action-schedule drain, on
   *  every peer. Records this peer's (simTick → rngState) and — when host —
   *  broadcasts a fingerprint every HEARTBEAT_INTERVAL_TICKS. */
  readonly recordTick: () => void;
  /** Feed an incoming server message. A non-host peer compares a host
   *  fingerprint against its own history at the matching simTick; everything
   *  else is ignored. */
  readonly onMessage: (msg: ServerMessage) => void;
  /** Drop all history + pending. Call when adopting a full-state checkpoint
   *  (migration / rejoin) so a comparison never crosses the discontinuity —
   *  the adopted simTick/rng would otherwise mismatch a stale pre-adoption
   *  history entry for the same tick. */
  readonly reset: () => void;
}

/** How often (in sim ticks) the host broadcasts a fingerprint. ~0.5s at 60Hz —
 *  detection latency, not a correctness knob; cheap to lower or raise. */
const HEARTBEAT_INTERVAL_TICKS = 30;
/** Sim-ticks of (simTick → rngState) history a non-host keeps for matching.
 *  Must exceed peer skew + wire latency + INTERVAL so a host fingerprint for
 *  tick T is still buffered when it arrives (~8.5s at 60Hz; skew is ≤7). */
const HISTORY_DEPTH_TICKS = 512;
/** Cap on buffered future host fingerprints (host ahead of this lagging peer).
 *  Stays tiny in practice — lockstep-debt replay catches the peer up fast. */
const MAX_PENDING = 64;

export function createHeartbeatMonitor(opts: {
  readonly getState: () => GameState | undefined;
  readonly amHost: () => boolean;
  readonly send: (msg: ServerMessage) => void;
  /** Surface a detected fork (logs the diverging tick, then self-disconnects).
   *  Called at most once — the monitor latches after firing. */
  readonly onDesync: (
    simTick: number,
    localRngState: number,
    hostRngState: number,
  ) => void;
}): HeartbeatMonitor {
  // simTick → rngState, in ascending insertion order (FIFO eviction).
  const history = new Map<number, number>();
  // Host fingerprints for ticks this peer has not reached yet.
  const pending = new Map<number, number>();
  let tripped = false;

  function compare(simTick: number, hostRngState: number): void {
    if (tripped) return;
    const localRngState = history.get(simTick);
    if (localRngState === undefined) return; // evicted / never recorded
    if (localRngState !== hostRngState) {
      tripped = true;
      opts.onDesync(simTick, localRngState, hostRngState);
    }
  }

  return {
    recordTick() {
      const state = opts.getState();
      if (!state) return;
      const simTick = state.simTick;
      const rngState = state.rng.getState();
      history.set(simTick, rngState);
      if (history.size > HISTORY_DEPTH_TICKS) {
        const oldest = history.keys().next().value;
        if (oldest !== undefined) history.delete(oldest);
      }
      // A host fingerprint for this exact tick may have arrived early (host
      // ahead of us); resolve it now that we have our own cursor for the tick.
      const earlyHost = pending.get(simTick);
      if (earlyHost !== undefined) {
        pending.delete(simTick);
        compare(simTick, earlyHost);
      }
      if (opts.amHost() && simTick % HEARTBEAT_INTERVAL_TICKS === 0) {
        opts.send({ type: MESSAGE.HEARTBEAT, simTick, rngState });
      }
    },

    onMessage(msg) {
      if (msg.type !== MESSAGE.HEARTBEAT) return;
      // The host is the anchor — it never self-checks against its own (relayed)
      // heartbeat. After a host migration `amHost()` flips live, so a freshly
      // promoted host stops comparing and starts emitting on the next tick.
      if (opts.amHost()) return;
      if (history.has(msg.simTick)) {
        compare(msg.simTick, msg.rngState);
        return;
      }
      // Host is ahead of this peer — stash until our sim reaches the tick.
      pending.set(msg.simTick, msg.rngState);
      if (pending.size > MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
    },

    reset() {
      history.clear();
      pending.clear();
    },
  };
}
