/**
 * Life-lost dialog sub-system factory.
 *
 * Follows the modal dialog lifecycle contract (get/set/tryShow/tick) defined
 * in runtime-types.ts. Life-lost diverges from upgrade-pick in completion:
 * resolution is a separate method (`onResolved`) because life-lost has
 * multi-path outcomes (game over, reselection, or advance to cannon).
 * host-phase-ticks calls onResolved directly when all entries were
 * pre-resolved at dialog creation time.
 *
 * Extracted from runtime.ts. Follows the same factory-with-deps
 * pattern as runtime-camera.ts and runtime-selection.ts.
 */

import { dialogFacade } from "../game/dialog-facade.ts";
import {
  LIFE_LOST_AUTO_DELAY,
  LIFE_LOST_MAX_TIMER,
} from "../shared/game-constants.ts";
import {
  LIFE_LOST_FOCUS_ABANDON,
  LIFE_LOST_FOCUS_CONTINUE,
  LifeLostChoice,
  type LifeLostDialogState,
  type ResolvedChoice,
} from "../shared/interaction-types.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { isHuman } from "../shared/system-interfaces.ts";
import { Mode } from "../shared/ui-mode.ts";
import { type RuntimeState, setMode } from "./runtime-state.ts";
import type { RuntimeLifeLost } from "./runtime-types.ts";

interface LifeLostSystemDeps {
  runtimeState: RuntimeState;

  sendLifeLostChoice: (
    choice: ResolvedChoice,
    playerId: ValidPlayerSlot,
  ) => void;
  log: (msg: string) => void;

  render: () => void;
  panelPos: (playerId: ValidPlayerSlot) => { px: number; py: number };
  endGame: (winner: { id: number }) => void;
  startReselection: () => void;
  advanceToCannonPhase: () => void;
}

/** Extended return type: RuntimeLifeLost + extras for game-runtime wiring. */
export type LifeLostSystem = RuntimeLifeLost & {
  sendLifeLostChoice: (
    choice: ResolvedChoice,
    playerId: ValidPlayerSlot,
  ) => void;
  /** Toggle continue/abandon focus for a player's pending entry. */
  toggleFocus: (playerId: ValidPlayerSlot) => void;
  /** Confirm the currently focused choice for a player (applies the focused option). */
  confirmChoice: (playerId: ValidPlayerSlot) => void;
  /** Apply a direct choice (e.g. from spatial click on a specific button). */
  applyChoice: (playerId: ValidPlayerSlot, choice: ResolvedChoice) => void;
};

