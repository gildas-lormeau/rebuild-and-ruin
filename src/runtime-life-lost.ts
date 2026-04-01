/**
 * Life-lost dialog sub-system factory.
 *
 * Extracted from runtime.ts. Follows the same factory-with-deps
 * pattern as runtime-camera.ts and runtime-selection.ts.
 */

import { type GameMessage, MESSAGE } from "../server/protocol.ts";
import {
  type InputReceiver,
  isHuman,
  type PlayerController,
} from "./controller-interfaces.ts";
import { LIFE_LOST_AI_DELAY, LIFE_LOST_MAX_TIMER } from "./game-constants.ts";
import {
  createLifeLostDialogState,
  resolveAfterLifeLost,
  resolveLifeLostDialogRuntime,
  tickLifeLostDialogRuntime,
} from "./life-lost.ts";
import { eliminatePlayer } from "./phase-setup.ts";
import {
  handleLifeLostDialogClick as handleLifeLostDialogClickShared,
  lifeLostPanelPos as lifeLostPanelPosShared,
} from "./render-composition.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { RuntimeLifeLost } from "./runtime-types.ts";
import {
  LIFE_LOST_FOCUS_ABANDON,
  LIFE_LOST_FOCUS_CONTINUE,
  LifeLostChoice,
  type LifeLostDialogState,
  Mode,
  type ResolvedChoice,
} from "./types.ts";

interface LifeLostSystemDeps {
  runtimeState: RuntimeState;

  send: (msg: GameMessage) => void;
  log: (msg: string) => void;

  render: () => void;
  firstHuman: () => (PlayerController & InputReceiver) | null;
  endGame: (winner: { id: number }) => void;
  startReselection: () => void;
  advanceToCannonPhase: () => void;
}

