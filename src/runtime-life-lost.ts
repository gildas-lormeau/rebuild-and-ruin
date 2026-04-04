/**
 * Life-lost dialog sub-system factory.
 *
 * Extracted from runtime.ts. Follows the same factory-with-deps
 * pattern as runtime-camera.ts and runtime-selection.ts.
 */

import { type GameMessage, MESSAGE } from "../server/protocol.ts";
import { isHuman } from "./controller-interfaces.ts";
import {
  LIFE_LOST_FOCUS_ABANDON,
  LIFE_LOST_FOCUS_CONTINUE,
  LifeLostChoice,
  type LifeLostDialogState,
  type ResolvedChoice,
} from "./dialog-types.ts";
import { LIFE_LOST_AUTO_DELAY, LIFE_LOST_MAX_TIMER } from "./game-constants.ts";
import { resolveAfterLifeLost } from "./game-engine.ts";
import { Mode } from "./game-phase.ts";
import {
  continuingPlayers,
  createLifeLostDialogState,
  tickLifeLostDialog,
} from "./life-lost.ts";
import { eliminatePlayer } from "./phase-setup.ts";
import type { ValidPlayerSlot } from "./player-slot.ts";
import { lifeLostPanelPos as lifeLostPanelPosShared } from "./render-composition.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { RuntimeLifeLost } from "./runtime-types.ts";

interface LifeLostSystemDeps {
  runtimeState: RuntimeState;

  send: (msg: GameMessage) => void;
  log: (msg: string) => void;

  render: () => void;
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
      eliminatePlayer(player);
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
    const dialog = createLifeLostDialogState({
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
    runtimeState.lifeLostDialog = dialog;
    runtimeState.mode = Mode.LIFE_LOST;
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
    const dialog = runtimeState.lifeLostDialog;
    if (!dialog) return;

    const dialogResolved = tickLifeLostDialog(
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
      afterLifeLostResolved(continuingPlayers(dialog));
    } else {
      runtimeState.mode = Mode.GAME;
    }
    runtimeState.lifeLostDialog = null;
  }

  function afterLifeLostResolved(
    continuing: readonly ValidPlayerSlot[] = [],
  ): boolean {
    return resolveAfterLifeLost({
      state: runtimeState.state,
      continuing,
      onGameOver: deps.endGame,
      onReselect: (players) => {
        runtimeState.reselectQueue = [...players];
        deps.startReselection();
        runtimeState.mode = Mode.SELECTION;
      },
      onContinue: deps.advanceToCannonPhase,
    });
  }

  function lifeLostPanelPos(playerId: ValidPlayerSlot): {
    px: number;
    py: number;
  } {
    return lifeLostPanelPosShared(runtimeState.state, playerId);
  }

  function sendLifeLostChoice(
    choice: ResolvedChoice,
    playerId: ValidPlayerSlot,
  ) {
    deps.send({ type: MESSAGE.LIFE_LOST_CHOICE, choice, playerId });
  }

  function findPendingEntry(playerId: ValidPlayerSlot) {
    return runtimeState.lifeLostDialog?.entries.find(
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
    sendLifeLostChoice(entry.choice, entry.playerId);
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
    sendLifeLostChoice(choice, playerId);
  }

  return {
    get: () => runtimeState.lifeLostDialog,
    set: (dialog: LifeLostDialogState | null) => {
      runtimeState.lifeLostDialog = dialog;
    },
    tryShow,
    tick: tickLifeLostDialogSystem,
    afterResolved: afterLifeLostResolved,
    panelPos: lifeLostPanelPos,
    // Extra — needed by game-runtime internals
    sendLifeLostChoice,
    toggleFocus,
    confirmChoice,
    applyChoice,
  };
}
