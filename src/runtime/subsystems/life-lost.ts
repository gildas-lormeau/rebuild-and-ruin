import {
  LifeLostChoice,
  type LifeLostDialogState,
  type LifeLostEntry,
  type ResolvedChoice,
} from "../../shared/core/dialog-state.ts";
import {
  DIALOG_FORCE_GRACE,
  LIFE_LOST_AUTO_DELAY,
  LIFE_LOST_MAX_TIMER,
} from "../../shared/core/game-constants.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import {
  adoptDialogEntryToAi,
  findPendingDialogEntry,
  isLocallyDrivenEntry,
  scheduleOrApplyDialogChoice,
} from "../dialogs/dialog-tick.ts";
import {
  abandonedPlayers,
  applyLifeLostChoice,
  applyOrQueueLifeLostChoice,
  continuingPlayers,
  createLifeLostDialogState,
  focusedLifeLostChoice,
  isLifeLostAllResolved,
  tickLifeLostDialog,
  toggleLifeLostFocus,
} from "../dialogs/life-lost-core.ts";
import { lockstepStampTick, type RuntimeState, setMode } from "../state.ts";

/** Public life-lost dialog handle exposed on `GameRuntime`. Tick scope:
 *  gated on `Mode.LIFE_LOST` (the runtime ticks this when the popup is
 *  active). Sibling dialog handle in `RuntimeUpgradePick`. */
export interface RuntimeLifeLost {
  /** Read current dialog state. Used by input-gate and remote-choice
   *  handlers to check whether a dialog is active. */
  get: () => LifeLostDialogState | null;
  /** Replace dialog state. Only ever called with `null` in production
   *  (session reset / host promote / teardown) — dialogs are always built
   *  locally on every peer, never received over the wire. Passing `null`
   *  also clears any pending `onResolved` callback so a force-clear
   *  (rematch, host-promote) can't fire it later. */
  set: (d: LifeLostDialogState | null) => void;
  /** Build + show the life-lost dialog: create the dialog, then either
   *  hold a button-less "Eliminated" notice for a short dwell when every
   *  entry is pre-resolved (only eliminations, no Continue/Abandon), or
   *  show the interactive modal that `tick` drives to resolution. PoV
   *  auto-zoom side effects happen inside this flow.
   *
   *  Self-driving: the caller (`tickRoundEndPhase`) polls `isResolved()`
   *  and reads the result via `takeResolution()` — no armed callback that
   *  promotion teardown could orphan.
   *
   *  Wire-arrived choices that landed before the dialog was built are
   *  drained inside `show()` via `OnlineEarlyChoices.drainLifeLost`
   *  (online wiring only).
   *
   *  Returns true when a dialog was actually shown — false when there were
   *  no entries at all (nothing lost), in which case the caller exits the
   *  round-end window immediately. */
  show: (
    needsReselect: readonly ValidPlayerId[],
    eliminated: readonly ValidPlayerId[],
  ) => boolean;
  tick: (dt: number) => void;
  /** True once every entry has resolved (and the eliminated-only notice
   *  dwell, if any, has elapsed). Polled by the round-end tick. */
  isResolved: () => boolean;
  /** Read the final continue/abandon lists and tear the dialog down. Call
   *  only after `isResolved()` returns true. */
  takeResolution: () => {
    continuing: readonly ValidPlayerId[];
    abandoned: readonly ValidPlayerId[];
  };
  panelPos: (playerId: ValidPlayerId) => { px: number; py: number };
}

interface LifeLostSystemDeps {
  runtimeState: RuntimeState;

  sendLifeLostChoice: (
    choice: ResolvedChoice,
    playerId: ValidPlayerId,
    applyAt: number,
  ) => void;
  log: (msg: string) => void;

  requestRender: () => void;
  panelPos: (playerId: ValidPlayerId) => { px: number; py: number };

