/**
 * FULL_STATE application — drop a captured `FullStateMessage` into a
 * runtime so it can continue ticking from that moment. Two variants:
 * `applyMidGameCheckpoint` for a freshly-booted runtime (controllers
 * rebuilt, accums at zero; used by phase-test fixtures past round 1) and
 * `applyFullStateToRunningRuntime` for an already-running peer adopting
 * the new host's broadcast at host migration (controllers kept).
 */

import { primeControllerForCannonPhase } from "../game/index.ts";
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
import { filterAliveEnclosedTowers } from "../shared/core/board-occupancy.ts";
import { Phase } from "../shared/core/game-phase.ts";
import type { PlayerId } from "../shared/core/player-slot.ts";
import { isPlayerAlive } from "../shared/core/player-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  rebuildControllersForPhase,
  redealPlayerBagsForAdoption,
  reprimeAiControllersForPhase,
  syncAccumulatorsFromTimer,
} from "./online-host-promotion.ts";
import {
  clearSeatSlots,
  type SeatTakeoverSession,
} from "./online-seat-takeover.ts";
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
  );

  syncAccumulatorsFromTimer(state, runtime.runtimeState.accum);

  const balloonFlights = result.balloonFlights ?? [];
  setMode(
    runtime.runtimeState,
    resolveModeAfterFullState(state.phase, balloonFlights.length > 0),
  );
  snapPitchToPhase(runtime, state.phase);

  return { balloonFlights };
}

/** Apply a `FullStateMessage` to an already-RUNNING runtime — the
 *  host-migration path on every surviving watcher (the new host
 *  broadcasts its state; receivers adopt it mid-tick). Controllers are
 *  kept (unlike `applyMidGameCheckpoint`, which rebuilds them for a
 *  fresh boot) — the new host keeps its controllers too, so AI identity
 *  stays a cross-peer contract across the migration; kept AI brains are
 *  re-primed from the adopted snapshot (`reprimeAiControllersForPhase`,
 *  same call the promoted host makes after serializing). Local
 *  accumulators are resynced so the next `advancePhaseTimer` continues
 *  from the restored authoritative `state.timer` instead of overwriting
 *  it with `max - localAccum` — a cross-phase jump (migration straddling
 *  a phase boundary) would otherwise tick the new phase against a stale
 *  accum from the old one (e.g. last battle's elapsed → this battle ends
 *  instantly).
 *
 *  `session` must expose the LIVE slot sets (not a frame-start
 *  snapshot): a departing-host seat parked in `pendingSeatTakeovers`
 *  must reconcile here against the snapshot tick so the re-prime treats
 *  it exactly like the new host did.
 *
 *  Production caller: `online/runtime/session.ts:restoreFullState`.
 *  The networked test harness wires this same function so watcher
 *  parity tests exercise the production apply path. */
