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
import type { RuntimeState } from "./runtime-state.ts";
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
  readonly rs: RuntimeState;

  // Config / networking
  readonly log: (msg: string) => void;
  readonly showLobby: () => void;
  readonly onEndGame?: (
    winner: { id: number } | null,
    state: GameState,
  ) => void;

  // Sub-systems
  readonly camera: Pick<CameraSystem, "resetCamera" | "unzoom">;
  readonly sound: Pick<SoundSystem, "reset" | "gameOver">;
  readonly selection: { enter: () => void };

  // Late-bound callbacks (resolved at call time via closures)
  readonly render: () => void;
  readonly resetFrame: () => void;
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
  const { rs, camera, sound, selection } = deps;

  // -------------------------------------------------------------------------
  // Game stats
  // -------------------------------------------------------------------------

  function resetGameStats() {
    rs.gameStats = Array.from({ length: MAX_PLAYERS }, () => ({
      wallsDestroyed: 0,
      cannonsKilled: 0,
    }));
  }

  // -------------------------------------------------------------------------
  // Reset / init
  // -------------------------------------------------------------------------

  function resetUIState(): void {
    rs.reselectQueue = [];
    rs.reselectionPids = [];
    rs.battleAnim = createBattleAnimState();
    rs.accum = createTimerAccums();
    rs.banner = createBannerState();
    rs.lifeLostDialog = null;
    rs.paused = false;
    rs.quitPending = false;
    rs.optionsReturnMode = null;
    rs.castleBuilds = [];
    rs.castleBuildOnDone = null;
    rs.selectionStates.clear();
    rs.scoreDeltas = [];
    rs.scoreDeltaTimer = 0;
    rs.scoreDeltaOnDone = null;
    rs.directTouchActive = false;
    rs.preScores = [];
    deps.resetBattleCrosshair();
    resetGameStats();
    camera.resetCamera();
    sound.reset();
  }

  function startGame() {
    const seed = rs.lobby.seed;

    const diffParams =
      DIFFICULTY_PARAMS[rs.settings.difficulty] ?? DIFFICULTY_PARAMS[1]!;
    const { buildTimer, cannonPlaceTimer, firstRoundCannons } = diffParams;
    const roundsParam =
      typeof location !== "undefined"
        ? Number(new URL(location.href).searchParams.get("rounds"))
        : 0;
    const roundsVal =
      roundsParam > 0
        ? roundsParam
        : (ROUNDS_OPTIONS[rs.settings.rounds] ?? ROUNDS_OPTIONS[0]!).value;

    bootstrapGame({
      seed,
      maxPlayers: Math.min(MAX_PLAYERS, PLAYER_KEY_BINDINGS.length),
      battleLength: roundsVal,
      cannonMaxHp: (
        CANNON_HP_OPTIONS[rs.settings.cannonHp] ?? CANNON_HP_OPTIONS[0]!
      ).value,
      buildTimer,
      cannonPlaceTimer,
      log: deps.log,
      resetFrame: deps.resetFrame,
      setState: (s: GameState) => {
        s.firstRoundCannons = firstRoundCannons;
        rs.state = s;
      },
      setControllers: (c: readonly PlayerController[]) => {
        rs.controllers = [...c];
      },
      resetUIState,
      createControllerForSlot: (i: number, gameState: GameState) => {
        const isAi = !rs.lobby.joined[i];
        const strategySeed = isAi
          ? gameState.rng.int(0, MAX_UINT32)
          : undefined;
        return createController(
          i,
          isAi,
          rs.settings.keyBindings[i]!,
          strategySeed,
          rs.settings.difficulty,
        );
      },
      enterSelection: selection.enter,
    });
  }

  // -------------------------------------------------------------------------
  // End / rematch / return to lobby
  // -------------------------------------------------------------------------

  /** Timer for auto-return to lobby in demo mode (all-AI games). */
  let demoReturnTimer: ReturnType<typeof setTimeout> | null = null;

  function endGame(winner: { id: number } | null) {
    rs.scoreDeltaOnDone = null;
    rs.lifeLostDialog = null;
    camera.unzoom();
    deps.onEndGame?.(winner, rs.state);
    sound.reset();
    sound.gameOver();
    const name = winner
      ? (PLAYER_NAMES[winner.id] ?? `Player ${winner.id + 1}`)
      : NO_WINNER_NAME;
    rs.frame.gameOver = {
      winner: name,
      scores: rs.state.players.map((p) => ({
        name: PLAYER_NAMES[p.id] ?? `P${p.id + 1}`,
        score: p.score,
        color: getPlayerColor(p.id).wall,
        eliminated: p.eliminated,
        territory: p.interior.size,
        stats: rs.gameStats[p.id],
      })),
      focused: FOCUS_REMATCH,
    };
    deps.render();
    rs.mode = Mode.STOPPED;

    // Demo mode: auto-return to lobby after 10s when all players are AI
    if (demoReturnTimer) clearTimeout(demoReturnTimer);
    const allAi = rs.lobby.joined.every((j) => !j);
    if (allAi) {
      demoReturnTimer = setTimeout(() => {
        demoReturnTimer = null;
        if (rs.mode === Mode.STOPPED) returnToLobby();
      }, DEMO_RETURN_DELAY_MS);
    }
  }

  function rematch() {
    if (demoReturnTimer) {
      clearTimeout(demoReturnTimer);
      demoReturnTimer = null;
    }
    camera.resetCamera();
    rs.frame.gameOver = undefined;
    startGame();
    rs.mode = Mode.SELECTION;
    rs.lastTime = performance.now();
    deps.requestMainLoop();
  }

  function returnToLobby(): void {
    if (demoReturnTimer) {
      clearTimeout(demoReturnTimer);
      demoReturnTimer = null;
    }
    rs.scoreDeltaOnDone = null;
    camera.unzoom();
    rs.frame.gameOver = undefined;
    rs.mouseJoinedSlot = -1;
    rs.directTouchActive = false;
    deps.resetTouchForLobby();
    deps.showLobby();
  }

  function gameOverClick(canvasX: number, canvasY: number): void {
    const gameOver = rs.frame.gameOver;
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
