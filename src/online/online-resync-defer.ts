/**
 * Host-side deferred ROOM-WIDE resync for a rejoiner (HIGH-2 step 3c-2). A
 * targeted resync can't re-prime AI in parity, so a rejoin runs the
 * host-migration mechanism: the host re-broadcasts to the whole room and every
 * peer adopts + reprimes in lockstep. DEFERRED to `requestTick + SAFETY` so the
 * rejoiner's skipped in-flight actions are drained into the snapshot first.
 */

import type { FullStateMessage } from "../protocol/protocol.ts";
import type { GameRuntime } from "../runtime/handle.ts";
import { Phase } from "../shared/core/game-phase.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  redealPlayerBagsForAdoption,
  reprimeAiControllersForPhase,
  syncAccumulatorsFromTimer,
} from "./online-host-promotion.ts";
import { createFullStateMessage } from "./online-serialize.ts";
import type { OnlineSession } from "./online-session.ts";

export interface DeferredResyncDeps {
  runtime: GameRuntime;
  session: Pick<
    OnlineSession,
    "pendingResyncRequests" | "hostMigrationSeq" | "remotePlayerSlots"
  >;
  /** Host fan-out — BROADCAST (no `forPlayerId`): every peer adopts it. */
  send: (msg: FullStateMessage) => void;
}

/** Per-frame host poll (composition `onAfterFrame`, online + host only).
 *  Fires ONE room-wide rebroadcast once EVERY parked request's fire tick has
 *  arrived AND the host sits in a phase whose snapshot the migration adoption
 *  path can apply cleanly (Mode.GAME / Mode.SELECTION) — a snapshot taken
 *  mid-banner/dialog would carry an animation/callback the adopters can't
 *  reconstruct. One broadcast serves every pending rejoiner, each in-window. */
export function pollDeferredResyncs(deps: DeferredResyncDeps): void {
  const { pendingResyncRequests } = deps.session;
  if (pendingResyncRequests.size === 0) return;
  const runtimeState = deps.runtime.runtimeState;
  // Wait for a clean phase: the migration snapshot/apply pair only covers the
  // self-driving phases. Dialog/transition windows resolve within a few ticks;
  // the rejoiner just waits for them. This gate is also why the resync sender
  // needs no `supersedeDialogsForSnapshot` call (unlike `promoteToHost`, which
  // cannot defer): a snapshot is never sent from here while a dialog is open,
  // so there is no sender-side dialog state to discard.
  if (runtimeState.mode !== Mode.GAME && runtimeState.mode !== Mode.SELECTION) {
    return;
  }
  const simTick = runtimeState.state.simTick;
  // Wait until EVERY parked request's window has closed (simTick >= the LATEST
  // fireAtTick), not just the earliest. The single broadcast is drained only to
  // `simTick`, and a rejoiner adopts ANY FULL_STATE while awaitingRejoinResync
  // (online-server-lifecycle.ts) regardless of this host-side map — so firing
  // at the FIRST due request would hand a later, still-in-window rejoiner an
  // under-drained snapshot (missing its pre-connect in-flight actions) → fork.
  // Bounded: <=2 parked (3 players - host), so the extra wait is <=SAFETY ticks
  // and two concurrent rejoiners share one self-migration instead of two.
  for (const fireAtTick of pendingResyncRequests.values()) {
    if (simTick < fireAtTick) return;
  }
  pendingResyncRequests.clear();
  rebroadcastFullStateForResync(deps);
}

/** Re-broadcast the authoritative state to the whole room as a no-op host
 *  "self-migration". Mirrors `promoteToHost`'s serialize/reprime core (minus
 *  the host flip + the dead-host animation teardown): bump the migration seq
 *  so adopters treat it as a migration, drain queued actions into the
 *  snapshot, serialize + broadcast, THEN reprime — adopters replay the
 *  identical post-serialize draws on apply, so every peer lands on the same
 *  `state.rng` cursor. */
function rebroadcastFullStateForResync(deps: DeferredResyncDeps): void {
  const { runtime, session, send } = deps;
  const runtimeState = runtime.runtimeState;
  session.hostMigrationSeq++;
  syncAccumulatorsFromTimer(runtimeState.state, runtimeState.accum);
  runtimeState.actionSchedule.drainUpTo(
    runtimeState.state.simTick,
    runtimeState.state,
  );
  send(
    createFullStateMessage(
      runtimeState.state,
      session.hostMigrationSeq,
      runtimeState.battleAnim.flights,
      runtimeState.accum.grunt,
      // Inert under the Mode.GAME/SELECTION gate above (never mid-ROUND_END,
      // so the serializer's phase gate drops it) — passed for parity with
      // the promotion sender, the honest value either way.
      runtimeState.roundEnd,
    ),
  );
  // AFTER the serialize — see the ordering note in promote.ts. Bags first so
  // the reprime's build picks read the freshly-dealt currentPiece.
  redealPlayerBagsForAdoption(runtimeState.state);
  reprimeAiControllersForPhase(
    runtimeState.state,
    runtimeState.controllers,
    session.remotePlayerSlots,
  );
  // CASTLE_SELECT face of the serialize-first/draw-after contract, mirrored by
  // the adoption apply (online-rehydrate.ts) — same pair promoteToHost runs.
  if (runtimeState.state.phase === Phase.CASTLE_SELECT) {
    runtime.selection.rearmCycleControllersAfterAdoption(
      session.remotePlayerSlots,
    );
    runtime.selection.requeueCastleBuildsFromState();
  }
}
