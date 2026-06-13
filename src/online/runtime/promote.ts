/**
 * Host promotion — runs when this client is promoted from watcher to host
 * after the previous host disconnects. Resets networking, syncs
 * accumulators, broadcasts the authoritative full state, re-primes the
 * kept AI controllers. Runtime injected via `initPromote()` (second of
 * three `initOnlineRuntime` init calls, between `initWs` and `initDeps`);
 * `promoteToHost()` throws if called first.
 */

import { primeControllerForCannonPhase } from "../../game/index.ts";
import { MESSAGE } from "../../protocol/protocol.ts";
import type { GameRuntime } from "../../runtime/handle.ts";
import { setMode } from "../../runtime/state.ts";
import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../../shared/core/action-schedule.ts";
import { Phase } from "../../shared/core/game-phase.ts";
import { assertNever } from "../../shared/platform/utils.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import {
  redealPlayerBagsForAdoption,
  reprimeAiControllersForPhase,
  syncAccumulatorsFromTimer,
} from "../online-host-promotion.ts";
import { scheduleSeatTakeover } from "../online-seat-takeover.ts";
import { createFullStateMessage } from "../online-serialize.ts";
import {
  type OnlineClient,
  RESET_SCOPE_HOST_PROMOTION,
} from "../online-stores.ts";

// ── Late-bound state ───────────────────────────────────────────────
let _runtime: GameRuntime;
let _client: OnlineClient;

/** Bind the GameRuntime reference. Called once from online/runtime/game.ts
 *  after the GameRuntime is created. */
export function initPromote(runtime: GameRuntime, client: OnlineClient): void {
  _runtime = runtime;
  _client = client;
}

/** Promote this client to host. Order matters:
 *  1. Reset networking (clear stale watcher/dedup state)
 *  2. Sync accumulators (align timing with game state timers)
 *  3. Skip pending UI animations (banner/balloon left over from old host)
 *  4. Broadcast full state (state must be coherent first)
 *  5. Re-prime kept AI controllers (AFTER the serialize — re-prime draws
 *     from state.rng, and watchers replay the same draws right after
 *     applying the snapshot, so both sides draw from the identical rng
 *     cursor the snapshot captured)
 *
 *  Controllers are KEPT, not rebuilt: this peer was mirror-ticking every
 *  AI slot as a watcher right up to this call, exactly like the other
 *  survivors — AI identity is a cross-peer contract and must not change
 *  on one peer only (see `reprimeAiControllersForPhase`).
 */