export function createLifeLostSystem(deps: LifeLostSystemDeps): LifeLostSystem {
  const { runtimeState } = deps;

  /** True when every entry has been resolved (no PENDING choices remain). */
  function allResolved(dialog: LifeLostDialogState): boolean {
    return dialog.entries.every((e) => e.choice !== LifeLostChoice.PENDING);
  }

  function eliminateAbandoned(dialog: LifeLostDialogState): void {
    for (const entry of dialog.entries) {
      if (entry.choice !== LifeLostChoice.ABANDON) continue;
      const player = runtimeState.state.players[entry.playerId];
      if (!player) continue;
      dialogFacade.eliminatePlayer(player);
    }
  }

  function tryShow(
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
  ): boolean {
    const remoteHumanSlots = runtimeState.frameMeta.remoteHumanSlots;
    deps.log(
      `tryShow lifeLost: needsReselect=[${needsReselect}] eliminated=[${eliminated}]`,
    );
    const dialog = dialogFacade.createLifeLostDialog({
      needsReselect,
      eliminated,
      state: runtimeState.state,
      hostAtFrameStart: runtimeState.frameMeta.hostAtFrameStart,
      myPlayerId: runtimeState.frameMeta.myPlayerId,
      remoteHumanSlots,
      isHumanController: (playerId) =>
        isHuman(runtimeState.controllers[playerId]!),
    });
    // Skip dialog if all entries are already resolved (e.g. only eliminations)
    if (allResolved(dialog)) {
      deps.log("tryShow lifeLost: all pre-resolved, skipping dialog");
      eliminateAbandoned(dialog);
      afterLifeLostResolved();
      return false;
    }
    runtimeState.dialogs.lifeLost = dialog;
    setMode(runtimeState, Mode.LIFE_LOST);
    return true;
  }

  /**
   * Tick life-lost dialog — resolution follows one of two paths:
   *
   * - **Host**: eliminates abandoned players, then afterLifeLostResolved
   *   decides: end game, start reselection, or advance to cannon phase.
   * - **Non-host**: eliminates abandoned players locally and returns to
   *   Mode.GAME, waiting for the server to drive the next phase.
   */
  function tickLifeLostDialogSystem(dt: number) {
    const dialog = runtimeState.dialogs.lifeLost;
    if (!dialog) return;

    const dialogResolved = dialogFacade.tickLifeLostDialog(
      dialog,
      dt,
      LIFE_LOST_AUTO_DELAY,
      LIFE_LOST_MAX_TIMER,
    );

    deps.render();

    if (!dialogResolved) return;

    deps.log(
      `lifeLostDialog resolved: ${dialog.entries.map((e) => `P${e.playerId}=${e.choice}(auto=${e.autoResolve})`).join(", ")} timer=${dialog.timer.toFixed(1)}s`,
    );

    eliminateAbandoned(dialog);

    if (runtimeState.frameMeta.hostAtFrameStart) {
      afterLifeLostResolved(dialogFacade.continuingPlayers(dialog));
    } else {
      setMode(runtimeState, Mode.GAME);
    }
    runtimeState.dialogs.lifeLost = null;
  }

  function afterLifeLostResolved(
    continuing: readonly ValidPlayerSlot[] = [],
  ): boolean {
    return dialogFacade.resolveAfterLifeLost({
      state: runtimeState.state,
      continuing,
      onGameOver: deps.endGame,
      onReselect: (players) => {
        runtimeState.selection.reselectQueue = [...players];
        deps.startReselection();
        setMode(runtimeState, Mode.SELECTION);
      },
      onContinue: deps.advanceToCannonPhase,
    });
  }

  function findPendingEntry(playerId: ValidPlayerSlot) {
    return runtimeState.dialogs.lifeLost?.entries.find(
      (e) => e.playerId === playerId && e.choice === LifeLostChoice.PENDING,
    );
  }

  function toggleFocus(playerId: ValidPlayerSlot): void {
    const entry = findPendingEntry(playerId);
    if (entry)
      entry.focusedButton =
        entry.focusedButton === LIFE_LOST_FOCUS_CONTINUE
          ? LIFE_LOST_FOCUS_ABANDON
          : LIFE_LOST_FOCUS_CONTINUE;
  }

  function confirmChoice(playerId: ValidPlayerSlot): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    entry.choice =
      entry.focusedButton === LIFE_LOST_FOCUS_CONTINUE
        ? LifeLostChoice.CONTINUE
        : LifeLostChoice.ABANDON;
    deps.sendLifeLostChoice(entry.choice, entry.playerId);
  }

  /** Apply a direct choice (e.g. from a mouse click on a specific button).
   *  Unlike confirmChoice, this sets the choice directly without reading focus. */
  function applyChoice(
    playerId: ValidPlayerSlot,
    choice: ResolvedChoice,
  ): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    entry.choice = choice;
    deps.sendLifeLostChoice(choice, playerId);
  }

  return {
    /** Read current dialog state. Used by watcher-mode to sync overlay display. */
    get: () => runtimeState.dialogs.lifeLost,
    /** Replace dialog state. Used by watcher-mode to apply host-broadcast state. */
    set: (dialog: LifeLostDialogState | null) => {
      runtimeState.dialogs.lifeLost = dialog;
    },
    tryShow,
    tick: tickLifeLostDialogSystem,
    onResolved: afterLifeLostResolved,
    panelPos: deps.panelPos,
    // Extra — needed by game-runtime internals
    sendLifeLostChoice: deps.sendLifeLostChoice,
    toggleFocus,
    confirmChoice,
    applyChoice,
  };
}
