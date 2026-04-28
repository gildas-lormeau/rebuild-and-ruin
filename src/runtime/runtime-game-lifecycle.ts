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
import type { TimingApi } from "./runtime-contracts.ts";
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
  readonly resetGameStats: () => void;
  readonly resetLifeLostDialog: () => void;
  readonly clearAllZoomState: () => void;
  readonly clearLobbyMap: () => void;
  readonly resetInputForLobby: () => void;

  // Demo timer (all-AI auto-return to lobby)
  readonly clearDemoTimer: () => void;
  readonly setDemoTimer: (callback: () => void, delay: number) => void;

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
  teardownSession: () => void;
  finalizeGameOver: (setFrame: () => void) => void;
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

  function teardownSession(): void {
    deps.clearDemoTimer();
    deps.resetScoreDeltas();
    deps.clearAllZoomState();
    deps.resetLifeLostDialog();
    deps.resetGameStats();
  }

  /** Shared terminal sequence for game-over: snapshot the game-over frame
   *  (host builds from live state, watcher copies authoritative scores from
   *  MESSAGE.GAME_OVER, watcher's local detection passes a no-op and waits
   *  for the message), then clean up display caches, then render + stop the
   *  loop. The frame is built first so it captures live `gameStats` before
   *  `teardownSession` zeros them. Idempotent — safe to call twice if the
   *  watcher's local path fires before MESSAGE.GAME_OVER arrives. */
  function finalizeGameOver(setFrame: () => void): void {
    setFrame();
    teardownSession();
    deps.render();
    deps.setModeStopped();
  }

  function endGame(winner: { id: number }): void {
    finalizeGameOver(() => deps.setGameOverFrame(winner));
    deps.onEndGame?.(winner);

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
    // Clear stale per-phase pinch memory + viewport targets from the
    // game we just quit so the lobby's background demo doesn't snap to
    // the previous human's favourite zoom when it reaches that phase.
    // The mobile-auto-zoom predicate (`mobileAutoZoomActive` in the
    // camera system) already gates on `hasPointerPlayer`, so the demo
    // session reads as inactive regardless of `zoomActivated`'s value.
    teardownSession();
    // Drop the cached lobby map so the next `bootstrapGame` regenerates
    // from scratch instead of reusing the just-quit game's mutated map
    // (houses spawned during play, tiles mutated by modifiers, etc.).
    // Production's `main.ts::showLobby` also nulls this out, but doing
    // it here guarantees the contract regardless of which `showLobby`
    // implementation the runtime was configured with — the headless
    // test stub is a no-op, and we shouldn't require every caller to
    // remember this step.
    deps.clearLobbyMap();
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
    teardownSession,
    finalizeGameOver,
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
    },
    resetScoreDeltas: wiringDeps.scoreDelta.reset,
    resetGameStats: () => {
      runtimeState.scoreDisplay.gameStats = createEmptyGameStats();
    },
    resetLifeLostDialog: () => wiringDeps.getLifeLost().set(null),
    clearAllZoomState: wiringDeps.camera.clearAllZoomState,
    clearLobbyMap: () => {
      runtimeState.lobby.map = null;
    },
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

    render: wiringDeps.render,
    requestMainLoop: wiringDeps.requestMainLoop,
    showLobby: config.showLobby,

    hitTestGameOver: wiringDeps.hitTestGameOver,
    getGameOverFocused: () =>
      runtimeState.frame.gameOver?.focused ?? FOCUS_REMATCH,
    isTouchDevice: wiringDeps.isTouchDevice,
  };
}