export function applyFullStateToRunningRuntime(
  runtime: GameRuntime,
  msg: FullStateMessage,
  session: SeatTakeoverSession,
): void {
  const state = runtime.runtimeState.state;
  // Captured before the restore overwrites them — the self-human prime
  // below keys off where THIS peer was when the snapshot landed.
  const prePhase = state.phase;
  const preMode = runtime.runtimeState.mode;
  const result = restoreFullStateSnapshot(state, msg);
  if (!result) return;

  // The grunt step clock rides the message (third argument): it is the
  // one accumulator the resync cannot rebuild (cross-phase, not
  // derivable from state.timer), and the local copy ticked past the
  // snapshot by this peer's wire-delay skew — kept, it steps grunts at
  // different sim ticks than the new host. Absent only in pre-field
  // captures (fixtures), where keep-local is the recorded behavior.
  syncAccumulatorsFromTimer(state, runtime.runtimeState.accum, msg.gruntAccum);

  // Pending seat takeovers stamped at or before the snapshot tick: the
  // promoting host's pre-serialize drain already fired its copy (slot
  // flip + brain init baked into the snapshot's rng cursor), while OUR
  // queued copy is dropped unapplied by the discardUpTo below — and the
  // flip's session-side effect is not in the snapshot. Flip the slot
  // sets now, BEFORE the re-prime, so this peer re-primes the seat
  // exactly like the new host did post-serialize. Later/unstamped
  // entries stay parked: they fire at their stamped tick on every peer,
  // or get re-issued by the promotion flush (promote.ts).
  for (const [playerId, stamped] of session.pendingSeatTakeovers) {
    if (stamped === null || stamped > state.simTick) continue;
    clearSeatSlots(session, runtime.runtimeState.lobby.joined, playerId);
    session.pendingSeatTakeovers.delete(playerId);
  }

  // Kept AI brains restart from the adopted snapshot — right after the
  // rng restore, before anything else can draw, mirroring the promoted
  // host's post-serialize calls so both replay identical draws. Bags
  // first: the re-prime's build picks read the freshly-dealt piece.
  redealPlayerBagsForAdoption(state);
  reprimeAiControllersForPhase(
    state,
    runtime.runtimeState.controllers,
    session.remotePlayerSlots,
  );

  const flights = result.balloonFlights ?? [];
  const inBattle = state.phase === Phase.BATTLE;
  const balloonAnimPending = inBattle && flights.length > 0;
  primeSelfHumanControllersAfterAdoption(
    runtime,
    prePhase,
    preMode,
    balloonAnimPending,
  );

  // Discard scheduled actions the snapshot already contains. Entries
  // stamped at or before the snapshot's tick were drained into the
  // promoting host's state right before it serialized (promote.ts), and
  // the relay broadcasts in uniform order — anything queued HERE at
  // applyAt <= snapshot.simTick had reached the host too. Re-firing them
  // against the adopted state double-applies (a queued cannon fire spawns
  // a second ball; a queued selection confirm re-runs castle prep,
  // consuming adopted RNG on this peer only). Later-stamped entries stay:
  // every peer, the new host included, drains them at the same adopted
  // tick. Known residual: this peer's OWN action sent during the
  // migration window from a clock >SAFETY_TICKS behind the host's can be
  // discarded here yet reach the host after its snapshot — far narrower
  // than the double-apply class this discard removes.
  runtime.runtimeState.actionSchedule.discardUpTo(state.simTick);

  setMode(
    runtime.runtimeState,
    resolveModeAfterFullState(state.phase, balloonAnimPending),
  );
  runtime.runtimeState.selection.castleBuilds = [];
  runtime.lifeLost.set(null);
  // A score overlay mid-display when the snapshot lands is superseded the
  // same way: promotion fast-forwards the round-end chain into the
  // snapshot (`forceResolveRoundEndPhase`), so the local overlay's armed
  // `runDisplay` continuation must not survive the apply. The overlay
  // keeps ticking in the adopted gameplay mode — left armed, it fires
  // against the adopted post-round-end state and dispatches the round-end
  // routing from a phase the snapshot already advanced (source-phase
  // guard throw).
  runtime.scoreDelta.reset();
  // Same teardown as the life-lost dialog: a pick dialog mid-flight when
  // the new host's snapshot lands is superseded — promotion force-resolves
  // the picks into the snapshot before broadcasting (promote.ts), so the
  // local dialog and its armed resolution callback must not survive the
  // apply. Leaving it would hand a stale, already-resolved dialog to the
  // NEXT round's `prepare()` (ensureDialog short-circuits on non-null) and
  // apply last round's picks there.
  runtime.upgradePick.set(null);
  // The banner is the third armed display continuation (with the score
  // overlay and the dialogs above). It renders unconditionally while
  // non-null but ticks only in Mode.TRANSITION, so a sweep in progress
  // when the snapshot lands would freeze fullscreen over the adopted
  // game for the rest of the phase — and its armed `onDone` would
  // survive until the next local transition window (round-end's
  // score-overlay step never hides a stale banner) and fire the
  // torn-down chain's continuation over post-round-end state. Same
  // teardown the promoted host runs in promote.ts `clearAnimationState`.
  runtime.hideBanner();
  runtime.runtimeState.frame.announcement = undefined;
  if (inBattle) runtime.runtimeState.battleAnim.flights = flights;
  else clearBalloonFlights(runtime.runtimeState.battleAnim);
  // Reselect entry is purely local (no SELECT_START is broadcast
  // mid-game): a snapshot inside the reselect cycle can land on a peer
  // still parked in its own round-end display, which never entered
  // selection — unarmed, the adopted CASTLE_SELECT never resolves (zero
  // entries, nothing dispatches castle-done). Arm it for the players the
  // snapshot says are re-picking, derived with the same predicate the
  // life penalty used: alive with no alive enclosed tower (their zone
  // was reset; they have not rebuilt). The size gate keeps a peer that
  // entered the cycle locally (lockstep, the normal case) on its own
  // mid-cycle progress.
  if (state.phase === Phase.CASTLE_SELECT) {
    if (runtime.selection.getStates().size === 0) {
      runtime.selection.enter(
        state.players
          .filter(
            (player) =>
              isPlayerAlive(player) &&
              filterAliveEnclosedTowers(player, state).length === 0,
          )
          .map((player) => player.id),
      );
    } else {
      // Mid-cycle peer (the size gate above keeps its local pick
      // progress): re-derive confirmed flags + in-flight guards from the
      // adopted state, in case the discard above dropped a confirm the
      // snapshot already contains — left stale, that slot blocks
      // `allConfirmed` forever (see selection.reconcileAfterAdoption).
      runtime.selection.reconcileAfterAdoption();
    }
  }
  snapPitchToPhase(runtime, state.phase);
}

