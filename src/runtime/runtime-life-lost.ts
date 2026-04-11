import {
  LIFE_LOST_AUTO_DELAY,
  LIFE_LOST_MAX_TIMER,
} from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import { isHuman } from "../shared/core/system-interfaces.ts";
import {
  LifeLostChoice,
  type LifeLostDialogState,
  type LifeLostEntry,
  type ResolvedChoice,
} from "../shared/ui/interaction-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  applyLifeLostChoice,
  confirmLifeLostFocusedChoice,
  continuingPlayers,
  createLifeLostDialogState,
  eliminateAbandoned,
  isLifeLostAllResolved,
  resolveAfterLifeLost,
  tickLifeLostDialog,
  toggleLifeLostFocus,
} from "./runtime-life-lost-core.ts";
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
  /** AI decision for auto-resolving life-lost entries. Wired by the
   *  composition root (`runtime-composition.ts`) from `ai/ai-life-lost.ts`. Subsystems
   *  can't import from ai/ directly — only the root may. */
  aiChoose: (entry: LifeLostEntry) => ResolvedChoice;
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

  function tryShow(
    needsReselect: readonly ValidPlayerSlot[],
    eliminated: readonly ValidPlayerSlot[],
  ): boolean {
    const remotePlayerSlots = runtimeState.frameMeta.remotePlayerSlots;
    deps.log(
      `tryShow lifeLost: needsReselect=[${needsReselect}] eliminated=[${eliminated}]`,
    );
    const dialog = createLifeLostDialogState({
      needsReselect,
      eliminated,
      state: runtimeState.state,
      hostAtFrameStart: runtimeState.frameMeta.hostAtFrameStart,
      myPlayerId: runtimeState.frameMeta.myPlayerId,
      remotePlayerSlots,
      isHumanController: (playerId) =>
        isHuman(runtimeState.controllers[playerId]!),
    });
    // Skip dialog if all entries are already resolved (e.g. only eliminations)
    if (isLifeLostAllResolved(dialog)) {
      deps.log("tryShow lifeLost: all pre-resolved, skipping dialog");
      eliminateAbandoned(dialog, runtimeState.state);
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

    const dialogResolved = tickLifeLostDialog(
      dialog,
      dt,
      LIFE_LOST_AUTO_DELAY,
      LIFE_LOST_MAX_TIMER,
      deps.aiChoose,
    );

    deps.render();

    if (!dialogResolved) return;

    deps.log(
      `lifeLostDialog resolved: ${dialog.entries.map((e) => `P${e.playerId}=${e.choice}(auto=${e.autoResolve})`).join(", ")} timer=${dialog.timer.toFixed(1)}s`,
    );

    eliminateAbandoned(dialog, runtimeState.state);

    if (runtimeState.frameMeta.hostAtFrameStart) {
      afterLifeLostResolved(continuingPlayers(dialog));
    } else {
      setMode(runtimeState, Mode.GAME);
    }
    runtimeState.dialogs.lifeLost = null;
  }

  function afterLifeLostResolved(
    continuing: readonly ValidPlayerSlot[] = [],
  ): boolean {
    return resolveAfterLifeLost({
      state: runtimeState.state,
      continuing,
      onGameOver: deps.endGame,
      onReselect: (players) => {
        runtimeState.selection.reselectQueue = [...players];
        deps.startReselection();
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
    if (entry) toggleLifeLostFocus(entry);
  }

  function confirmChoice(playerId: ValidPlayerSlot): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    const choice = confirmLifeLostFocusedChoice(entry);
    deps.sendLifeLostChoice(choice, entry.playerId);
  }

  /** Apply a direct choice (e.g. from a mouse click on a specific button).
   *  Unlike confirmChoice, this sets the choice directly without reading focus. */
  function applyChoice(
    playerId: ValidPlayerSlot,
    choice: ResolvedChoice,
  ): void {
    const entry = findPendingEntry(playerId);
    if (!entry) return;
    applyLifeLostChoice(entry, choice);
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
