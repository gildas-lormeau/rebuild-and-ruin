/**
 * Upgrade pick dialog sub-system factory. Tick scope: gated on
 * Mode.UPGRADE_PICK. Diverges from the other dialog sub-systems by
 * having a `prepare()` pre-create step for progressive reveal during
 * the banner sweep, before tryShow() activates the mode. Owns the
 * dialog lifecycle (create, tick, resolve); input handling lives in
 * subsystems/input.ts.
 */

import { DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS } from "../../shared/core/action-schedule.ts";
import {
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
  applyUpgradePickChoiceToDialog,
  createUpgradePickDialog,
  moveUpgradePickFocus,
  resolveUpgradePickEntry,
  tickUpgradePickDialog,
} from "../dialogs/upgrade-pick-core.ts";
import { assertStateInstalled, type RuntimeState, setMode } from "../state.ts";

/** Public upgrade-pick dialog handle exposed on `GameRuntime`. Tick scope:
 *  gated on `Mode.UPGRADE_PICK`. Sibling dialog handle is `RuntimeLifeLost`. */
export interface RuntimeUpgradePick {
  /** Read current dialog state. Symmetric with `RuntimeLifeLost.get` —
   *  prefer this over `runtimeState.dialogs.upgradePick` when doing a
   *  single targeted read from outside the owning subsystem. */
  get: () => UpgradePickDialogState | null;
  /** Replace dialog state. Used by watcher-mode to apply host-broadcast state.
   *  Passing `null` also clears any pending `onResolved` callback so a
   *  force-clear (rematch, host-promote) can't fire it later. */
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
    apply: (playerId: ValidPlayerId, choice: UpgradeId) => boolean,
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

  /** Ensure the dialog exists on runtimeState, creating it if needed. */
  function ensureDialog(): UpgradePickDialogState | null {
    if (runtimeState.dialogs.upgradePick)
      return runtimeState.dialogs.upgradePick;
    const dialog = createUpgradePickDialog({
      state: runtimeState.state,
      hostAtFrameStart: runtimeState.frameMeta.hostAtFrameStart,
      myPlayerId: runtimeState.frameMeta.myPlayerId,
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
    const dialog = ensureDialog();
    if (!dialog) return false;
    deps.log(
      `upgrade pick prepared: ${dialog.entries.length} players, round=${runtimeState.state.round}`,
    );
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
    deps.applyEarlyChoices?.((playerId, choice) => {
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
      (entry) =>
        runtimeState.controllers[entry.playerId]!.forceUpgradePick(
          entry,
          state,
        ),
    );

    deps.requestRender();

    if (!allResolved) return;

    // Let the final reveal pulse finish before closing the dialog — the last
    // entry resolves on the same frame as allResolved, so without this the
    // expanding ring animation for that entry never gets any draw frames.
    const latestPick = dialog.entries.reduce(
      (latest, entry) => Math.max(latest, entry.pickedAtTimer ?? 0),
      0,
    );
    if (dialog.timer - latestPick < UPGRADE_PICK_PULSE_DURATION) return;

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
    runtimeState.dialogs.upgradePick = null;
    inFlightPicks.clear();
    const callback = onResolvedCb;
    onResolvedCb = undefined;
    callback?.(dialog);
  }

  function moveFocus(playerId: ValidPlayerId, dir: number): void {
    withPendingEntry(playerId, (entry) => moveUpgradePickFocus(entry, dir));
  }

  /** Lockstep-when-online: in local play, resolve the entry immediately;
   *  in online play, broadcast with `applyAt` and schedule the local apply
   *  at the same `applyAt` so every peer's `entry.choice` write lands at
   *  the same logical tick — mirrors `scheduleOrApplyChoice` in
   *  subsystems/life-lost.ts. `applyEarlyChoices` is the online signal
   *  (undefined in local). `inFlightPicks` blocks re-sends while a pick
   *  awaits its applyAt tick (the entry still reads as pending). A pick
   *  in flight when the max-timer deadline hits can still lose to the
   *  local force-pick — the per-peer deadline is the remaining
   *  cross-peer ordering gap, shared with life-lost. */
  function scheduleOrApplyPick(entry: UpgradePickEntry, cardIdx: number): void {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return;
    if (deps.applyEarlyChoices === undefined) {
      resolveUpgradePickEntry(entry, cardIdx, dialog.timer);
      return;
    }
    const playerId = entry.playerId;
    if (inFlightPicks.has(playerId)) return;
    inFlightPicks.add(playerId);
    // Snap focus to the clicked card for immediate visual feedback; the
    // scheduled apply re-asserts it. Cosmetic-only until applyAt.
    entry.focusedCard = cardIdx;
    const choice = entry.offers[cardIdx]!;
    const applyAt =
      runtimeState.state.simTick + DEFAULT_ACTION_SCHEDULE_SAFETY_TICKS;
    deps.sendUpgradePick(playerId, choice, applyAt);
    runtimeState.actionSchedule.schedule({
      applyAt,
      playerId,
      apply: () => {
        inFlightPicks.delete(playerId);
        applyUpgradePickChoiceToDialog(
          playerId,
          choice,
          runtimeState.dialogs.upgradePick,
        );
      },
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

  function findPendingEntry(
    playerId: ValidPlayerId,
  ): UpgradePickEntry | undefined {
    return runtimeState.dialogs.upgradePick?.entries.find(
      (entry) => entry.playerId === playerId && entry.choice === null,
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
      runtimeState.dialogs.upgradePick = dialog;
      if (dialog === null) {
        onResolvedCb = undefined;
        inFlightPicks.clear();
      }
    },
    tryShow,
    tick,
    prepare,
    moveFocus,
    confirmChoice,
    pickDirect,
    interactiveSlots,
  };
}
