import {
  DIALOG_FORCE_GRACE,
  LIFE_LOST_AUTO_DELAY,
  LIFE_LOST_MAX_TIMER,
} from "../../shared/core/game-constants.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import {
  LifeLostChoice,
  type LifeLostDialogState,
  type LifeLostEntry,
  type ResolvedChoice,
} from "../../shared/ui/interaction-types.ts";
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
  applyLifeLostChoiceToDialog,
  continuingPlayers,
  createLifeLostDialogState,
  focusedLifeLostChoice,
  isLifeLostAllResolved,
  tickLifeLostDialog,
  toggleLifeLostFocus,
} from "../dialogs/life-lost-core.ts";
import { lockstepDebtTicks, type RuntimeState, setMode } from "../state.ts";

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
  /** Drive the life-lost flow to completion: create the dialog, then
   *  either resolve immediately (no entries — nothing was lost), hold a
   *  button-less "Eliminated" notice for a short dwell when every entry is
   *  pre-resolved (only eliminations, no Continue/Abandon), or show the
   *  interactive modal and wait for `tick` to resolve every entry. The
   *  `onResolved(continuing, abandoned)` callback fires exactly once.
   *  The CALLER eliminates abandoned players and routes the next phase
   *  (game-over / reselect / continue) — see the ROUND_END postDisplay
   *  in the phase machine. PoV auto-zoom side effects still happen
   *  inside this flow.
   *
   *  Wire-arrived choices that landed before the dialog was built are
   *  drained inside `show()` via `OnlineDialogDrains.drainLifeLost`
   *  (online wiring only).
   *
   *  Returns true when a dialog was actually shown. */
  show: (
    needsReselect: readonly ValidPlayerId[],
    eliminated: readonly ValidPlayerId[],
    onResolved: (
      continuing: readonly ValidPlayerId[],
      abandoned: readonly ValidPlayerId[],
    ) => void,
  ) => boolean;
  tick: (dt: number) => void;
  /** Resolve an open dialog immediately: pending entries are written as
   *  CONTINUE, then the armed `onResolved` callback fires with the final
   *  lists, exactly as the tick loop would. No-op when no dialog is open.
   *  Host-promotion repair (`forceResolveRoundEndPhase`) — CONTINUE, not
   *  the max-timer backstop's ABANDON: that backstop is an
   *  unresponsiveness penalty, and a host disconnect is not the
   *  remaining players' fault. */
  forceResolveAll: () => void;
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
}

/** Callback signature used by every resolution path (immediate skip
 *  or dialog-tick). Receives the lists of CONTINUE and ABANDON resolutions;
 *  the caller (phase machine) eliminates abandoned players and routes the
 *  next transition based on `continuing`. The subsystem deliberately does
 *  NOT call `eliminatePlayers` itself — mirrors how upgrade-pick hands the
 *  resolved dialog back via `OnUpgradePickResolved` and lets the phase
 *  machine's `runPickerModalThenDispatch` apply the picks. Both
 *  subsystems produce resolutions; the phase machine applies them. */
