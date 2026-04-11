/**
 * Game lifecycle sub-system — owns game start, reset, end, rematch,
 * and return-to-lobby transitions.
 *
 * `createGameLifecycle` is a pure orchestrator: it sequences dep calls
 * without accessing runtimeState directly. The companion `buildLifecycleDeps`
 * assembles the deps object from subsystem handles + runtimeState, keeping
 * the composition root (runtime-composition.ts) lean.
 */

import { DEMO_RETURN_DELAY_MS } from "../shared/core/game-constants.ts";
import type { ValidPlayerSlot } from "../shared/core/player-slot.ts";
import type { SoundSystem } from "../shared/core/system-interfaces.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameOverFocus,
} from "../shared/ui/interaction-types.ts";
import type {
  GameOverOverlay,
  PlayerStats,
} from "../shared/ui/overlay-types.ts";
import { Mode } from "../shared/ui/ui-mode.ts";
import {
  createEmptyGameStats,
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
  TimingApi,
} from "./runtime-types.ts";

interface GameLifecycleDeps {
  readonly log: (msg: string) => void;

  // Game start — composition root resolves settings and calls bootstrapGame
  readonly bootstrapNewGame: () => void | Promise<void>;

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
  readonly resetLifeLostDialog: () => void;
  readonly clearAllZoomState: () => void;
  readonly resetInputForLobby: () => void;

  // Demo timer (all-AI auto-return to lobby)
  readonly clearDemoTimer: () => void;
  readonly setDemoTimer: (callback: () => void, delay: number) => void;

  // Sound
  readonly soundReset: () => void;
  readonly soundGameOver: () => void;

  // Rendering / navigation
  readonly render: () => void;
  readonly requestMainLoop: () => void;
  readonly showLobby: () => void;

  // Game-over interaction
  readonly hitTestGameOver: (
    canvasX: number,
    canvasY: number,
  ) => GameOverFocus | null;
  readonly getGameOverFocused: () => GameOverFocus;
  readonly isTouchDevice: boolean;
}

interface GameLifecycleSystem {
  resetUIState: () => void;
  startGame: () => Promise<void>;
  endGame: (winner: { id: number }) => void;
  rematch: () => void | Promise<void>;
  returnToLobby: () => void;
  gameOverClick: (canvasX: number, canvasY: number) => void | Promise<void>;
}

interface LifecycleWiringDeps {
  readonly runtimeState: RuntimeState;
  readonly config: Pick<RuntimeConfig, "log" | "showLobby" | "onEndGame">;
  /** Injected timing primitives — replaces bare `globalThis.setTimeout` /
   *  `globalThis.clearTimeout` access in the demo-return timer. */
  readonly timing: TimingApi;
  readonly render: () => void;
  readonly requestMainLoop: () => void;
  readonly bootstrapNewGame: () => void | Promise<void>;

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
  readonly input: { resetForLobby: (rs: RuntimeState) => void };

  // Game-over UI
  readonly hitTestGameOver: (
    canvasX: number,
    canvasY: number,
  ) => GameOverFocus | null;
  readonly isTouchDevice: boolean;

  // Render-domain (injected from composition root)
  readonly buildGameOverOverlay: (
    winnerId: number,
    players: readonly {
      id: ValidPlayerSlot;
      score: number;
      eliminated: boolean;
      interior: ReadonlySet<number>;
    }[],
    gameStats: readonly PlayerStats[],
  ) => GameOverOverlay;
}

export function createGameLifecycle(
  deps: GameLifecycleDeps,
): GameLifecycleSystem {
  function resetUIState(): void {
    deps.clearDemoTimer();
    deps.resetAll();
  }

  async function startGame(): Promise<void> {
    await deps.bootstrapNewGame();
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

    deps.clearDemoTimer();
    if (deps.isAllAi()) {
      deps.setDemoTimer(() => {
        if (deps.isModeStopped()) returnToLobby();
      }, DEMO_RETURN_DELAY_MS);
    }
  }

  async function rematch(): Promise<void> {
    deps.clearDemoTimer();
    deps.clearGameOver();
    await startGame();
    // startGame() → enterTowerSelection() already sets mode=SELECTION and
    // lastTime, but its requestFrame guard skips rAF when mode ≠ STOPPED.
    deps.requestMainLoop();
  }

  function returnToLobby(): void {
    deps.clearDemoTimer();
    deps.resetScoreDeltas();
    deps.clearAllZoomState();
    deps.clearGameOver();
    deps.resetInputForLobby();
    deps.showLobby();
  }

  async function gameOverClick(
    canvasX: number,
    canvasY: number,
  ): Promise<void> {
    const hit = deps.hitTestGameOver(canvasX, canvasY);
    if (hit === FOCUS_REMATCH) {
      await rematch();
      return;
    }
    if (hit === FOCUS_MENU) {
      returnToLobby();
      return;
    }
    // Touch: tap-anywhere confirms the focused button (no hover cursor).
    // Mouse: miss is ignored so accidental clicks don't trigger actions.
    if (deps.isTouchDevice) {
      if (deps.getGameOverFocused() === FOCUS_REMATCH) await rematch();
      else returnToLobby();
    }
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

export function buildLifecycleDeps(
  wiringDeps: LifecycleWiringDeps,
): GameLifecycleDeps {
  const { runtimeState, config } = wiringDeps;
  return {
    log: config.log,
    bootstrapNewGame: wiringDeps.bootstrapNewGame,

    setGameOverFrame: (winner) => {
      runtimeState.frame.phantoms = {};
      runtimeState.frame.gameOver = wiringDeps.buildGameOverOverlay(
        winner.id,
        runtimeState.state.players,
        runtimeState.scoreDisplay.gameStats,
      );
    },
    onEndGame: config.onEndGame
      ? (winner) => config.onEndGame!(winner, runtimeState.state)
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
      wiringDeps.selection.reset();
      wiringDeps.banner.reset();
      resetTransientState(runtimeState);
      wiringDeps.getLifeLost().set(null);
      wiringDeps.getUpgradePick().set(null);
      wiringDeps.scoreDelta.reset();
      wiringDeps.camera.resetBattleCrosshair();
      runtimeState.scoreDisplay.gameStats = createEmptyGameStats();
      wiringDeps.camera.resetCamera();
      wiringDeps.sound.reset();
    },
    resetScoreDeltas: wiringDeps.scoreDelta.reset,
    resetLifeLostDialog: () => wiringDeps.getLifeLost().set(null),
    clearAllZoomState: wiringDeps.camera.clearAllZoomState,
    resetInputForLobby: () =>
      wiringDeps.input.resetForLobby(wiringDeps.runtimeState),

    clearDemoTimer: () => {
      if (runtimeState.demoReturnTimer !== undefined) {
        wiringDeps.timing.clearTimeout(runtimeState.demoReturnTimer);
        runtimeState.demoReturnTimer = undefined;
      }
    },
    setDemoTimer: (callback, delay) => {
      runtimeState.demoReturnTimer = wiringDeps.timing.setTimeout(() => {
        runtimeState.demoReturnTimer = undefined;
        callback();
      }, delay);
    },

    soundReset: wiringDeps.sound.reset,
    soundGameOver: wiringDeps.sound.gameOver,

    render: wiringDeps.render,
    requestMainLoop: wiringDeps.requestMainLoop,
    showLobby: config.showLobby,

    hitTestGameOver: wiringDeps.hitTestGameOver,
    getGameOverFocused: () =>
      runtimeState.frame.gameOver?.focused ?? FOCUS_REMATCH,
    isTouchDevice: wiringDeps.isTouchDevice,
  };
}