/** Extended return type: RuntimeLifeLost + extras for game-runtime wiring. */
export type LifeLostSystem = RuntimeLifeLost & {
  sendLifeLostChoice: (choice: ResolvedChoice, playerId: number) => void;
  /** Toggle continue/abandon focus for a player's pending entry. */
  toggleFocus: (playerId: number) => void;
  /** Confirm the currently focused choice for a player. */
  confirmChoice: (playerId: number) => void;
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
      eliminatePlayer(player);
    }
  }

  function showLifeLostDialog(
    needsReselect: readonly number[],
    eliminated: readonly number[],
  ) {
    const remoteHumanSlots = runtimeState.frameCtx.remoteHumanSlots;
    deps.log(
      `showLifeLostDialog: needsReselect=[${needsReselect}] eliminated=[${eliminated}]`,
    );
    const dialog = createLifeLostDialogState({
      needsReselect,
      eliminated,
      state: runtimeState.state,
      isHost: runtimeState.frameCtx.isHost,
      myPlayerId: runtimeState.frameCtx.myPlayerId,
      remoteHumanSlots,
      isHumanController: (playerId) =>
        isHuman(runtimeState.controllers[playerId]!),
    });
    // Skip dialog if all entries are already resolved (e.g. only eliminations)
    if (allResolved(dialog)) {
      deps.log("showLifeLostDialog: all pre-resolved, skipping dialog");
      eliminateAbandoned(dialog);
      afterLifeLostResolved();
      return;
    }
    runtimeState.lifeLostDialog = dialog;
    runtimeState.mode = Mode.LIFE_LOST;
  }

  /**
   * Tick life-lost dialog — delegates resolution to one of two paths:
   *
   * - **Host**: resolveHostDialog eliminates abandoned players, then calls
   *   afterLifeLostResolved which decides: end game, start reselection, or
   *   advance to cannon phase.
   * - **Non-host**: onNonHostResolved eliminates abandoned players locally and
   *   returns to Mode.GAME, waiting for the server to drive the next phase.
   *
   * Both paths use eliminateAbandoned for player removal; only the host
   * triggers downstream phase transitions.
   */
  function tickLifeLostDialog(dt: number) {
    runtimeState.lifeLostDialog = tickLifeLostDialogRuntime({
      dt,
      lifeLostDialog: runtimeState.lifeLostDialog,
      lifeLostAiDelay: LIFE_LOST_AI_DELAY,
      lifeLostMaxTimer: LIFE_LOST_MAX_TIMER,
      isHost: runtimeState.frameCtx.isHost,
      render: deps.render,
      logResolved: (dialog) => {
        deps.log(
          `lifeLostDialog resolved: ${dialog.entries.map((e) => `P${e.playerId}=${e.choice}(ai=${e.isAi})`).join(", ")} timer=${dialog.timer.toFixed(1)}s`,
        );
      },
      resolveHostDialog: (dialog) => {
        eliminateAbandoned(dialog);
        return resolveLifeLostDialogRuntime({
          lifeLostDialog: dialog,
          afterLifeLostResolved,
        });
      },
      onNonHostResolved: (dialog) => {
        eliminateAbandoned(dialog);
        runtimeState.mode = Mode.GAME;
      },
    });
  }

  function afterLifeLostResolved(continuing: readonly number[] = []): boolean {
    return resolveAfterLifeLost({
      state: runtimeState.state,
      continuing,
      onEndGame: deps.endGame,
      onStartReselection: (players) => {
        runtimeState.reselectQueue = [...players];
        deps.startReselection();
        runtimeState.mode = Mode.SELECTION;
      },
      onAdvanceToCannonPhase: deps.advanceToCannonPhase,
    });
  }

  function lifeLostPanelPos(playerId: number): { px: number; py: number } {
    return lifeLostPanelPosShared(runtimeState.state, playerId);
  }

  function sendLifeLostChoice(choice: ResolvedChoice, playerId: number) {
    deps.send({ type: MESSAGE.LIFE_LOST_CHOICE, choice, playerId });
  }

  function findPendingEntry(playerId: number) {
    return runtimeState.lifeLostDialog?.entries.find(
      (e) => e.playerId === playerId && e.choice === LifeLostChoice.PENDING,
    );
  }

  function toggleFocus(playerId: number): void {
    const entry = findPendingEntry(playerId);
    if (entry)
      entry.focused =
        entry.focused === LIFE_LOST_FOCUS_CONTINUE
          ? LIFE_LOST_FOCUS_ABANDON
          : LIFE_LOST_FOCUS_CONTINUE;
  }

  function confirmChoice(playerId: number): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    entry.choice =
      entry.focused === LIFE_LOST_FOCUS_CONTINUE
        ? LifeLostChoice.CONTINUE
        : LifeLostChoice.ABANDON;
    sendLifeLostChoice(entry.choice, entry.playerId);
  }

  function lifeLostDialogClick(canvasX: number, canvasY: number) {
    if (!runtimeState.lifeLostDialog) return;
    const mousePlayer = deps.firstHuman();
    if (!mousePlayer) return;

    const choice = handleLifeLostDialogClickShared({
      state: runtimeState.state,
      lifeLostDialog: runtimeState.lifeLostDialog,
      screenX: canvasX,
      screenY: canvasY,
      firstHumanPlayerId: mousePlayer.playerId,
    });
    if (!choice) return;

    // Apply the choice to the dialog entry (mutation owned by game runtime, not render-composition)
    const entry = runtimeState.lifeLostDialog.entries.find(
      (e) => e.playerId === choice.playerId,
    );
    if (entry) entry.choice = choice.choice;
    sendLifeLostChoice(choice.choice, choice.playerId);
  }

  return {
    get: () => runtimeState.lifeLostDialog,
    set: (dialog: LifeLostDialogState | null) => {
      runtimeState.lifeLostDialog = dialog;
    },
    show: showLifeLostDialog,
    tick: tickLifeLostDialog,
    afterResolved: afterLifeLostResolved,
    panelPos: lifeLostPanelPos,
    click: lifeLostDialogClick,
    // Extra — needed by game-runtime internals
    sendLifeLostChoice,
    toggleFocus,
    confirmChoice,
  };
}
