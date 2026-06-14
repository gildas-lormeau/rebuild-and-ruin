/**
 * Upgrade pick dialog sub-system factory. Tick scope: gated on
 * Mode.UPGRADE_PICK. Diverges from the other dialog sub-systems by
 * having a `prepare()` pre-create step for progressive reveal during
 * the banner sweep, before tryShow() activates the mode. Owns the
 * dialog lifecycle (create, tick, resolve); input handling lives in
 * subsystems/input.ts.
 */

import {
  DIALOG_FORCE_GRACE,
  SIM_TICK_DT,
  UPGRADE_PICK_AUTO_DELAY,
  UPGRADE_PICK_MAX_TIMER,
  UPGRADE_PICK_PULSE_DURATION,
} from "../../shared/core/game-constants.ts";
import { type ValidPlayerId } from "../../shared/core/player-slot.ts";
import type { UpgradeId } from "../../shared/core/upgrade-defs.ts";
import type {
  UpgradePickDialogState,
  UpgradePickEntry,
} from "../../shared/ui/interaction-types.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import {
  adoptDialogEntryToAi,
  findPendingDialogEntry,
  isLocallyDrivenEntry,
  scheduleOrApplyDialogChoice,
} from "../dialogs/dialog-tick.ts";
import {
  applyUpgradePickChoiceToDialog,
  createUpgradePickDialog,
  moveUpgradePickFocus,
  resolveUpgradePickEntry,
  tickUpgradePickDialog,
} from "../dialogs/upgrade-pick-core.ts";
import {
  assertStateInstalled,
  lockstepDebtTicks,
  type RuntimeState,
  setMode,
} from "../state.ts";

/** Public upgrade-pick dialog handle exposed on `GameRuntime`. Tick scope:
 *  gated on `Mode.UPGRADE_PICK`. Sibling dialog handle is `RuntimeLifeLost`. */
export interface RuntimeUpgradePick {
  /** Read current dialog state. Symmetric with `RuntimeLifeLost.get` —
   *  prefer this over `runtimeState.dialogs.upgradePick` when doing a
   *  single targeted read from outside the owning subsystem. */
  get: () => UpgradePickDialogState | null;
  /** Replace dialog state. Only ever called with `null` in production
   *  (session reset / host promote / teardown) — dialogs are always built
   *  locally on every peer, never received over the wire. Passing `null`
   *  also clears any pending `onResolved` callback so a force-clear
   *  (rematch, host-promote) can't fire it later. */
  set: (dialog: UpgradePickDialogState | null) => void;
}

interface UpgradePickSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly log: (msg: string) => void;
  readonly requestRender: () => void;
  readonly sendUpgradePick: (
    playerId: ValidPlayerId,
    choice: UpgradeId,
    applyAt: number,
  ) => void;

  /** Online-only drain for wire-arrived picks that landed during the
   *  banner-preview window — the dialog exists for rendering but
   *  Mode.UPGRADE_PICK isn't active yet, so the wire path queues them
   *  in the session map. Called once inside `tryShow()` immediately
   *  after Mode flips. The drain iterates its session-side queue,
   *  calls `apply` for each entry, then clears the queue. The system
   *  owns the find/validate/write of each entry.
   *  Undefined in local play. */
  readonly applyEarlyChoices?: (
    apply: (
      playerId: ValidPlayerId,
      choice: UpgradeId,
      round: number,
    ) => boolean,
  ) => void;
}

/** Callback signature for the resolved upgrade-pick dialog. Receives the
 *  finalized dialog snapshot — the caller (phase machine) reads each
 *  entry's chosen `UpgradeId` and applies it via `applyUpgradePicks`.
 *  Mirrors `OnLifeLostResolved` in `subsystems/life-lost.ts`: the
 *  subsystem hands resolutions back via callback, the caller owns the
 *  state mutation. */
