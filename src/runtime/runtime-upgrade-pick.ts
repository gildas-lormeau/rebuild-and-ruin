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

import { dialogFacade } from "../game/dialog-facade.ts";
import type {
  UpgradePickDialogState,
  UpgradePickEntry,
} from "../shared/interaction-types.ts";
import {
  type PlayerSlotId,
  SPECTATOR_SLOT,
  type ValidPlayerSlot,
} from "../shared/player-slot.ts";
import { isHuman } from "../shared/system-interfaces.ts";
import { Mode } from "../shared/ui-mode.ts";
import type { UpgradeId } from "../shared/upgrade-defs.ts";
import {
  assertStateReady,
  type RuntimeState,
  setMode,
} from "./runtime-state.ts";

interface UpgradePickSystemDeps {
  readonly runtimeState: RuntimeState;
  readonly log: (msg: string) => void;
  readonly render: () => void;
  readonly sendUpgradePick?: (
    playerId: ValidPlayerSlot,
    choice: UpgradeId,
  ) => void;
  /** AI-aware upgrade pick callback. Injected from composition root so
   *  this subsystem doesn't import from ai/ directly. */
  readonly aiPick: (
    offers: readonly [UpgradeId, UpgradeId, UpgradeId],
    playerId: ValidPlayerSlot,
  ) => UpgradeId;
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
  /** Which player's entry accepts local input (SPECTATOR_SLOT if none). */
  interactivePlayerId: () => PlayerSlotId;
}

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
    const dialog = dialogFacade.createUpgradePickDialog({
      state: runtimeState.state,
      hostAtFrameStart: runtimeState.frameMeta.hostAtFrameStart,
      myPlayerId: runtimeState.frameMeta.myPlayerId,
      remotePlayerSlots: runtimeState.frameMeta.remotePlayerSlots,
      isHumanController: (playerId) =>
        isHuman(runtimeState.controllers[playerId]!),
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

    const allResolved = dialogFacade.tickUpgradePickDialog(
      dialog,
      dt,
      dialogFacade.UPGRADE_PICK_AUTO_DELAY,
      dialogFacade.UPGRADE_PICK_MAX_TIMER,
      runtimeState.state,
      deps.aiPick,
    );

    deps.render();

    if (allResolved) {
      deps.log(
        `upgrade picks resolved: ${dialog.entries.map((entry) => `P${entry.playerId}=${entry.choice}`).join(", ")}`,
      );
      dialogFacade.applyUpgradePicks(runtimeState.state, dialog);
      runtimeState.dialogs.upgradePick = null;
      const callback = resolveCallback;
      resolveCallback = undefined;
      callback?.();
    }
  }

  function moveFocus(playerId: ValidPlayerSlot, dir: number): void {
    const entry = findPendingEntry(playerId);
    if (entry) dialogFacade.moveUpgradePickFocus(entry, dir);
  }

  function resolveAndSend(entry: UpgradePickEntry, cardIdx: number): void {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return;
    const choice = dialogFacade.resolveUpgradePickEntry(
      entry,
      cardIdx,
      dialog.timer,
    );
    deps.sendUpgradePick?.(entry.playerId, choice);
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

  /** Compute which player's upgrade pick entry accepts local input.
   *  Returns the player ID, or SPECTATOR_SLOT if no local player is picking. */
  function interactivePlayerId(): PlayerSlotId {
    const dialog = runtimeState.dialogs.upgradePick;
    if (!dialog) return SPECTATOR_SLOT;
    const myId = runtimeState.frameMeta.myPlayerId;
    const entry = dialog.entries.find(
      (entry) =>
        entry.playerId === myId && !entry.autoResolve && entry.choice === null,
    );
    return entry ? (entry.playerId as PlayerSlotId) : SPECTATOR_SLOT;
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
    interactivePlayerId,
  };
}
