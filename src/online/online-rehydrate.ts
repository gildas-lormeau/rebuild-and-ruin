/**
 * FULL_STATE application — drop a captured `FullStateMessage` into a
 * runtime so it can continue ticking from that moment. Two variants:
 * `applyMidGameCheckpoint` for a freshly-booted runtime (controllers
 * rebuilt, accums at zero; used by phase-test fixtures past round 1) and
 * `applyFullStateToRunningRuntime` for an already-running peer adopting
 * the new host's broadcast at host migration (controllers kept).
 */

import type { FullStateMessage } from "../protocol/protocol.ts";
import { clearBalloonFlights } from "../runtime/battle-anim.ts";
import {
  createAiController,
  ensureAiModulesLoaded,
  rollAiPersonality,
} from "../runtime/bootstrap.ts";
import type { GameRuntime } from "../runtime/handle.ts";
import { setMode } from "../runtime/state.ts";
import type { BalloonFlight } from "../shared/core/battle-types.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { PlayerId } from "../shared/core/player-slot.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  rebuildControllersForPhase,
  syncAccumulatorsFromTimer,
} from "./online-host-promotion.ts";
import { restoreFullStateSnapshot } from "./online-serialize.ts";

interface MidGameApplyResult {
  balloonFlights: { flight: BalloonFlight; progress: number }[];
}

/** Out-of-range slot id passed to `rebuildControllersForPhase` so every
 *  player slot is rebuilt as AI (no human gets to "keep" its controller).
 *  Headless tests have no human player; if a future caller needs to keep a
 *  human slot, extend with an `opts.myPlayerId` parameter. */
const ALL_SLOTS_AI = -1 as PlayerId;

/** Apply a `FullStateMessage` to a freshly-booted runtime. Composes the
 *  four steps that together make the runtime tickable from the captured
 *  moment:
 *    1. `restoreFullStateSnapshot` — lossless data restore (GameState,
 *       RNG, players' homeTower + castleWallTiles, modifier tiles).
 *    2. `rebuildControllersForPhase` — controllers from the fresh
 *       bootstrap are primed for round-1 selection; the captured phase
 *       needs different priming.
 *    3. `syncAccumulatorsFromTimer` — phase-timer accumulators ride
 *       from boot at zero, but `state.timer` is now mid-round; without
 *       resync the next tick would overwrite `state.timer`.
 *    4. `setMode` — `tick()` dispatches on `Mode`; staying at LOBBY/
 *       SELECTION blocks game ticks.
 *
 *  Returns null when validation rejects the message (no mutation). */
export async function applyMidGameCheckpoint(
  runtime: GameRuntime,
  msg: FullStateMessage,
): Promise<MidGameApplyResult | null> {
  const state = runtime.runtimeState.state;

  const result = restoreFullStateSnapshot(state, msg);
  if (!result) return null;

  runtime.runtimeState.controllers = await rebuildControllersForPhase(
    state,
    runtime.runtimeState.controllers,
    ALL_SLOTS_AI,
    {
      ensureLoaded: ensureAiModulesLoaded,
      rollPersonality: rollAiPersonality,
      create: createAiController,
    },
    undefined,
  );

  syncAccumulatorsFromTimer(state, runtime.runtimeState.accum);

  const balloonFlights = result.balloonFlights ?? [];
  setMode(
    runtime.runtimeState,
    resolveModeAfterFullState(state.phase, balloonFlights.length > 0),
  );

  return { balloonFlights };
}

/** Apply a `FullStateMessage` to an already-RUNNING runtime — the
 *  host-migration path on every surviving watcher (the new host
 *  broadcasts its state; receivers adopt it mid-tick). Controllers are
 *  kept (unlike `applyMidGameCheckpoint`, which rebuilds them for a
 *  fresh boot); local accumulators are resynced so the next
 *  `advancePhaseTimer` continues from the restored authoritative
 *  `state.timer` instead of overwriting it with `max - localAccum` — a
 *  cross-phase jump (migration straddling a phase boundary) would
 *  otherwise tick the new phase against a stale accum from the old one
 *  (e.g. last battle's elapsed → this battle ends instantly).
 *
 *  Production caller: `online/runtime/session.ts:restoreFullState`.
 *  The networked test harness wires this same function so watcher
 *  parity tests exercise the production apply path. */
export function applyFullStateToRunningRuntime(
  runtime: GameRuntime,
  msg: FullStateMessage,
): void {
  const state = runtime.runtimeState.state;
  const result = restoreFullStateSnapshot(state, msg);
  if (!result) return;

  syncAccumulatorsFromTimer(state, runtime.runtimeState.accum);

  const flights = result.balloonFlights ?? [];
  const inBattle = state.phase === Phase.BATTLE;
  setMode(
    runtime.runtimeState,
    resolveModeAfterFullState(state.phase, inBattle && flights.length > 0),
  );
  runtime.runtimeState.selection.castleBuilds = [];
  runtime.lifeLost.set(null);
  // Same teardown as the life-lost dialog: a pick dialog mid-flight when
  // the new host's snapshot lands is superseded — promotion force-resolves
  // the picks into the snapshot before broadcasting (promote.ts), so the
  // local dialog and its armed resolution callback must not survive the
  // apply. Leaving it would hand a stale, already-resolved dialog to the
  // NEXT round's `prepare()` (ensureDialog short-circuits on non-null) and
  // apply last round's picks there.
  runtime.upgradePick.set(null);
  runtime.runtimeState.frame.announcement = undefined;
  if (inBattle) runtime.runtimeState.battleAnim.flights = flights;
  else clearBalloonFlights(runtime.runtimeState.battleAnim);
}

/** Map a restored phase to the runtime Mode the main loop should dispatch.
 *  Shared by the fresh-boot and running-runtime apply paths above. */
function resolveModeAfterFullState(phase: Phase, hasBalloons: boolean): Mode {
  if (phase === Phase.CASTLE_SELECT) return Mode.SELECTION;
  if (phase === Phase.BATTLE && hasBalloons) return Mode.BALLOON_ANIM;
  return Mode.GAME;
}
