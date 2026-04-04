/**
 * Game lifecycle sub-system — owns game start, reset, end, rematch,
 * and return-to-lobby transitions.
 *
 * `createGameLifecycle` is a pure orchestrator: it sequences dep calls
 * without accessing runtimeState directly. The companion `buildLifecycleDeps`
 * assembles the deps object from subsystem handles + runtimeState, keeping
 * the composition root (runtime.ts) lean.
 */

import { FOCUS_REMATCH } from "../shared/dialog-types.ts";
import { Mode } from "../shared/game-phase.ts";
import {
  getPlayerColor,
  MAX_PLAYERS,
  PLAYER_NAMES,
} from "../shared/player-config.ts";
import type { SoundSystem } from "../shared/system-interfaces.ts";
import {
  type RuntimeState,
  resetTransientState,
  setMode,
} from "./runtime-state.ts";
import type {
  CameraSystem,
  RuntimeConfig,
  RuntimeLifeLost,
  RuntimeSelection,
  RuntimeUpgradePick,
} from "./runtime-types.ts";

type GameOverAction = "rematch" | "menu" | null;

interface GameLifecycleDeps {
  readonly log: (msg: string) => void;

  // Game start — composition root resolves settings and calls bootstrapGame
  readonly bootstrapNewGame: () => void;

  // Game end
  readonly setGameOverFrame: (winner: { id: number }) => void;
  readonly onEndGame?: (winner: { id: number }) => void;
  readonly isAllAi: () => boolean;
  readonly isModeStopped: () => boolean;

  // Atomic state transitions
  readonly setModeStopped: () => void;
  readonly clearGameOver: () => void;

  // Subsystem resets
  readonly resetAll: () => void;
  readonly resetScoreDeltas: () => void;
  readonly resetDialogs: () => void;
  readonly resetLifeLostDialog: () => void;
  readonly clearAllZoomState: () => void;
  readonly resetInputForLobby: () => void;

  // Sound
  readonly soundReset: () => void;
  readonly soundGameOver: () => void;

  // Rendering / navigation
  readonly render: () => void;
  readonly requestMainLoop: () => void;
  readonly showLobby: () => void;

  // Game over interaction — returns GAME_OVER_REMATCH, GAME_OVER_MENU, or null
  readonly resolveGameOverAction: (
    canvasX: number,
    canvasY: number,
  ) => GameOverAction;
}

interface GameLifecycleSystem {
  resetUIState: () => void;
  startGame: () => void;
  endGame: (winner: { id: number }) => void;
  rematch: () => void;
  returnToLobby: () => void;
  gameOverClick: (canvasX: number, canvasY: number) => void;
}

interface LifecycleWiringDeps {
  readonly runtimeState: RuntimeState;
  readonly config: Pick<RuntimeConfig, "log" | "showLobby" | "onlineConfig">;
  readonly render: () => void;
  readonly requestMainLoop: () => void;
  readonly bootstrapNewGame: () => void;

  // Subsystems needed for reset/cleanup
  readonly selection: Pick<RuntimeSelection, "reset">;
  readonly banner: { reset: () => void };
  readonly camera: Pick<
    CameraSystem,
    "clearAllZoomState" | "resetBattleCrosshair" | "resetCamera"
  >;
  readonly getLifeLost: () => Pick<RuntimeLifeLost, "set">;
  readonly getUpgradePick: () => Pick<RuntimeUpgradePick, "set">;
  readonly scoreDelta: { reset: () => void };
  readonly sound: Pick<SoundSystem, "reset" | "gameOver">;
  readonly input: { resetForLobby: () => void };

  // Game-over UI (built by caller — needs render-layer imports)
  readonly resolveGameOverAction: (
    canvasX: number,
    canvasY: number,
  ) => GameOverAction;
}

const DEMO_RETURN_DELAY_MS = 10_000;
/** Game-over action constants shared with composition root (resolveGameOverAction). */
export const GAME_OVER_REMATCH = "rematch";
export const GAME_OVER_MENU = "menu";