type OnLifeLostResolved = (
  continuing: readonly ValidPlayerId[],
  abandoned: readonly ValidPlayerId[],
) => void;

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

  /** Set when a dialog is shown; cleared once resolution fires. The
   *  tick loop reads it to invoke the caller's onResolved callback.
   *  Tick is gated on Mode.LIFE_LOST. */
  let onResolvedCb: OnLifeLostResolved | undefined;

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

  /** Drive the life-lost flow to completion. Resolves immediately when
   *  there's nothing to show (`onResolved([], [])`); holds a button-less
   *  "Eliminated" notice for a short dwell when every entry is
   *  pre-resolved (only eliminations); otherwise shows the interactive
   *  modal and calls `onResolved(continuing, abandoned)` once the dialog's
   *  tick loop resolves every entry. The caller is responsible for
   *  eliminating abandoned players.
   *
   *  Drains queued early-arrived wire choices (online only) before
   *  returning, so the dialog's first tick observes them as if they
   *  arrived after the dialog opened.
   *
   *  Returns true when a dialog was actually shown. */
  function show(
    needsReselect: readonly ValidPlayerId[],
    eliminated: readonly ValidPlayerId[],
    onResolved: OnLifeLostResolved,
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
        // no elimination. Resolve immediately.
        deps.log("show lifeLost: no entries, skipping dialog");
        onResolved(continuingPlayers(dialog), abandonedPlayers(dialog));
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
      onResolvedCb = onResolved;
      setMode(runtimeState, Mode.LIFE_LOST);
      noticeDwellRemaining = LIFE_LOST_AUTO_DELAY;
      return true;
    }
    runtimeState.dialogs.lifeLost = dialog;
    onResolvedCb = onResolved;
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
   * Tick the life-lost dialog; when every entry is resolved, hand the
   * continuing + abandoned lists back through `onResolved` so the caller
   * can eliminate abandoned players and route the next transition. The
   * callback chain is synchronous: postDisplay runs inline, dispatches
   * the next transition, and that transition's setMode call overwrites
   * Mode.LIFE_LOST before any frame renders.
   */
  function tickLifeLostDialogSystem(dt: number) {
    const dialog = runtimeState.dialogs.lifeLost;
    if (!dialog) return;

    // Eliminated-only notice: no interactive entries to tick — hold the
    // panel for the dwell, then resolve (each entry is already ABANDON).
    if (noticeDwellRemaining > 0) {
      dialog.timer += dt;
      noticeDwellRemaining -= dt;
      deps.requestRender();
      if (noticeDwellRemaining <= 0) resolveDialogNow(dialog);
      return;
    }

    const state = runtimeState.state;
    const dialogResolved = tickLifeLostDialog(
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

    if (!dialogResolved) return;

    deps.log(
      `lifeLostDialog resolved: ${dialog.entries.map((e) => `P${e.playerId}=${e.choice}(auto=${e.autoResolve})`).join(", ")} timer=${dialog.timer.toFixed(1)}s`,
    );

    resolveDialogNow(dialog);
  }

  /** Shared resolution tail: compute the final lists, tear the dialog
   *  down, fire the armed callback once. Reached by the tick loop (every
   *  entry resolved) and by `forceResolveAll` (host-promotion
   *  fast-forward). */
  function resolveDialogNow(dialog: LifeLostDialogState): void {
    const continuing = continuingPlayers(dialog);
    const abandoned = abandonedPlayers(dialog);
    runtimeState.dialogs.lifeLost = null;
    noticeDwellRemaining = 0;
    inFlightChoices.clear();

    const callback = onResolvedCb;
    onResolvedCb = undefined;
    callback?.(continuing, abandoned);
  }

  function forceResolveAll(): void {
    const dialog = runtimeState.dialogs.lifeLost;
    if (!dialog) return;
    for (const entry of dialog.entries) {
      if (entry.choice === LifeLostChoice.PENDING) {
        applyLifeLostChoice(entry, LifeLostChoice.CONTINUE);
      }
    }
    deps.log(
      `lifeLostDialog force-resolved: ${dialog.entries.map((e) => `P${e.playerId}=${e.choice}`).join(", ")}`,
    );
    resolveDialogNow(dialog);
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
    scheduleOrApplyDialogChoice({
      online: deps.applyEarlyChoices !== undefined,
      playerId,
      inFlight: inFlightChoices,
      simTick: runtimeState.state.simTick,
      extraDelayTicks: lockstepDebtTicks(runtimeState),
      schedule: (action) => runtimeState.actionSchedule.schedule(action),
      applyLocal: () =>
        withPendingEntry(playerId, (entry) =>
          applyLifeLostChoice(entry, choice),
        ),
      send: (applyAt) => deps.sendLifeLostChoice(choice, playerId, applyAt),
      applyAtTick: () =>
        applyLifeLostChoiceToDialog(
          playerId,
          choice,
          runtimeState.dialogs.lifeLost,
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
        onResolvedCb = undefined;
        noticeDwellRemaining = 0;
        inFlightChoices.clear();
      }
    },
    show,
    tick: tickLifeLostDialogSystem,
    forceResolveAll,
    panelPos: deps.panelPos,
    // Extra — needed by game-runtime internals
    sendLifeLostChoice: deps.sendLifeLostChoice,
    toggleFocus,
    confirmChoice,
    applyChoice,
    adoptSeat,
  };
}