export function promoteToHost(): void {
  if (!_runtime) throw new Error("promoteToHost() called before initPromote()");
  _client.devLog("PROMOTING TO HOST");
  _client.ctx.session.isHost = true; // eslint-disable-line no-restricted-syntax -- host promotion

  _client.resetNetworking(RESET_SCOPE_HOST_PROMOTION);
  syncAccumulatorsFromTimer(
    _runtime.runtimeState.state,
    _runtime.runtimeState.accum,
  );
  skipPendingAnimations();

  // The round-end repair can route to game-over (the match was already
  // decided when the old host vanished mid-overlay). `endGame` stopped
  // the runtime and the game-over dispatch broadcast GAME_OVER; a
  // FULL_STATE on top would flip adopting watchers back to Mode.GAME
  // over the finished match.
  if (_runtime.runtimeState.mode === Mode.STOPPED) {
    _client.devLog("Promotion ended the match — skipping FULL_STATE");
    return;
  }

  // Drain (not discard) anything still queued at or before the current
  // tick so the snapshot includes its effects. Adopting watchers drop
  // every entry stamped <= snapshot.simTick on apply
  // (applyFullStateToRunningRuntime) on the premise that the snapshot
  // already contains it — an entry still queued here would otherwise
  // fire on the new host only, after the broadcast.
  _runtime.runtimeState.actionSchedule.drainUpTo(
    _runtime.runtimeState.state.simTick,
    _runtime.runtimeState.state,
  );
  _client.send(
    createFullStateMessage(
      _runtime.runtimeState.state,
      _client.ctx.session.hostMigrationSeq,
      _runtime.runtimeState.battleAnim.flights,
      _runtime.runtimeState.accum.grunt,
    ),
  );
  // AFTER the serialize, deliberately — see the ordering note in the
  // promoteToHost doc above. Bags first: the re-prime's build picks read
  // the freshly-dealt currentPiece.
  redealPlayerBagsForAdoption(_runtime.runtimeState.state);
  reprimeAiControllersForPhase(
    _runtime.runtimeState.state,
    _runtime.runtimeState.controllers,
    _client.ctx.session.remotePlayerSlots,
  );
  // Mid-CASTLE_SELECT promotion (including the round-end fast-forward
  // that just routed into a reselect cycle): the CASTLE_SELECT face of
  // the serialize-first/draw-after contract, which the reprime above
  // deliberately skips. Two paired repairs, mirrored by the adoption
  // apply on every watcher (online-rehydrate.ts):
  //  - Re-draw the unconfirmed seats' AI selection arming from the
  //    just-serialized rng cursor. The fast-forward's own entry draws
  //    ran BEFORE the serialize (they are baked into the snapshot's
  //    cursor and superseded here); a mid-cycle promotion's kept brains
  //    sit at this peer's local browse progress. Either way the only
  //    pose every peer can share is a fresh arming drawn from the
  //    snapshot cursor — adopters draw the identical stream right after
  //    applying (entry loop or re-arm).
  //  - Re-derive in-flight castle-build animations from state (the
  //    adopters' local queues are wiped on apply), restarting each
  //    ring's placement cadence at the snapshot tick. Kept, the
  //    promoted peer's walls land a few ticks ahead of every adopter
  //    and the cycle's exit dispatches at different sim ticks.
  if (_runtime.runtimeState.state.phase === Phase.CASTLE_SELECT) {
    _runtime.selection.rearmCycleControllersAfterAdoption(
      _client.ctx.session.remotePlayerSlots,
    );
    _runtime.selection.requeueCastleBuildsFromState();
  }
  flushPendingSeatTakeovers();
  _client.devLog("Promotion complete, now running as host");
}

/** Re-issue lockstep seat takeovers the dead host never stamped. A
 *  mid-game PLAYER_LEFT only parks the seat (online-server-lifecycle.ts);
 *  the live host stamps + broadcasts the flip. When the host itself died
 *  in that window — or WAS the leaver — every surviving peer holds an
 *  unstamped (null) pending entry, uniformly, and the seat still counts
 *  as remote through the adoption re-prime above. Stamp those now, AFTER
 *  the FULL_STATE broadcast: the new stamp is past the snapshot tick, so
 *  adopting watchers' `discardUpTo` leaves it queued and every peer fires
 *  the flip + brain init at the same tick. Already-stamped entries are
 *  left alone — the old host's broadcast reached every peer (uniform
 *  relay order), so their queued flips fire on schedule, and entries the
 *  snapshot already contains are healed by the adoption reconcile in
 *  online-rehydrate.ts. */
function flushPendingSeatTakeovers(): void {
  const session = _client.ctx.session;
  for (const [playerId, stamped] of session.pendingSeatTakeovers) {
    if (stamped !== null) continue;
    const applyAt =
      _runtime.runtimeState.state.simTick +
      DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
    scheduleSeatTakeover(
      {
        session,
        getLobbyJoined: () => _runtime.runtimeState.lobby.joined,
        schedule: (action) =>
          _runtime.runtimeState.actionSchedule.schedule(action),
        getControllers: () => _runtime.runtimeState.controllers,
        adoptDialogSeat: (pid) => _runtime.adoptDialogSeat(pid),
        log: _client.devLog,
      },
      playerId,
      applyAt,
    );
    _client.send({ type: MESSAGE.SEAT_TAKEOVER, playerId, applyAt });
    _client.devLog(`re-issued seat takeover: P${playerId} applyAt=${applyAt}`);
  }
}

/**
 * Skip any animations or dialogs that depend on the old host's state.
 * Delegates mode-specific cleanup to clearAnimationState, then sets Mode.GAME.
 */
