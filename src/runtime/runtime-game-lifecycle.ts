/**
 * Game lifecycle sub-system — owns game start, reset, end, rematch,
 * and return-to-lobby transitions.
 *
 * Extracted from runtime.ts to keep it a pure composition root.
 * Follows the factory-with-deps pattern used by other runtime-*.ts files.
 */

import { createBannerState } from "../game/phase-banner.ts";
import type { SoundSystem } from "../input/sound-system.ts";
import { gameOverButtonHitTest } from "../render/render-composition.ts";
import { createBattleAnimState } from "../shared/battle-types.ts";
import type { PlayerController } from "../shared/controller-interfaces.ts";
import { FOCUS_MENU, FOCUS_REMATCH } from "../shared/dialog-types.ts";
import { Mode } from "../shared/game-phase.ts";
import { GRID_COLS, GRID_ROWS, SCALE, TILE_SIZE } from "../shared/grid.ts";
import {
  DIFFICULTY_NORMAL,
  DIFFICULTY_PARAMS,
  getPlayerColor,
  MAX_PLAYERS,
  PLAYER_KEY_BINDINGS,
  PLAYER_NAMES,
} from "../shared/player-config.ts";
import { CANNON_HP_OPTIONS, ROUNDS_OPTIONS } from "../shared/settings-defs.ts";
import { createTimerAccums } from "../shared/tick-context.ts";
import { type GameState } from "../shared/types.ts";
import { bootstrapGame } from "./runtime-bootstrap.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { CameraSystem } from "./runtime-types.ts";

interface GameLifecycleDeps {
  readonly runtimeState: RuntimeState;

  // Config / networking
  readonly log: (msg: string) => void;
  readonly showLobby: () => void;
  readonly onEndGame?: (winner: { id: number }, state: GameState) => void;

  // Sub-systems
  readonly camera: Pick<CameraSystem, "resetCamera" | "clearAllZoomState">;
  readonly sound: Pick<SoundSystem, "reset" | "gameOver">;
  readonly selection: { enter: () => void };

  // Late-bound callbacks (resolved at call time via closures)
  readonly render: () => void;
  readonly clearFrameData: () => void;
  readonly requestMainLoop: () => void;
  readonly resetTouchForLobby: () => void;
  readonly resetBattleCrosshair: () => void;
  readonly resetScoreDeltas: () => void;
}

interface GameLifecycleSystem {
  resetGameStats: () => void;
  resetUIState: () => void;
  startGame: () => void;
  endGame: (winner: { id: number }) => void;
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
    runtimeState.upgradePickDialog = null;
    runtimeState.paused = false;
    runtimeState.quitPending = false;
    runtimeState.optionsReturnMode = null;
    runtimeState.castleBuilds = [];
    runtimeState.castleBuildOnDone = null;
    runtimeState.selectionStates.clear();
    deps.resetScoreDeltas();
    runtimeState.directTouchActive = false;
    deps.resetBattleCrosshair();
    resetGameStats();
    camera.resetCamera();
    sound.reset();
  }

  function startGame() {
    const seed = runtimeState.lobby.seed;
    deps.log(`[game] seed: ${seed}`);

    const diffParams =
      DIFFICULTY_PARAMS[runtimeState.settings.difficulty] ??
      DIFFICULTY_PARAMS[DIFFICULTY_NORMAL]!;
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
      existingMap: runtimeState.lobby.map ?? undefined,
      maxRounds: roundsVal,
      cannonMaxHp: (
        CANNON_HP_OPTIONS[runtimeState.settings.cannonHp] ??
        CANNON_HP_OPTIONS[0]!
      ).value,
      buildTimer,
      cannonPlaceTimer,
      firstRoundCannons,
      gameMode: runtimeState.settings.gameMode,
      log: deps.log,
      clearFrameData: deps.clearFrameData,
      setState: (state: GameState) => {
        runtimeState.state = state;
      },
      setControllers: (controller: readonly PlayerController[]) => {
        runtimeState.controllers = [...controller];
      },
      humanSlots: runtimeState.lobby.joined,
      keyBindings: runtimeState.settings.keyBindings,
      difficulty: runtimeState.settings.difficulty,
      resetUIState,
      enterSelection: selection.enter,
    });
  }

  // -------------------------------------------------------------------------
  // End / rematch / return to lobby
  // -------------------------------------------------------------------------

  function endGame(winner: { id: number }) {
    deps.resetScoreDeltas();
    runtimeState.lifeLostDialog = null;
    camera.clearAllZoomState();
    deps.onEndGame?.(winner, runtimeState.state);
    sound.reset();
    sound.gameOver();
    const name = PLAYER_NAMES[winner.id] ?? `Player ${winner.id + 1}`;
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
    deps.resetScoreDeltas();
    camera.clearAllZoomState();
    runtimeState.frame.gameOver = undefined;
    runtimeState.mouseJoinedSlot = null;
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
