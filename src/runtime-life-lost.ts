/**
 * Life-lost dialog sub-system factory.
 *
 * Extracted from game-runtime.ts. Follows the same factory-with-deps
 * pattern as runtime-camera.ts and runtime-selection.ts.
 */

import { type GameMessage, MSG } from "../server/protocol.ts";
import { isHuman } from "./controller-factory.ts";
import type { InputReceiver, PlayerController } from "./controller-interfaces.ts";
import type { RuntimeLifeLost } from "./game-runtime-types.ts";
import {
  buildLifeLostDialogState,
  LifeLostChoice,
  type LifeLostDialogState,
  type ResolvedChoice,
  resolveAfterLifeLost,
  resolveLifeLostDialogRuntime,
  tickLifeLostDialogRuntime,
} from "./life-lost.ts";
import {
  handleLifeLostDialogClick as handleLifeLostDialogClickShared,
  lifeLostPanelPos as lifeLostPanelPosShared,
} from "./render-composition.ts";
import type { RuntimeState } from "./runtime-state.ts";
import { LIFE_LOST_AI_DELAY, LIFE_LOST_MAX_TIMER, Mode } from "./types.ts";

interface LifeLostSystemDeps {
  rs: RuntimeState;

  send: (msg: GameMessage) => void;
  log: (msg: string) => void;

  render: () => void;
  firstHuman: () => (PlayerController & InputReceiver) | null;
  endGame: (winner: { id: number } | null) => void;
  startReselection: () => void;
  advanceToCannonPhase: () => void;
}

/** Extended return type: RuntimeLifeLost + extras for game-runtime wiring. */
export type LifeLostSystem = RuntimeLifeLost & {
  sendLifeLostChoice: (choice: ResolvedChoice, playerId: number) => void;
};

export function createLifeLostSystem(deps: LifeLostSystemDeps): LifeLostSystem {
  const { rs } = deps;

  function eliminateAbandoned(dialog: LifeLostDialogState): void {
    for (const entry of dialog.entries) {
      if (entry.choice !== LifeLostChoice.ABANDON) continue;
      const player = rs.state.players[entry.playerId];
      if (!player) continue;
      player.eliminated = true;
      player.lives = 0;
    }
  }

  function showLifeLostDialog(needsReselect: readonly number[], eliminated: readonly number[]) {
    const remoteHumanSlots = rs.ctx.remoteHumanSlots;
    deps.log(
      `showLifeLostDialog: needsReselect=[${needsReselect}] eliminated=[${eliminated}]`,
    );
    rs.lifeLostDialog = buildLifeLostDialogState({
      needsReselect,
      eliminated,
      state: rs.state,
      isHost: rs.ctx.isHost,
      myPlayerId: rs.ctx.myPlayerId,
      remoteHumanSlots,
      isHumanController: (playerId) => isHuman(rs.controllers[playerId]!),
    });
    rs.mode = Mode.LIFE_LOST;
  }

  function tickLifeLostDialog(dt: number) {
    rs.lifeLostDialog = tickLifeLostDialogRuntime({
      dt,
      lifeLostDialog: rs.lifeLostDialog,
      lifeLostAiDelay: LIFE_LOST_AI_DELAY,
      lifeLostMaxTimer: LIFE_LOST_MAX_TIMER,
      isHost: rs.ctx.isHost,
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
        rs.mode = Mode.GAME;
      },
    });
  }

  function afterLifeLostResolved(continuing: readonly number[] = []): boolean {
    return resolveAfterLifeLost({
      state: rs.state,
      continuing,
      onEndGame: deps.endGame,
      onStartReselection: (players) => {
        rs.reselectQueue = [...players];
        deps.startReselection();
        rs.mode = Mode.SELECTION;
      },
      onAdvanceToCannonPhase: deps.advanceToCannonPhase,
    });
  }

  function lifeLostPanelPos(playerId: number): { px: number; py: number } {
    return lifeLostPanelPosShared(rs.state, playerId);
  }

  function sendLifeLostChoice(choice: ResolvedChoice, playerId: number) {
    deps.send({ type: MSG.LIFE_LOST_CHOICE, choice, playerId });
  }

  function lifeLostDialogClick(canvasX: number, canvasY: number) {
    if (!rs.lifeLostDialog) return;
    const mousePlayer = deps.firstHuman();
    if (!mousePlayer) return;

    const choice = handleLifeLostDialogClickShared({
      state: rs.state,
      lifeLostDialog: rs.lifeLostDialog,
      canvasX,
      canvasY,
      firstHumanPlayerId: mousePlayer.playerId,
    });
    if (!choice) return;

    // Apply the choice to the dialog entry (mutation owned by game runtime, not render-composition)
    const entry = rs.lifeLostDialog.entries.find(e => e.playerId === choice.playerId);
    if (entry) entry.choice = choice.choice;
    sendLifeLostChoice(choice.choice, choice.playerId);
  }

  return {
    get: () => rs.lifeLostDialog,
    set: (d: LifeLostDialogState | null) => { rs.lifeLostDialog = d; },
    show: showLifeLostDialog,
    tick: tickLifeLostDialog,
    afterResolved: afterLifeLostResolved,
    panelPos: lifeLostPanelPos,
    click: lifeLostDialogClick,
    // Extra — needed by game-runtime internals
    sendLifeLostChoice,
  };
}