function skipPendingAnimations(): void {
  // Captured before the teardown: the phase repairs below run only for
  // windows where the teardown just dropped the step that owned the
  // phase's progress.
  const modeAtPromotion = _runtime.runtimeState.mode;
  // Round-end display-window repair, BEFORE the generic teardown — the
  // teardown would destroy the very chain this repair fast-forwards.
  // Round-end's mutate already ran (finalizeRound + round++) but the
  // phase is still WALL_BUILD with an expired timer; the display chain
  // (score overlay → life-lost dialog) owns the exit routing. Torn down,
  // Mode.GAME's tickBuildPhase re-dispatches round-end next tick and
  // re-runs the mutate: double life penalties + double territory scoring
  // + a skipped round number, broadcast to every watcher. Fast-forward
  // the chain instead (see `forceResolveRoundEndPhase`) so the
  // FULL_STATE snapshot lands PAST round-end and ticks forward on its
  // own. The mode gate keeps the pre-dispatch edge case (Mode.GAME, the
  // tick that is about to dispatch round-end for the FIRST time) on the
  // normal path.
  if (
    _runtime.runtimeState.state.phase === Phase.WALL_BUILD &&
    _runtime.runtimeState.state.timer <= 0 &&
    (modeAtPromotion === Mode.TRANSITION || modeAtPromotion === Mode.LIFE_LOST)
  ) {
    _runtime.phaseTicks.resolveRoundEndNow();
    _client.devLog("Fast-forwarded round-end display → next phase");
    return;
  }
  const description = clearAnimationState(modeAtPromotion);
  if (description) {
    setMode(_runtime.runtimeState, Mode.GAME);
    _client.devLog(description);
  }
  // Battle-intro repair: promotion landing in the battle-entry display
  // windows — the enter-battle banner sweep (its sweep-end callback was
  // just dropped by hideBanner), the post-banner tilt wait (the parked
  // `awaitPitchSettled` continuation is superseded), or the balloon
  // flyover (its mode was just forced off) — tears down the step that
  // owned `proceedToBattleFromCtx` / `beginBattle`. Without the repair
  // the battle runs with no ready countdown, no controller battle-state
  // init for the kept slot, a flat camera, and lingering balloon
  // flights. Runs BEFORE the FULL_STATE broadcast so watchers adopt the
  // begun battle (full countdown, no flights → Mode.GAME on apply).
  if (
    _runtime.runtimeState.state.phase === Phase.BATTLE &&
    (modeAtPromotion === Mode.TRANSITION ||
      modeAtPromotion === Mode.BALLOON_ANIM)
  ) {
    // Pitch first: snaps to the battle pose AND drops the parked
    // `awaitPitchSettled` continuation — left armed, its settle edge
    // would re-run the intro a few ticks after this repair already did.
    _runtime.camera.snapPitchSettled("tilted");
    _runtime.phaseTicks.skipBattleIntro();
    _client.devLog("Skipped battle intro → battle begun");
  }
  // Battle-done untilt repair: promotion landing inside the pre-banner
  // untilt window (Mode.GAME — battle resolved, camera easing back to
  // flat before battle-done may dispatch). Adopting watchers snap to the
  // settled battle pose (`snapPitchToPhase` maps BATTLE → "tilted") and
  // restart the full ease at the first post-snapshot gate tick; the
  // promoted peer keeping its partial ease would settle — and dispatch
  // battle-done — that many ticks earlier, priming the next phase's
  // timer at offset sim ticks on each survivor (permanent phase-boundary
  // skew). Snap to the same settled pose BEFORE the broadcast so every
  // peer restarts the ease together. Cosmetic cost: the untilt replays
  // once from the top on the promoted peer.
  if (
    _runtime.runtimeState.state.phase === Phase.BATTLE &&
    modeAtPromotion === Mode.GAME &&
    _runtime.camera.getPitchState() !== "tilted"
  ) {
    _runtime.camera.snapPitchSettled("tilted");
    _client.devLog("Snapped mid-untilt pitch → settled battle pose");
  }
  // Cannon-entry repair: promotion landing in the enter-cannon-place
  // banner sweep — the teardown above just dropped the banner `onDone`
  // whose postDisplay runs `initLocalCannonControllers`. AI slots get
  // their prime from the post-broadcast `reprimeAiControllersForPhase`
  // in promoteToHost, but that skips the self slot (kind "human"), so
  // the promoted player would start the round with last round's cannon
  // mode + cursor and no phantom seed. Mirror `forceResolveRoundEndPhase`
  // (phase-machine.ts), which re-runs the init when it skips this same
  // banner — here only the self slot still needs it. No accum work:
  // enterCannonPhase primed `state.timer` in the mutate and
  // `syncAccumulatorsFromTimer` above already rebuilt the accums from it.
  if (
    _runtime.runtimeState.state.phase === Phase.CANNON_PLACE &&
    modeAtPromotion === Mode.TRANSITION
  ) {
    const selfCtrl =
      _runtime.runtimeState.controllers[_client.ctx.session.myPlayerId];
    // Undefined for a promoted spectator (no seat — the rebuild primed
    // every slot); eliminated self handled inside (primes nothing).
    if (selfCtrl) {
      primeControllerForCannonPhase(selfCtrl, _runtime.runtimeState.state);
      _client.devLog("Primed own cannon controller (banner window skip)");
    }
  }
  // Phase repair, after the mode teardown: UPGRADE_PICK is the only phase
  // with no self-driving timer — its exit is dispatched by the pick
  // dialog's resolution callback (modal window) or by the entry banner's
  // postDisplay arming that dialog (banner window), and the teardown above
  // just dropped whichever was pending. Left as-is, Mode.GAME's tickGame
  // no-ops the phase and every peer hangs forever. Force-resolve the picks
  // (same state-derived choice the max-timer backstop writes) and advance
  // to WALL_BUILD now, BEFORE the FULL_STATE broadcast — watchers must
  // receive a snapshot that ticks forward on its own.
  if (_runtime.runtimeState.state.phase === Phase.UPGRADE_PICK) {
    _runtime.phaseTicks.resolveUpgradePickNow();
    // The enter-wall-build dispatch armed its build banner and set
    // Mode.TRANSITION; the promoted peer skips transition cosmetics like
    // every teardown branch above.
    _runtime.hideBanner();
    setMode(_runtime.runtimeState, Mode.GAME);
    _client.devLog("Force-resolved upgrade picks → wall build");
  }
}

