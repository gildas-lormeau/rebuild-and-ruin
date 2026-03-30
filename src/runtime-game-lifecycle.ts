/**
 * Game lifecycle sub-system — owns game start, reset, end, rematch,
 * and return-to-lobby transitions.
 *
 * Extracted from runtime.ts to keep it a pure composition root.
 * Follows the factory-with-deps pattern used by other runtime-*.ts files.
 */

import { createController } from "./controller-factory.ts";
import type { PlayerController } from "./controller-interfaces.ts";
import { CANNON_HP_OPTIONS, ROUNDS_OPTIONS } from "./game-ui-types.ts";
import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "./grid.ts";
import { createBannerState } from "./phase-banner.ts";
import {
  DIFFICULTY_PARAMS,
  getPlayerColor,
  MAX_PLAYERS,
  NO_WINNER_NAME,
  PLAYER_KEY_BINDINGS,
  PLAYER_NAMES,
} from "./player-config.ts";
import { gameOverButtonHitTest } from "./render-composition.ts";
import { MAX_UINT32 } from "./rng.ts";
import { bootstrapGame } from "./runtime-bootstrap.ts";
import { NO_SLOT, type RuntimeState } from "./runtime-state.ts";
import type { CameraSystem } from "./runtime-types.ts";
import type { SoundSystem } from "./sound-system.ts";
import {
  createBattleAnimState,
  createTimerAccums,
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameState,
  Mode,
} from "./types.ts";

interface GameLifecycleDeps {
  readonly runtimeState: RuntimeState;

  // Config / networking
  readonly log: (msg: string) => void;
  readonly showLobby: () => void;
  readonly onEndGame?: (
    winner: { id: number } | null,
    state: GameState,
  ) => void;

  // Sub-systems
  readonly camera: Pick<CameraSystem, "resetCamera" | "fullUnzoom">;
  readonly sound: Pick<SoundSystem, "reset" | "gameOver">;
  readonly selection: { enter: () => void };

  // Late-bound callbacks (resolved at call time via closures)
  readonly render: () => void;
  readonly clearFrameData: () => void;
  readonly requestMainLoop: () => void;
  readonly resetTouchForLobby: () => void;
  readonly resetBattleCrosshair: () => void;
}

interface GameLifecycleSystem {
  resetGameStats: () => void;
  resetUIState: () => void;
  startGame: () => void;
  endGame: (winner: { id: number } | null) => void;
  rematch: () => void;
  returnToLobby: () => void;
  gameOverClick: (canvasX: number, canvasY: number) => void;
}

/** How long to show the winner screen before auto-returning to lobby in demo mode. */
const DEMO_RETURN_DELAY_MS = 10_000;