/** Mirror of promote.ts's cannon-entry / battle-intro repairs, for the
 *  ADOPTING peer's own seat. `reprimeAiControllersForPhase` covers kind
 *  "ai" slots only, and the `hideBanner()` teardown in the apply drops
 *  the entry banner's armed postDisplay (`initLocalCannonControllers` /
 *  `beginBattle`) — so a self human slot that never ran the adopted
 *  phase's entry init locally would play CANNON_PLACE with last round's
 *  cannon mode + cursor and no phantom seed, or BATTLE with a stale
 *  crosshair + rotation index. "Never ran it" = anything but
 *  already-mid-phase in the SAME phase (`Mode.GAME`) when the snapshot
 *  landed: the entry banner sweep, the balloon flyover, or a
 *  cross-boundary skew adoption landing in a phase this peer hasn't
 *  entered. Skipped when the adopted snapshot carries balloon flights —
 *  the flyover's end runs `beginBattle`, which primes every local slot.
 *  Controller-local writes only (cursor/mode/phantom/crosshair; human
 *  slots draw zero `state.rng`), so peers that skip this stay in parity
 *  — the promoted host has primed self-only this way since da8e3d51.
 *  WALL_BUILD needs no branch: its entry init runs in the transition's
 *  mutate (`startBuildPhaseLocal`), and `buildTick` re-derives cursor
 *  clamp + phantom from live state every tick. */
function primeSelfHumanControllersAfterAdoption(
  runtime: GameRuntime,
  prePhase: Phase,
  preMode: Mode,
  balloonAnimPending: boolean,
): void {
  const state = runtime.runtimeState.state;
  const missedCannonEntry =
    state.phase === Phase.CANNON_PLACE &&
    !(prePhase === Phase.CANNON_PLACE && preMode === Mode.GAME);
  const missedBattleEntry =
    state.phase === Phase.BATTLE &&
    !balloonAnimPending &&
    !(prePhase === Phase.BATTLE && preMode === Mode.GAME);
  if (!missedCannonEntry && !missedBattleEntry) return;
  for (const ctrl of runtime.runtimeState.controllers) {
    if (ctrl.kind !== "human") continue;
    const player = state.players[ctrl.playerId];
    if (!player || !isPlayerAlive(player)) continue;
    if (missedCannonEntry) primeControllerForCannonPhase(ctrl, state);
    else ctrl.initBattleState(state);
  }
}

/** Reconcile the camera pitch with the adopted phase. Pitch is local
 *  per-peer state, but it GATES sim dispatch: battle-done waits for the
 *  untilt ease to settle (phase-ticks), normally deterministic because
 *  every peer runs the same tilt choreography from the same transitions.
 *  A snapshot apply skips that choreography, so without the snap one
 *  peer can sit flat where the others are tilted — the next gate then
 *  dispatches the transition at different sim ticks per peer (and the
 *  adopted battle renders untilted). BATTLE is tilted from the moment
 *  the mode leaves TRANSITION (balloons run post-tilt-settle); every
 *  other phase is flat. */
function snapPitchToPhase(runtime: GameRuntime, phase: Phase): void {
  runtime.camera.snapPitchSettled(phase === Phase.BATTLE ? "tilted" : "flat");
}

/** Map a restored phase to the runtime Mode the main loop should dispatch.
 *  Shared by the fresh-boot and running-runtime apply paths above. */
function resolveModeAfterFullState(phase: Phase, hasBalloons: boolean): Mode {
  if (phase === Phase.CASTLE_SELECT) return Mode.SELECTION;
  if (phase === Phase.BATTLE && hasBalloons) return Mode.BALLOON_ANIM;
  return Mode.GAME;
}