  /** Online-only drain for wire-arrived choices that landed before the
   *  local sim built the dialog. Called once inside `show()` immediately
   *  after the dialog is written to runtime state. The drain iterates
   *  its session-side queue, calls `apply` for each entry, then clears
   *  the queue. The system owns the find/validate/write of each entry —
   *  including rejecting stale rounds (a choice queued after its own
   *  dialog already closed must not leak into a future round's dialog).
   *  Undefined in local play. */
  applyEarlyChoices?: (
    apply: (
      playerId: ValidPlayerId,
      choice: ResolvedChoice,
      round: number,
    ) => boolean,
  ) => void;
  /** Online-only writer for the same session queue `applyEarlyChoices`
   *  drains. Called by the ORIGINATOR's own scheduled apply when it drains
   *  with no dialog open (a snapshot adoption superseded the dialog
   *  mid-flight) — the wire receiver's schedule closure already queues in
   *  that window, and dropping locally while receivers queue would fork
   *  `continuing`/`abandoned` at `exitRoundEnd`. Round-stamped so the
   *  show()-time drain's stale-round guard applies equally to own choices.
   *  Undefined in local play (choices apply immediately, never scheduled). */
  queueEarlyChoice?: (
    playerId: ValidPlayerId,
    choice: ResolvedChoice,
    round: number,
  ) => void;
}

/** Extended return type: RuntimeLifeLost + extras for game-runtime wiring. */
export type LifeLostSystem = RuntimeLifeLost & {
  sendLifeLostChoice: (
    choice: ResolvedChoice,
    playerId: ValidPlayerId,
    applyAt: number,
  ) => void;
  /** Toggle continue/abandon focus for a player's pending entry. */
  toggleFocus: (playerId: ValidPlayerId) => void;
  /** Confirm the currently focused choice for a player (applies the focused option). */
  confirmChoice: (playerId: ValidPlayerId) => void;
  /** Apply a direct choice (e.g. from spatial click on a specific button). */
  applyChoice: (playerId: ValidPlayerId, choice: ResolvedChoice) => void;
  /** Adopt this seat's open entry to AI-resolved at a seat takeover —
   *  see `adoptDialogEntryToAi`. */
  adoptSeat: (playerId: ValidPlayerId) => void;
};