export function createGameLifecycle(
  deps: GameLifecycleDeps,
): GameLifecycleSystem {
  // -------------------------------------------------------------------------
  // Demo timer (lifecycle-local state — not runtimeState)
  // -------------------------------------------------------------------------

  let demoReturnTimer: number | null = null;

  function clearDemoTimer(): void {
    if (demoReturnTimer !== null) {
      clearTimeout(demoReturnTimer);
      demoReturnTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle operations
  // -------------------------------------------------------------------------

  function resetUIState(): void {
    clearDemoTimer();
    deps.resetAll();
  }

  function startGame(): void {
    deps.bootstrapNewGame();
  }

  function endGame(winner: { id: number }): void {
    deps.resetScoreDeltas();
    deps.resetLifeLostDialog();
    deps.clearAllZoomState();
    deps.onEndGame?.(winner);
    deps.soundReset();
    deps.soundGameOver();
    deps.setGameOverFrame(winner);
    deps.render();
    deps.setModeStopped();

    clearDemoTimer();
    if (deps.isAllAi()) {
      demoReturnTimer = window.setTimeout(() => {
        demoReturnTimer = null;
        if (deps.isModeStopped()) returnToLobby();
      }, DEMO_RETURN_DELAY_MS);
    }
  }

  function rematch(): void {
    clearDemoTimer();
    deps.clearGameOver();
    startGame();
    // startGame() → enterTowerSelection() already sets mode=SELECTION and
    // lastTime, but its requestFrame guard skips rAF when mode ≠ STOPPED.
    deps.requestMainLoop();
  }

  function returnToLobby(): void {
    clearDemoTimer();
    deps.resetScoreDeltas();
    deps.clearAllZoomState();
    deps.clearGameOver();
    deps.resetInputForLobby();
    deps.showLobby();
  }

  function gameOverClick(canvasX: number, canvasY: number): void {
    const action = deps.resolveGameOverAction(canvasX, canvasY);
    if (action === GAME_OVER_REMATCH) rematch();
    else if (action === GAME_OVER_MENU) returnToLobby();
  }

  return {
    resetUIState,
    startGame,
    endGame,
    rematch,
    returnToLobby,
    gameOverClick,
  };
}

export function buildLifecycleDeps(wd: LifecycleWiringDeps): GameLifecycleDeps {
  const { runtimeState, config } = wd;
  return {
    log: config.log,
    bootstrapNewGame: wd.bootstrapNewGame,

    setGameOverFrame: (winner) => {
      const name = PLAYER_NAMES[winner.id] ?? `Player ${winner.id + 1}`;
      runtimeState.frame.gameOver = {
        winner: name,
        scores: runtimeState.state.players.map((player) => ({
          name: PLAYER_NAMES[player.id] ?? `P${player.id + 1}`,
          score: player.score,
          color: getPlayerColor(player.id).wall,
          eliminated: player.eliminated,
          territory: player.interior.size,
          stats: runtimeState.scoreDisplay.gameStats[player.id],
        })),
        focused: FOCUS_REMATCH,
      };
    },
    onEndGame: config.onlineConfig?.onEndGame
      ? (winner) => config.onlineConfig!.onEndGame(winner, runtimeState.state)
      : undefined,
    isAllAi: () => runtimeState.lobby.joined.every((joined) => !joined),
    isModeStopped: () => runtimeState.mode === Mode.STOPPED,

    setModeStopped: () => {
      setMode(runtimeState, Mode.STOPPED);
    },
    clearGameOver: () => {
      runtimeState.frame.gameOver = undefined;
    },

    resetAll: () => {
      wd.selection.reset();
      wd.banner.reset();
      resetTransientState(runtimeState);
      wd.getLifeLost().set(null);
      wd.getUpgradePick().set(null);
      wd.scoreDelta.reset();
      wd.camera.resetBattleCrosshair();
      runtimeState.scoreDisplay.gameStats = Array.from(
        { length: MAX_PLAYERS },
        () => ({ wallsDestroyed: 0, cannonsKilled: 0 }),
      );
      wd.camera.resetCamera();
      wd.sound.reset();
    },
    resetScoreDeltas: wd.scoreDelta.reset,
    resetDialogs: () => {
      wd.getLifeLost().set(null);
      wd.getUpgradePick().set(null);
    },
    resetLifeLostDialog: () => wd.getLifeLost().set(null),
    clearAllZoomState: wd.camera.clearAllZoomState,
    resetInputForLobby: wd.input.resetForLobby,

    soundReset: wd.sound.reset,
    soundGameOver: wd.sound.gameOver,

    render: wd.render,
    requestMainLoop: wd.requestMainLoop,
    showLobby: config.showLobby,

    resolveGameOverAction: wd.resolveGameOverAction,
  };
}
