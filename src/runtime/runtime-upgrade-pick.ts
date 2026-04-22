/**
 * Upgrade pick dialog sub-system factory.
 *
 * Follows the modal dialog lifecycle contract (get/set/tryShow/tick) defined
 * in runtime-types.ts. Dialog completion patterns across the three dialogs
 * (ScoreDelta / LifeLost / UpgradePick) are compared side-by-side in the
 * decision table above RuntimeScoreDelta in runtime-types.ts (~line 428) —
 * read that before adding a fourth dialog.
 *
 * Upgrade-pick picks the "local closure" pattern (`tryShow(onDone)`) because
 * it has a single resolution path (always resume the build-phase banner).
 * Also diverges from life-lost in having a `prepare()` pre-create step for
 * progressive reveal during the banner sweep, before tryShow() activates
 * Mode.UPGRADE_PICK.
 *
 * Follows the same factory-with-deps pattern as runtime-life-lost.ts.
 * Owns the dialog lifecycle: create, tick (AI auto-pick), resolve.
 * Input handling lives in runtime-input.ts (keyboard/touch dispatch).
 */

import {
  UPGRADE_PICK_AUTO_DELAY,
  UPGRADE_PICK_MAX_TIMER,
  UPGRADE_PICK_PULSE_DURATION,
} from "../shared/core/game-constants.ts";
import { type ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { UpgradeId } from "../shared/core/upgrade-defs.ts";
import type {
  UpgradePickDialogState,
  UpgradePickEntry,
} from "../shared/ui/interaction-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  assertStateReady,
  type RuntimeState,
  setMode,
} from "./runtime-state.ts";
import {
  createUpgradePickDialog,
  moveUpgradePickFocus,
  resolveUpgradePickEntry,
  tickUpgradePickDialog,
} from "./runtime-upgrade-pick-core.ts";

interface UpgradePickSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly log: (msg: string) => void;
  readonly render: () => void;
  readonly sendUpgradePick: (
    playerId: ValidPlayerSlot,
    choice: UpgradeId,
  ) => void;
}

export interface UpgradePickSystem {
  /** Read current dialog state. Used by watcher-mode to sync overlay display. */
  get: () => UpgradePickDialogState | null;
  /** Replace dialog state. Used by watcher-mode to apply host-broadcast state. */
  set: (dialog: UpgradePickDialogState | null) => void;
  /** Try to show the upgrade pick dialog. Returns true if shown, false if skipped. */
  tryShow: (onDone: () => void) => boolean;
  /** Tick the dialog (AI auto-pick, timer). */
  tick: (dt: number) => void;
  /** Pre-create the dialog so it can render during the banner sweep (upgrade-pick only).
   *  Does NOT set Mode.UPGRADE_PICK — call tryShow after the banner ends. */
  prepare: () => boolean;
  /** Navigate focus left/right. */
  moveFocus: (playerId: ValidPlayerSlot, dir: number) => void;
  /** Confirm the currently focused choice. */
  confirmChoice: (playerId: ValidPlayerSlot) => void;
  /** Pick a specific card directly (e.g. from a click). */
  pickDirect: (playerId: ValidPlayerSlot, cardIdx: number) => void;
  /** Slots whose entries accept input from this machine (one slot online,
   *  every local human in shared-screen mode). Empty if none. */
  interactiveSlots: () => ReadonlySet<ValidPlayerSlot>;
}

const EMPTY_SLOT_SET: ReadonlySet<ValidPlayerSlot> = new Set();

export function createUpgradePickSystem(
  deps: UpgradePickSystemDeps,
): UpgradePickSystem {
  const { runtimeState } = deps;

  /** Callback to invoke when all picks are resolved. */
  let resolveCallback: (() => void) | undefined;

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
    assertStateReady(runtimeState);
    const dialog = ensureDialog();
    if (!dialog) return false;
    deps.log(
      `upgrade pick prepared: ${dialog.entries.length} players, round=${runtimeState.state.round}`,
    );
    return true;
  }

  function tryShow(onDone: () => void): boolean {
    assertStateReady(runtimeState);
    const dialog = ensureDialog();
    if (!dialog) return false;

    setMode(runtimeState, Mode.UPGRADE_PICK);
    resolveCallback = onDone;
    deps.log(
      `upgrade pick: ${dialog.entries.length} players, round=${runtimeState.state.round}`,
    );
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

    deps.render();

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
    // The machine's `runUpgradePickStep` owns the mutation sequence:
    // snapshot-for-banner → applyUpgradePicks → recheckTerritory. This
    // system just signals "all resolved" so that chain can run.
    //
    // NOTE: dialog is intentionally NOT cleared here. The next phase's
    // banner (build banner) needs the dialog state in place during its
    // sweep so `drawUpgradePick` can clip it progressively against
    // `banner.top` / `banner.bottom`. The `battle-done` and `ceasefire`
    // transitions in `runtime-phase-machine.ts` call
    // `clearUpgradePickDialog` from their postDisplay, after the build
    // banner finishes sweeping.
    const callback = resolveCallback;
    resolveCallback = undefined;
    callback?.();
  }

  function moveFocus(playerId: ValidPlayerSlot, dir: number): void {
    const entry = findPendingEntry(playerId);
    if (entry) moveUpgradePickFocus(entry, dir);
  }

  function resolveAndSend(entry: UpgradePickEntry, cardIdx: number): void {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return;
    const choice = resolveUpgradePickEntry(entry, cardIdx, dialog.timer);
    deps.sendUpgradePick(entry.playerId, choice);
  }

  function confirmChoice(playerId: ValidPlayerSlot): void {
    const entry = findPendingEntry(playerId);
    if (entry) resolveAndSend(entry, entry.focusedCard);
  }

  /** Pick a specific card directly (e.g. from a click on a card). */
  function pickDirect(playerId: ValidPlayerSlot, cardIdx: number): void {
    const entry = findPendingEntry(playerId);
    if (!entry || cardIdx < 0 || cardIdx >= entry.offers.length) return;
    resolveAndSend(entry, cardIdx);
  }

  function findPendingEntry(playerId: ValidPlayerSlot) {
    return runtimeState.dialogs.upgradePick?.entries.find(
      (entry) => entry.playerId === playerId && entry.choice === null,
    );
  }

  /** Slots whose entries accept input from this machine. An entry is locally
   *  driven when it doesn't auto-resolve and isn't owned by a remote peer —
   *  that resolves to `{myPlayerId}` online and to every local-human slot in
   *  shared-screen play. */
  function interactiveSlots(): ReadonlySet<ValidPlayerSlot> {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return EMPTY_SLOT_SET;
    const remote = runtimeState.frameMeta.remotePlayerSlots;
    const slots = new Set<ValidPlayerSlot>();
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