export function createGameLifecycle(
  deps: GameLifecycleDeps,
): GameLifecycleSystem {
  const { runtimeState, camera, sound, selection } = deps;

  // -------------------------------------------------------------------------
  // Game stats
  // -------------------------------------------------------------------------

  function resetGameStats() {
    runtimeState.gameStats = Array.from({ length: MAX_PLAYERS }, () => ({
      wallsDestroyed: 0,
      cannonsKilled: 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Reset / init
  // -------------------------------------------------------------------------

  /** Timer for auto-return to lobby in demo mode (all-AI games). */
  let demoReturnTimer: ReturnType<typeof setTimeout> | null = null;

  function clearDemoTimer(): void {
    if (demoReturnTimer) {
      clearTimeout(demoReturnTimer);
      demoReturnTimer = null;
    }
  }

  function resetUIState(): void {
    clearDemoTimer();
    runtimeState.reselectQueue = [];
    runtimeState.reselectionPids = [];
    runtimeState.battleAnim = createBattleAnimState();
    runtimeState.accum = createTimerAccums();
    runtimeState.banner = createBannerState();
    runtimeState.lifeLostDialog = null;
    runtimeState.paused = false;
    runtimeState.quitPending = false;
    runtimeState.optionsReturnMode = null;
    runtimeState.castleBuilds = [];
    runtimeState.castleBuildOnDone = null;
    runtimeState.selectionStates.clear();
    runtimeState.scoreDeltas = [];
    runtimeState.scoreDeltaTimer = 0;
    runtimeState.scoreDeltaOnDone = null;
    runtimeState.directTouchActive = false;
    runtimeState.preScores = [];
    deps.resetBattleCrosshair();
    resetGameStats();
    camera.resetCamera();
    sound.reset();
  }

  function startGame() {
    const seed = runtimeState.lobby.seed;

    const diffParams =
      DIFFICULTY_PARAMS[runtimeState.settings.difficulty] ??
      DIFFICULTY_PARAMS[1]!;
    const { buildTimer, cannonPlaceTimer, firstRoundCannons } = diffParams;
    const roundsParam =
      typeof location !== "undefined"
        ? Number(new URL(location.href).searchParams.get("rounds"))
        : 0;
    const roundsVal =
      roundsParam > 0
        ? roundsParam
        : (ROUNDS_OPTIONS[runtimeState.settings.rounds] ?? ROUNDS_OPTIONS[0]!)
            .value;

    bootstrapGame({
      seed,
      maxPlayers: Math.min(MAX_PLAYERS, PLAYER_KEY_BINDINGS.length),
      battleLength: roundsVal,
      cannonMaxHp: (
        CANNON_HP_OPTIONS[runtimeState.settings.cannonHp] ??
        CANNON_HP_OPTIONS[0]!
      ).value,
      buildTimer,
      cannonPlaceTimer,
      log: deps.log,
      clearFrameData: deps.clearFrameData,
      setState: (state: GameState) => {
        state.firstRoundCannons = firstRoundCannons;
        runtimeState.state = state;
      },
      setControllers: (controller: readonly PlayerController[]) => {
        runtimeState.controllers = [...controller];
      },
      resetUIState,
      createControllerForSlot: (i: number, gameState: GameState) => {
        const isAi = !runtimeState.lobby.joined[i];
        const strategySeed = isAi
          ? gameState.rng.int(0, MAX_UINT32)
          : undefined;
        return createController(
          i,
          isAi,
          runtimeState.settings.keyBindings[i]!,
          strategySeed,
          runtimeState.settings.difficulty,
        );
      },
      enterSelection: selection.enter,
    });
  }

  // -------------------------------------------------------------------------
  // End / rematch / return to lobby
  // -------------------------------------------------------------------------

  function endGame(winner: { id: number } | null) {
    runtimeState.scoreDeltaOnDone = null;
    runtimeState.lifeLostDialog = null;
    camera.fullUnzoom();
    deps.onEndGame?.(winner, runtimeState.state);
    sound.reset();
    sound.gameOver();
    const name = winner
      ? (PLAYER_NAMES[winner.id] ?? `Player ${winner.id + 1}`)
      : NO_WINNER_NAME;
    runtimeState.frame.gameOver = {
      winner: name,
      scores: runtimeState.state.players.map((player) => ({
        name: PLAYER_NAMES[player.id] ?? `P${player.id + 1}`,
        score: player.score,
        color: getPlayerColor(player.id).wall,
        eliminated: player.eliminated,
        territory: player.interior.size,
        stats: runtimeState.gameStats[player.id],
      })),
      focused: FOCUS_REMATCH,
    };
    deps.render();
    runtimeState.mode = Mode.STOPPED;

    // Demo mode: auto-return to lobby after 10s when all players are AI
    clearDemoTimer();
    const allAi = runtimeState.lobby.joined.every((j) => !j);
    if (allAi) {
      demoReturnTimer = setTimeout(() => {
        demoReturnTimer = null;
        if (runtimeState.mode === Mode.STOPPED) returnToLobby();
      }, DEMO_RETURN_DELAY_MS);
    }
  }

  function rematch() {
    clearDemoTimer();
    camera.resetCamera();
    runtimeState.frame.gameOver = undefined;
    startGame();
    runtimeState.mode = Mode.SELECTION;
    runtimeState.lastTime = performance.now();
    deps.requestMainLoop();
  }

  function returnToLobby(): void {
    clearDemoTimer();
    runtimeState.scoreDeltaOnDone = null;
    camera.fullUnzoom();
    runtimeState.frame.gameOver = undefined;
    runtimeState.mouseJoinedSlot = NO_SLOT;
    runtimeState.directTouchActive = false;
    deps.resetTouchForLobby();
    deps.showLobby();
  }

  function gameOverClick(canvasX: number, canvasY: number): void {
    const gameOver = runtimeState.frame.gameOver;
    if (!gameOver) return;
    const W = GRID_COLS * TILE_SIZE;
    const H = GRID_ROWS * TILE_SIZE;
    const hit = gameOverButtonHitTest(
      canvasX / SCALE,
      canvasY / SCALE,
      W,
      H,
      gameOver,
    );
    if (hit === FOCUS_REMATCH) rematch();
    else if (hit === FOCUS_MENU) returnToLobby();
    else {
      // Tap outside buttons — use current focus
      if (gameOver.focused === FOCUS_REMATCH) rematch();
      else returnToLobby();
    }
  }

  return {
    resetGameStats,
    resetUIState,
    startGame,
    endGame,
    rematch,
    returnToLobby,
    gameOverClick,
  };
}
