/**
 * Upgrade pick dialog sub-system factory. Tick scope: gated on
 * Mode.UPGRADE_PICK. Diverges from the other dialog sub-systems by
 * having a `prepare()` pre-create step for progressive reveal during
 * the banner sweep, before tryShow() activates the mode. Owns the
 * dialog lifecycle (create, tick, resolve); input handling lives in
 * runtime-input.ts.
 */

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
  assertStateInstalled,
  type RuntimeState,
  setMode,
} from "../runtime-state.ts";
import {
  createUpgradePickDialog,
  moveUpgradePickFocus,
  resolveUpgradePickEntry,
  tickUpgradePickDialog,
} from "../runtime-upgrade-pick-core.ts";

interface UpgradePickSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly log: (msg: string) => void;
  readonly requestRender: () => void;
  readonly sendUpgradePick: (
    playerId: ValidPlayerId,
    choice: UpgradeId,
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

export interface UpgradePickSystem {
  /** Read current dialog state. Used by watcher-mode to sync overlay display. */
  get: () => UpgradePickDialogState | null;
  /** Replace dialog state. Used by watcher-mode to apply host-broadcast state. */
  set: (dialog: UpgradePickDialogState | null) => void;
  /** Try to show the upgrade pick dialog. Returns true if shown, false if skipped.
   *
   *  lint:allow-callback-inversion -- completion callback: onDone fires
   *  once when picking concludes; subsystem doesn't read return values. */
  tryShow: (onDone: () => void) => boolean;
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
}

const EMPTY_SLOT_SET: ReadonlySet<ValidPlayerId> = new Set();

export function createUpgradePickSystem(
  deps: UpgradePickSystemDeps,
): UpgradePickSystem {
  const { runtimeState } = deps;

  /** Callback to invoke when all picks are resolved. Tick is gated on
   *  Mode.UPGRADE_PICK. */
  let pendingDoneCb: (() => void) | undefined;

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

  function tryShow(onDone: () => void): boolean {
    assertStateInstalled(runtimeState);
    const dialog = ensureDialog();
    if (!dialog) return false;

    setMode(runtimeState, Mode.UPGRADE_PICK);
    pendingDoneCb = onDone;
    deps.log(
      `upgrade pick: ${dialog.entries.length} players, round=${runtimeState.state.round}`,
    );
    deps.applyEarlyChoices?.((playerId, choice) => {
      const entry = dialog.entries.find(
        (candidate) =>
          candidate.playerId === playerId &&
          candidate.choice === null &&
          candidate.offers.includes(choice),
      );
      if (!entry) return false;
      entry.choice = choice;
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
    // Hand off to the phase machine. `upgrade-pick-done.mutate` applies
    // the picks and tears the dialog down — runtime dialog state never
    // coexists with a non-UPGRADE_PICK phase. The build banner's
    // A-snapshot freezes the last-painted picker-modal frame, so the
    // visual cross-fade to the build scene doesn't depend on dialog
    // state surviving past this point. Mode stays on UPGRADE_PICK; the
    // chain's postDisplay flips to the terminal mode.
    const callback = pendingDoneCb;
    pendingDoneCb = undefined;
    callback?.();
  }

  function moveFocus(playerId: ValidPlayerId, dir: number): void {
    withPendingEntry(playerId, (entry) => moveUpgradePickFocus(entry, dir));
  }

  function resolveAndSend(entry: UpgradePickEntry, cardIdx: number): void {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return;
    const choice = resolveUpgradePickEntry(entry, cardIdx, dialog.timer);
    deps.sendUpgradePick(entry.playerId, choice);
  }

  function confirmChoice(playerId: ValidPlayerId): void {
    withPendingEntry(playerId, (entry) =>
      resolveAndSend(entry, entry.focusedCard),
    );
  }

  /** Pick a specific card directly (e.g. from a click on a card). */
  function pickDirect(playerId: ValidPlayerId, cardIdx: number): void {
    withPendingEntry(playerId, (entry) => {
      if (cardIdx < 0 || cardIdx >= entry.offers.length) return;
      resolveAndSend(entry, cardIdx);
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