export function createLifeLostSystem(deps: LifeLostSystemDeps): LifeLostSystem {
  const { runtimeState } = deps;

  /** Seconds remaining on the eliminated-only "Eliminated" notice dwell.
   *  Set in `show()` when every entry is already resolved (only
   *  eliminations, no interactive Continue/Abandon) but there IS a panel
   *  to show — the dialog would otherwise resolve on its first tick and
   *  flash for one frame. While > 0 the tick loop just holds the panel,
   *  then resolves (→ ABANDON for each entry). Deterministic sim-time, so
   *  every peer resolves at the same tick. */
  let noticeDwellRemaining = 0;

  /** Slots with a choice sent but not yet applied (online lockstep window
   *  between send and `applyAt`). Blocks duplicate sends while the entry
   *  still reads as PENDING — both from repeat clicks and from the
   *  max-timer force loop re-firing every tick. Cleared per-slot when the
   *  scheduled apply fires, wholesale on dialog teardown. */
  const inFlightChoices = new Set<ValidPlayerId>();

  /** Build + show the life-lost dialog. Holds a button-less "Eliminated"
   *  notice for a short dwell when every entry is pre-resolved (only
   *  eliminations); otherwise shows the interactive modal that `tick`
   *  drives to resolution. The caller polls `isResolved()` +
   *  `takeResolution()` and is responsible for eliminating abandoned
   *  players.
   *
   *  Drains queued early-arrived wire choices (online only) before
   *  returning, so the dialog's first tick observes them as if they
   *  arrived after the dialog opened.
   *
   *  Returns true when a dialog was actually shown; false when there were
   *  no entries at all (nothing lost this round). */
  function show(
    needsReselect: readonly ValidPlayerId[],
    eliminated: readonly ValidPlayerId[],
  ): boolean {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    deps.log(
      `show lifeLost: needsReselect=[${needsReselect}] eliminated=[${eliminated}]`,
    );
    const dialog = createLifeLostDialogState({
      needsReselect,
      eliminated,
      state: runtimeState.state,
      remotePlayerSlots,
      needsLocalInput: (playerId) =>
        !runtimeState.controllers[playerId]!.autoResolvesLifeLost(),
    });
    if (isLifeLostAllResolved(dialog)) {
      if (dialog.entries.length === 0) {
        // Nothing to show — no life lost this round, or a game-over with
        // no elimination. Caller exits the round-end window immediately.
        deps.log("show lifeLost: no entries, skipping dialog");
        return false;
      }
      // Eliminated-only: a player lost their last life but there's no
      // interactive Continue/Abandon prompt. Show the button-less
      // "Eliminated" panel as its own sequential beat (after the score
      // overlay) for the same dwell an AI entry would auto-resolve in,
      // then resolve — mirrors the normal life-lost dialog instead of
      // flashing for one frame. See `noticeDwellRemaining`.
      deps.log("show lifeLost: eliminated-only notice, dwelling");
      runtimeState.dialogs.lifeLost = dialog;
      setMode(runtimeState, Mode.LIFE_LOST);
      noticeDwellRemaining = LIFE_LOST_AUTO_DELAY;
      return true;
    }
    runtimeState.dialogs.lifeLost = dialog;
    setMode(runtimeState, Mode.LIFE_LOST);
    deps.applyEarlyChoices?.((playerId, choice, round) => {
      // Stale-round guard: a choice whose applyAt landed after its own
      // dialog closed gets queued by the wire path — it belongs to a
      // PREVIOUS round's dialog and must not resolve this one.
      if (round !== runtimeState.state.round) return false;
      const entry = dialog.entries.find(
        (candidate) =>
          candidate.playerId === playerId &&
          candidate.choice === LifeLostChoice.PENDING,
      );
      if (!entry) return false;
      entry.choice = choice;
      return true;
    });
    return true;
  }

  /**
   * Tick the life-lost dialog: advance the eliminated-only notice dwell
   * or drive the interactive entries toward resolution. Does NOT resolve
   * the dialog — the self-driving `tickRoundEndPhase` polls `isResolved()`
   * and reads the result via `takeResolution()`.
   */
  function tickLifeLostDialogSystem(dt: number) {
    const dialog = runtimeState.dialogs.lifeLost;
    if (!dialog) return;

    // Eliminated-only notice: no interactive entries to tick — hold the
    // panel for the dwell (each entry is already ABANDON).
    if (noticeDwellRemaining > 0) {
      dialog.timer += dt;
      noticeDwellRemaining -= dt;
      deps.requestRender();
      return;
    }

    const state = runtimeState.state;
    tickLifeLostDialog(
      dialog,
      dt,
      LIFE_LOST_MAX_TIMER,
      (entry) =>
        runtimeState.controllers[entry.playerId]!.tickLifeLost(
          entry,
          dt,
          LIFE_LOST_AUTO_DELAY,
          state,
        ),
      (entry) => forceResolveEntry(entry, dialog),
    );

    deps.requestRender();
  }

  /** True once every entry has resolved and any eliminated-only notice
   *  dwell has elapsed. Polled by `tickRoundEndPhase`. */
  function isResolved(): boolean {
    const dialog = runtimeState.dialogs.lifeLost;
    if (!dialog) return false;
    if (noticeDwellRemaining > 0) return false;
    return isLifeLostAllResolved(dialog);
  }

  /** Compute the final continue/abandon lists and tear the dialog down.
   *  Call only after `isResolved()` returns true. */
  function takeResolution(): {
    continuing: readonly ValidPlayerId[];
    abandoned: readonly ValidPlayerId[];
  } {
    const dialog = runtimeState.dialogs.lifeLost;
    if (!dialog) return { continuing: [], abandoned: [] };
    const continuing = continuingPlayers(dialog);
    const abandoned = abandonedPlayers(dialog);
    deps.log(
      `lifeLostDialog resolved: ${dialog.entries.map((e) => `P${e.playerId}=${e.choice}(auto=${e.autoResolve})`).join(", ")} timer=${dialog.timer.toFixed(1)}s`,
    );
    runtimeState.dialogs.lifeLost = null;
    noticeDwellRemaining = 0;
    inFlightChoices.clear();
    return { continuing, abandoned };
  }

  /** Max-timer force-resolve, ownership-routed. The entry's OWNING peer
   *  (local, non-auto slot) funnels the forced ABANDON through the same
   *  lockstep path as a click — force-vs-click ordering is serialized on
   *  one machine, so every peer applies the same resolution at the same
   *  logical tick. Non-owning peers only backstop after an extra
   *  `DIALOG_FORCE_GRACE` window (owner unreachable), with the same
   *  value the owner would have sent, so a slow wire can't fork the
   *  dialog and a dead peer can't hang it. */
  function forceResolveEntry(
    entry: LifeLostEntry,
    dialog: LifeLostDialogState,
  ): void {
    if (isLocallyDrivenEntry(entry, runtimeState.frameMeta.remotePlayerSlots)) {
      scheduleOrApplyChoice(entry.playerId, LifeLostChoice.ABANDON);
      return;
    }
    if (dialog.timer >= LIFE_LOST_MAX_TIMER + DIALOG_FORCE_GRACE) {
      applyLifeLostChoice(entry, LifeLostChoice.ABANDON);
    }
  }

  function toggleFocus(playerId: ValidPlayerId): void {
    withPendingEntry(playerId, (entry) => toggleLifeLostFocus(entry));
  }

  function confirmChoice(playerId: ValidPlayerId): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    scheduleOrApplyChoice(playerId, focusedLifeLostChoice(entry));
  }

  /** Apply a direct choice (e.g. from a mouse click on a specific button).
   *  Unlike confirmChoice, this sets the choice directly without reading focus. */
  function applyChoice(playerId: ValidPlayerId, choice: ResolvedChoice): void {
    if (!findPendingEntry(playerId)) return;
    scheduleOrApplyChoice(playerId, choice);
  }

  /** Lockstep-when-online choice — see `scheduleOrApplyDialogChoice`.
   *  `applyEarlyChoices` is the online-signal (undefined in local). */
  function scheduleOrApplyChoice(
    playerId: ValidPlayerId,
    choice: ResolvedChoice,
  ): void {
    // Captured at decision time — the same value the wire message carries
    // (`round: state.round`, stamped in the send wiring). ROUND_END holds
    // the closing round for the whole window, so a queued own-choice passes
    // the rebuilt dialog's stale-round guard exactly when a receiver's
    // queued copy does.
    const round = runtimeState.state.round;
    scheduleOrApplyDialogChoice({
      online: deps.applyEarlyChoices !== undefined,
      playerId,
      inFlight: inFlightChoices,
      stampTick: () => lockstepStampTick(runtimeState),
      schedule: (action) => runtimeState.actionSchedule.schedule(action),
      applyLocal: () =>
        withPendingEntry(playerId, (entry) =>
          applyLifeLostChoice(entry, choice),
        ),
      send: (applyAt) => deps.sendLifeLostChoice(choice, playerId, applyAt),
      // Same drain-time funnel as the wire receiver: apply to the live
      // dialog, or round-stamp-queue when an adoption superseded it.
      applyAtTick: () =>
        applyOrQueueLifeLostChoice(
          playerId,
          choice,
          round,
          runtimeState.dialogs.lifeLost,
          (pid, queuedChoice, queuedRound) =>
            deps.queueEarlyChoice?.(pid, queuedChoice, queuedRound),
        ),
    });
  }

  /** Hand a taken-over seat's still-pending entry to the local AI. */
  function adoptSeat(playerId: ValidPlayerId): void {
    adoptDialogEntryToAi(
      runtimeState.dialogs.lifeLost?.entries,
      playerId,
      (entry) => entry.choice === LifeLostChoice.PENDING,
    );
  }

  function findPendingEntry(
    playerId: ValidPlayerId,
  ): LifeLostEntry | undefined {
    return findPendingDialogEntry(
      runtimeState.dialogs.lifeLost?.entries,
      playerId,
      (entry) => entry.choice === LifeLostChoice.PENDING,
    );
  }

  function withPendingEntry(
    playerId: ValidPlayerId,
    action: (entry: LifeLostEntry) => void,
  ): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    action(entry);
  }

  return {
    /** Read current dialog state. Used by input-gate and remote-choice handlers
     *  to check whether a dialog is active. */
    get: () => runtimeState.dialogs.lifeLost,
    /** Clear dialog state on session reset / host promote (only ever called
     *  with null in production; the type permits a value for symmetry). */
    set: (dialog: LifeLostDialogState | null) => {
      runtimeState.dialogs.lifeLost = dialog;
      if (dialog === null) {
        noticeDwellRemaining = 0;
        inFlightChoices.clear();
      }
    },
    show,
    tick: tickLifeLostDialogSystem,
    isResolved,
    takeResolution,
    panelPos: deps.panelPos,
    // Extra — needed by game-runtime internals
    sendLifeLostChoice: deps.sendLifeLostChoice,
    toggleFocus,
    confirmChoice,
    applyChoice,
    adoptSeat,
  };
}
