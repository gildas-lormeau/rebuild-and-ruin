/**
 * Upgrade pick dialog sub-system factory.
 *
 * Follows the same factory-with-deps pattern as runtime-life-lost.ts.
 * Owns the dialog lifecycle: create, tick (AI auto-pick), resolve.
 * Input handling lives in the input layer (runtime-input.ts).
 */

import { type GameMessage, MESSAGE } from "../../server/protocol.ts";
import {
  applyUpgradePicks,
  createUpgradePickDialog,
  tickUpgradePickDialog,
  UPGRADE_PICK_AUTO_DELAY,
  UPGRADE_PICK_MAX_TIMER,
} from "../game/upgrade-pick.ts";
import type {
  UpgradePickDialogState,
  UpgradePickEntry,
} from "../shared/dialog-types.ts";
import { Mode } from "../shared/game-phase.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { isHuman } from "../shared/system-interfaces.ts";
import type { RuntimeState } from "./runtime-state.ts";

interface UpgradePickSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly log: (msg: string) => void;
  readonly render: () => void;
  readonly send?: (msg: GameMessage) => void;
}

export interface UpgradePickSystem {
  /** Try to show the upgrade pick dialog. Returns true if shown, false if skipped. */
  tryShow: (onDone: () => void) => boolean;
  /** Tick the dialog (AI auto-pick, timer). */
  tick: (dt: number) => void;
  /** Get the current dialog state. */
  get: () => UpgradePickDialogState | null;
  /** Set the dialog state (for online watcher). */
  set: (dialog: UpgradePickDialogState | null) => void;
  /** Navigate focus left/right. */
  moveFocus: (playerId: ValidPlayerSlot, dir: number) => void;
  /** Confirm the currently focused choice. */
  confirmChoice: (playerId: ValidPlayerSlot) => void;
  /** Pick a specific card directly (e.g. from a click). */
  pickDirect: (playerId: ValidPlayerSlot, cardIdx: number) => void;
}

export function createUpgradePickSystem(
  deps: UpgradePickSystemDeps,
): UpgradePickSystem {
  const { runtimeState } = deps;

  /** Callback to invoke when all picks are resolved. */
  let resolveCallback: (() => void) | null = null;

  function tryShow(onDone: () => void): boolean {
    const dialog = createUpgradePickDialog({
      state: runtimeState.state,
      hostAtFrameStart: runtimeState.frameMeta.hostAtFrameStart,
      myPlayerId: runtimeState.frameMeta.myPlayerId,
      remoteHumanSlots: runtimeState.frameMeta.remoteHumanSlots,
      isHumanController: (playerId) =>
        isHuman(runtimeState.controllers[playerId]!),
    });

    if (!dialog) return false;

    runtimeState.upgradePickDialog = dialog;
    runtimeState.mode = Mode.UPGRADE_PICK;
    resolveCallback = onDone;
    deps.log(
      `upgrade pick: ${dialog.entries.length} players, round=${runtimeState.state.round}`,
    );
    return true;
  }

  function tick(dt: number): void {
    const dialog = runtimeState.upgradePickDialog;
    if (!dialog) return;

    const allResolved = tickUpgradePickDialog(
      dialog,
      dt,
      UPGRADE_PICK_AUTO_DELAY,
      UPGRADE_PICK_MAX_TIMER,
      runtimeState.state,
    );

    deps.render();

    if (allResolved) {
      deps.log(
        `upgrade picks resolved: ${dialog.entries.map((entry) => `P${entry.playerId}=${entry.choice}`).join(", ")}`,
      );
      applyUpgradePicks(runtimeState.state, dialog);
      runtimeState.upgradePickDialog = null;
      const cb = resolveCallback;
      resolveCallback = null;
      cb?.();
    }
  }

  function moveFocus(playerId: ValidPlayerSlot, dir: number): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    entry.focusedCard =
      (entry.focusedCard + dir + entry.offers.length) % entry.offers.length;
  }

  function resolveEntry(entry: UpgradePickEntry, cardIdx: number): void {
    entry.focusedCard = cardIdx;
    const choice = entry.offers[cardIdx]!;
    entry.choice = choice;
    deps.send?.({
      type: MESSAGE.UPGRADE_PICK,
      playerId: entry.playerId,
      choice,
    });
  }

  function confirmChoice(playerId: ValidPlayerSlot): void {
    const entry = findPendingEntry(playerId);
    if (entry) resolveEntry(entry, entry.focusedCard);
  }

  /** Pick a specific card directly (e.g. from a click on a card). */
  function pickDirect(playerId: ValidPlayerSlot, cardIdx: number): void {
    const entry = findPendingEntry(playerId);
    if (!entry || cardIdx < 0 || cardIdx >= entry.offers.length) return;
    resolveEntry(entry, cardIdx);
  }

  function findPendingEntry(playerId: ValidPlayerSlot) {
    return runtimeState.upgradePickDialog?.entries.find(
      (entry) => entry.playerId === playerId && entry.choice === null,
    );
  }

  return {
    tryShow,
    tick,
    /** Read current dialog state. Used by watcher-mode to sync overlay display. */
    get: () => runtimeState.upgradePickDialog,
    /** Replace dialog state. Used by watcher-mode to apply host-broadcast state. */
    set: (dialog) => {
      runtimeState.upgradePickDialog = dialog;
    },
    moveFocus,
    confirmChoice,
    pickDirect,
  };
}
