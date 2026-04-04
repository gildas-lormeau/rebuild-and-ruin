/**
 * Game lifecycle sub-system — owns game start, reset, end, rematch,
 * and return-to-lobby transitions.
 *
 * Pure orchestrator: sequences dep calls without accessing runtimeState
 * or importing domain constants. All state mutations and domain knowledge
 * (settings resolution, score rendering, coordinate math) live in the
 * composition root (runtime.ts) and are injected via deps.
 */

/** How long to show the winner screen before auto-returning to lobby in demo mode. */

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

  /** Delayed-callback scheduler (injected for testability). */
  readonly scheduleTimeout: (cb: () => void, ms: number) => number;
  /** Cancel a scheduled timeout (injected for testability). */
  readonly cancelTimeout: (id: number) => void;

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
      deps.cancelTimeout(demoReturnTimer);
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
      demoReturnTimer = deps.scheduleTimeout(() => {
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