/** Clear mode-specific animation/dialog state left over from the old host.
 *  Returns a log description if state was cleared, null if no action was needed.
 *  Exhaustive switch ensures adding a new Mode is a compile error until handled. */
function clearAnimationState(mode: Mode): string | null {
  switch (mode) {
    case Mode.LIFE_LOST:
      _runtime.lifeLost.set(null);
      return "Cleared life-lost dialog → game mode";
    case Mode.TRANSITION:
    case Mode.BALLOON_ANIM:
      // Tear down banner state (callback + prevScene). Without
      // this, the old host's banner callback would fire after promotion
      // and invoke a stale closure against freshly-rebuilt controllers.
      _runtime.hideBanner();
      // Score-delta overlay can be mid-tick when promotion lands inside a
      // round-end transition. `reset` clears the timer AND the pending
      // `runDisplay` callback — leaving either would let the build phase
      // resume mid-overlay (gate at subsystems/phase-ticks.ts was the old
      // defense; this is the upstream fix) and fire a stale closure
      // against the torn-down transition.
      _runtime.scoreDelta.reset();
      return "Skipped phase transition/animation → game mode";
    case Mode.UPGRADE_PICK:
      // No teardown here: an open pick modal means state.phase is
      // UPGRADE_PICK, and the phase repair in skipPendingAnimations
      // consumes the dialog (force-resolve → enter-wall-build) and lands
      // the mode on GAME itself. Clearing the dialog here would discard
      // the picks made so far AND drop the armed resolution callback —
      // the only dispatcher of this phase's exit.
      return null;
    case Mode.GAME:
    case Mode.LOBBY:
    case Mode.OPTIONS:
    case Mode.CONTROLS:
    case Mode.SELECTION:
    case Mode.STOPPED:
      return null;
    default:
      assertNever(mode);
  }
}