type OnUpgradePickResolved = (resolved: UpgradePickDialogState) => void;

/** Extended return type: RuntimeUpgradePick + extras for game-runtime wiring. */
export type UpgradePickSystem = RuntimeUpgradePick & {
  /** Try to show the upgrade pick dialog. Returns true if shown, false if skipped.
   *  When the dialog resolves, `onResolved(dialog)` fires exactly once with
   *  the finalized snapshot; the subsystem clears its own dialog state
   *  before invoking the callback, so the caller can apply picks without
   *  worrying about dialog teardown. */
  tryShow: (onResolved: OnUpgradePickResolved) => boolean;
  /** Tick the dialog (AI auto-pick, timer). */
  tick: (dt: number) => void;
  /** Pre-create the dialog so it can render during the banner sweep (upgrade-pick only).
   *  Does NOT set Mode.UPGRADE_PICK — call tryShow after the banner ends. */
  prepare: () => boolean;
  /** Navigate focus left/right. */
  moveFocus: (playerId: ValidPlayerId, dir: number) => void;
  confirmChoice: (playerId: ValidPlayerId) => void;
  /** Pick a specific card directly (e.g. from a click). */
  pickDirect: (playerId: ValidPlayerId, cardIdx: number) => void;
  /** Slots whose entries accept input from this machine (one slot online,
   *  every local human in shared-screen mode). Empty if none. */
  interactiveSlots: () => ReadonlySet<ValidPlayerId>;
  /** Resolve the whole dialog NOW — host-promotion repair. Every pending
   *  entry gets the same state-derived pick the max-timer backstop would
   *  write (`forceUpgradePick`); already-picked entries keep their choice.
   *  Tears down dialog state and returns the finalized snapshot WITHOUT
   *  invoking the armed `onResolved` callback — the phase machine applies
   *  the picks and dispatches `enter-wall-build` itself
   *  (`forceResolveUpgradePickPhase`), which also covers the banner-window
   *  case where no callback was armed yet. Null when no dialog exists. */
  forceResolveAll: () => UpgradePickDialogState | null;
  /** Adopt this seat's open entry to AI-resolved at a seat takeover —
   *  see `adoptDialogEntryToAi`. */
  adoptSeat: (playerId: ValidPlayerId) => void;
};

const EMPTY_SLOT_SET: ReadonlySet<ValidPlayerId> = new Set();

export function createUpgradePickSystem(
  deps: UpgradePickSystemDeps,
): UpgradePickSystem {
  const { runtimeState } = deps;

  /** Set when a dialog is shown; cleared once resolution fires. The tick
   *  loop reads it to invoke the caller's onResolved callback with the
   *  finalized dialog. Tick is gated on Mode.UPGRADE_PICK. */
  let onResolvedCb: OnUpgradePickResolved | undefined;

  /** Slots with a pick sent but not yet applied (online lockstep window
   *  between send and `applyAt`). Blocks duplicate sends while the entry
   *  still reads as pending. Cleared per-slot when the scheduled apply
   *  fires, wholesale on dialog teardown. */
  const inFlightPicks = new Set<ValidPlayerId>();

  /** `state.simTick` at which the tick loop first observed every entry
   *  resolved; undefined while any entry is pending. Anchors the
   *  reveal-pulse dwell on the sim-tick timeline instead of
   *  `dialog.timer`/`pickedAtTimer`, which are dialog-OPEN-relative and
   *  skew cross-peer with dialog-open times (pickedAtTimer is cosmetic —
   *  it only drives the pulse animation).
   *
   *  NOT a cross-peer same-tick guarantee: human picks land at
   *  lockstep-shared sim ticks, but AI entries resolve off the per-peer
   *  dialog timer, so the observed tick (and the following
   *  `enter-wall-build` dispatch) can skew across peers when an AI
   *  resolves last. That skew is safe because no shared-`state.rng`
   *  consumer runs in the window — verified, not assumed (see
   *  test/dialog-rng-window.test.ts). Three legs: the phase sim (where the
   *  rng consumers live) is suspended in dialog modes; the dialog tick is
   *  rng-neutral (constant CONTINUE for life-lost, a PRIVATE derived Rng
   *  for the upgrade pick); and the one thing the action-schedule drain
   *  CAN still carry here — a mid-dialog seat-takeover — primes via
   *  rng-free resets/build-init in the dialog phases (UPGRADE_PICK ->
   *  reset() only; WALL_BUILD -> reset() + initBuild; see
   *  `primeAiControllerForPhase`). Phase-entry tick skew is tolerated
   *  architecture-wide (camera-gated transitions). Cleared on dialog
   *  teardown. */
  let resolvedAtSimTick: number | undefined;

  /** Ensure the dialog exists on runtimeState, creating it if needed. */
  function ensureDialog(): UpgradePickDialogState | null {
    if (runtimeState.dialogs.upgradePick)
      return runtimeState.dialogs.upgradePick;
    const dialog = createUpgradePickDialog({
      state: runtimeState.state,
      remotePlayerSlots: runtimeState.frameMeta.remotePlayerSlots,
      needsLocalInput: (playerId) =>
        !runtimeState.controllers[playerId]!.autoResolvesUpgradePick(),
    });
    if (!dialog) return null;
    runtimeState.dialogs.upgradePick = dialog;
    return dialog;
  }

  function prepare(): boolean {
    assertStateInstalled(runtimeState);
    // `prepare()` is called twice by design — the `enter-upgrade-pick` mutate
    // pre-creates the dialog for progressive reveal during the banner sweep,
    // then `runPickerModalThenDispatch` re-calls it (idempotently) in
    // postDisplay. Log only on the first call (actual creation) so the
    // "prepared" line isn't duplicated every modern round.
    const alreadyCreated = Boolean(runtimeState.dialogs.upgradePick);
    const dialog = ensureDialog();
    if (!dialog) return false;
    if (!alreadyCreated) {
      deps.log(
        `upgrade pick prepared: ${dialog.entries.length} players, round=${runtimeState.state.round}`,
      );
    }
    return true;
  }

  function tryShow(onResolved: OnUpgradePickResolved): boolean {
    assertStateInstalled(runtimeState);
    const dialog = ensureDialog();
    if (!dialog) return false;

    setMode(runtimeState, Mode.UPGRADE_PICK);
    onResolvedCb = onResolved;
    deps.log(
      `upgrade pick: ${dialog.entries.length} players, round=${runtimeState.state.round}`,
    );
    deps.applyEarlyChoices?.((playerId, choice, round) => {
      // Stale-round guard: a pick whose applyAt landed after its own
      // dialog closed gets queued by the wire path — it belongs to a
      // PREVIOUS round's dialog and must not resolve this one.
      if (round !== runtimeState.state.round) return false;
      const entry = dialog.entries.find(
        (candidate) =>
          candidate.playerId === playerId && candidate.choice === null,
      );
      if (!entry) return false;
      const cardIdx = entry.offers.indexOf(choice);
      if (cardIdx < 0) return false;
      resolveUpgradePickEntry(entry, cardIdx, dialog.timer);
      return true;
    });
    return true;
  }

  function tick(dt: number): void {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return;

    const state = runtimeState.state;
    const allResolved = tickUpgradePickDialog(
      dialog,
      dt,
      UPGRADE_PICK_MAX_TIMER,
      (entry, entryIdx) =>
        runtimeState.controllers[entry.playerId]!.tickUpgradePick(
          entry,
          entryIdx,
          UPGRADE_PICK_AUTO_DELAY,
          dialog.timer,
          state,
        ),
      (entry) => forceResolveEntry(entry, dialog),
    );

    deps.requestRender();

    if (!allResolved) return;

    // Let the final reveal pulse finish before closing the dialog — the last
    // entry resolves on the same frame as allResolved, so without this the
    // expanding ring animation for that entry never gets any draw frames.
    // The dwell counts sim ticks from the resolve, NOT dialog.timer vs
    // pickedAtTimer (dialog-open-relative, cross-peer skewed). See
    // `resolvedAtSimTick` for why the resolve tick itself can still skew
    // across peers (AI picks) and why that's safe.
    resolvedAtSimTick ??= state.simTick;
    const pulseElapsed = (state.simTick - resolvedAtSimTick) * SIM_TICK_DT;
    if (pulseElapsed < UPGRADE_PICK_PULSE_DURATION) return;

    deps.log(
      `upgrade picks resolved: ${dialog.entries.map((entry) => `P${entry.playerId}=${entry.choice}`).join(", ")}`,
    );
    // Hand off to the phase machine. Clear dialog state before invoking
    // the callback so the caller can apply picks against the frozen
    // snapshot without runtime dialog state surviving past resolution.
    // The build banner's A-snapshot freezes the last-painted picker-modal
    // frame, so the visual cross-fade to the build scene doesn't depend
    // on dialog state. Mode stays on UPGRADE_PICK; the chain's
    // postDisplay flips to the terminal mode.
    const callback = onResolvedCb;
    teardownDialog();
    callback?.(dialog);
  }

  /** Drop the dialog plus everything armed around it (resolution
   *  callback, in-flight pick guards, pulse anchor). Shared by the
   *  tick-resolution handoff, `set(null)` force-clears, and
   *  `forceResolveAll`. */
  function teardownDialog(): void {
    runtimeState.dialogs.upgradePick = null;
    onResolvedCb = undefined;
    inFlightPicks.clear();
    resolvedAtSimTick = undefined;
  }

  /** Max-timer force-resolve, ownership-routed. The entry's OWNING peer
   *  (local, non-auto slot) funnels the forced pick through the same
   *  lockstep path as a click — force-vs-click ordering is serialized on
   *  one machine, so every peer applies the same resolution at the same
   *  logical tick. Non-owning peers only backstop after an extra
   *  `DIALOG_FORCE_GRACE` window (owner unreachable), writing the same
   *  seed-derived pick the owner would have sent (`forceUpgradePick`
   *  derives it from state alone), so a slow wire can't fork the dialog
   *  and a dead peer can't hang it. Mirrors `forceResolveEntry` in
   *  subsystems/life-lost.ts. */
  function forceResolveEntry(
    entry: UpgradePickEntry,
    dialog: UpgradePickDialogState,
  ): void {
    const forced = runtimeState.controllers[entry.playerId]!.forceUpgradePick(
      entry,
      runtimeState.state,
    );
    if (isLocallyDrivenEntry(entry, runtimeState.frameMeta.remotePlayerSlots)) {
      scheduleOrApplyPick(entry, entry.offers.indexOf(forced));
      return;
    }
    if (dialog.timer >= UPGRADE_PICK_MAX_TIMER + DIALOG_FORCE_GRACE) {
      resolveUpgradePickEntry(
        entry,
        entry.offers.indexOf(forced),
        dialog.timer,
      );
    }
  }

  /** See `UpgradePickSystem.forceResolveAll`. The teardown mirrors the
   *  resolution path in `tick()` minus the callback invocation. */
  function forceResolveAll(): UpgradePickDialogState | null {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return null;
    for (const entry of dialog.entries) {
      if (entry.choice !== null) continue;
      const forced = runtimeState.controllers[entry.playerId]!.forceUpgradePick(
        entry,
        runtimeState.state,
      );
      resolveUpgradePickEntry(
        entry,
        entry.offers.indexOf(forced),
        dialog.timer,
      );
    }
    teardownDialog();
    return dialog;
  }

  function moveFocus(playerId: ValidPlayerId, dir: number): void {
    withPendingEntry(playerId, (entry) => moveUpgradePickFocus(entry, dir));
  }

  /** Lockstep-when-online pick — see `scheduleOrApplyDialogChoice`.
   *  `applyEarlyChoices` is the online signal (undefined in local). A
   *  pick in flight when the max-timer deadline hits can still lose to
   *  the local force-pick — the per-peer deadline is the remaining
   *  cross-peer ordering gap, shared with life-lost. */
  function scheduleOrApplyPick(entry: UpgradePickEntry, cardIdx: number): void {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return;
    const playerId = entry.playerId;
    const choice = entry.offers[cardIdx]!;
    scheduleOrApplyDialogChoice({
      online: deps.applyEarlyChoices !== undefined,
      playerId,
      inFlight: inFlightPicks,
      simTick: runtimeState.state.simTick,
      extraDelayTicks: lockstepDebtTicks(runtimeState),
      schedule: (action) => runtimeState.actionSchedule.schedule(action),
      applyLocal: () => resolveUpgradePickEntry(entry, cardIdx, dialog.timer),
      send: (applyAt) => {
        // Snap focus to the clicked card for immediate visual feedback;
        // the scheduled apply re-asserts it. Cosmetic-only until applyAt.
        entry.focusedCard = cardIdx;
        deps.sendUpgradePick(playerId, choice, applyAt);
      },
      applyAtTick: () =>
        applyUpgradePickChoiceToDialog(
          playerId,
          choice,
          runtimeState.dialogs.upgradePick,
        ),
    });
  }

  function confirmChoice(playerId: ValidPlayerId): void {
    withPendingEntry(playerId, (entry) =>
      scheduleOrApplyPick(entry, entry.focusedCard),
    );
  }

  /** Pick a specific card directly (e.g. from a click on a card). */
  function pickDirect(playerId: ValidPlayerId, cardIdx: number): void {
    withPendingEntry(playerId, (entry) => {
      if (cardIdx < 0 || cardIdx >= entry.offers.length) return;
      scheduleOrApplyPick(entry, cardIdx);
    });
  }

  /** Hand a taken-over seat's still-pending entry to the local AI. */
  function adoptSeat(playerId: ValidPlayerId): void {
    adoptDialogEntryToAi(
      runtimeState.dialogs.upgradePick?.entries,
      playerId,
      (entry) => entry.choice === null,
    );
  }

  function findPendingEntry(
    playerId: ValidPlayerId,
  ): UpgradePickEntry | undefined {
    return findPendingDialogEntry(
      runtimeState.dialogs.upgradePick?.entries,
      playerId,
      (entry) => entry.choice === null,
    );
  }

  function withPendingEntry(
    playerId: ValidPlayerId,
    action: (entry: UpgradePickEntry) => void,
  ): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    action(entry);
  }

  /** Slots whose entries accept input from this machine. An entry is locally
   *  driven when it doesn't auto-resolve and isn't owned by a remote peer —
   *  that resolves to `{myPlayerId}` online and to every local-human slot in
   *  shared-screen play. */
  function interactiveSlots(): ReadonlySet<ValidPlayerId> {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return EMPTY_SLOT_SET;
    const remote = runtimeState.frameMeta.remotePlayerSlots;
    const slots = new Set<ValidPlayerId>();
    for (const entry of dialog.entries) {
      if (entry.autoResolve || remote.has(entry.playerId)) continue;
      slots.add(entry.playerId);
    }
    return slots;
  }

  return {
    get: () => runtimeState.dialogs.upgradePick,
    set: (dialog) => {
      if (dialog === null) {
        teardownDialog();
        return;
      }
      runtimeState.dialogs.upgradePick = dialog;
    },
    tryShow,
    tick,
    prepare,
    moveFocus,
    confirmChoice,
    pickDirect,
    interactiveSlots,
    forceResolveAll,
    adoptSeat,
  };
}
