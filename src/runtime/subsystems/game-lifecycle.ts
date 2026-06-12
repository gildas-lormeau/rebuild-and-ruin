/**
 * Game lifecycle sub-system — owns game start, reset, end, rematch, and
 * return-to-lobby transitions. `createGameLifecycle` is a pure
 * orchestrator: it sequences dep calls without accessing runtimeState
 * directly. The companion `buildLifecycleDeps` assembles the deps object
 * from subsystem handles + runtimeState, keeping the composition root
 * lean.
 */

import { DEMO_RETURN_DELAY_MS } from "../../shared/core/game-constants.ts";
import type { ValidPlayerId } from "../../shared/core/player-slot.ts";
import {
  FOCUS_MENU,
  FOCUS_REMATCH,
  type GameOverFocus,
} from "../../shared/ui/interaction-types.ts";
import type { GameOverOverlay } from "../../shared/ui/overlay-types.ts";
import { Mode } from "../../shared/ui/ui-mode.ts";
import { type RuntimeState, resetTransientState, setMode } from "../state.ts";
import type { TimingApi } from "../timing-api.ts";
import type { RuntimeConfig } from "../types.ts";
import type { RuntimeCamera } from "./camera.ts";
import type { RuntimeLifeLost } from "./life-lost.ts";
import type { RuntimeSelection } from "./selection.ts";
import type { RuntimeUpgradePick } from "./upgrade-pick.ts";

interface GameLifecycleDeps {
  readonly log: (msg: string) => void;

  // Game start — composition root resolves settings and calls bootstrapGame
  readonly bootstrapNewGame: () => void | Promise<void>;

  // Game end
  readonly setGameOverFrame: (winner: { id: ValidPlayerId }) => void;
  readonly onEndGame?: (winner: { id: ValidPlayerId }) => void;
  readonly isAllAi: () => boolean;
  readonly isModeStopped: () => boolean;

  // Atomic state transitions
  readonly setModeStopped: () => void;
  readonly clearGameOver: () => void;
  /** Bump `bootGeneration` so any in-flight `bootstrapGame` bails at its
   *  next await (see the field's doc in state.ts). Part of the teardown
   *  matrix so every quit path cancels a parked bootstrap. */
  readonly invalidateInFlightBootstrap: () => void;

  // Subsystem resets
  readonly resetAll: () => void;
  readonly resetScoreDeltas: () => void;
  readonly resetLifeLostDialog: () => void;
  readonly resetUpgradePickDialog: () => void;
  readonly resetBanner: () => void;
  readonly clearAllZoomState: () => void;
  readonly clearLobbyMap: () => void;
  readonly resetInputForLobby: () => void;
  /** Hard-stop SFX (snare loop, welldone chain) + music (bg track,
   *  fanfares) so the ESC / ✕ quit path doesn't leave audio ringing
   *  under the lobby. The route-level exit (`runtime.shutdown`) shares
   *  the same helper. */
  readonly stopAudio: () => void;

  // Demo timer (all-AI auto-return to lobby)
  readonly clearDemoTimer: () => void;
  readonly setDemoTimer: (callback: () => void, delay: number) => void;

  // Rendering / navigation
  readonly render: () => void;
  readonly showLobby: () => void;

  // Game-over interaction
  readonly hitTestGameOver: (
    canvasX: number,
    canvasY: number,
  ) => GameOverFocus | null;
  readonly getGameOverFocused: () => GameOverFocus;
  readonly isTouchDevice: boolean;
}

/** Public lifecycle handle exposed on `GameRuntime`. Owns game start
 *  (bootstrap), rematch, reset paths shared between endGame and
 *  returnToLobby. */
export interface RuntimeLifecycle {
  startGame: () => Promise<void>;
  /** Full reset + fresh bootstrap — production-equivalent to the rematch
   *  button on the game-over screen. Clears game-over / demo-timer state,
   *  then calls `startGame`. Tests use this via `sc.rematch()` to drive
   *  the "finish game 1, start game 2 on the same runtime" path. */
  rematch: () => void | Promise<void>;
  resetUIState: () => void;
  /** Shared game-over terminal sequence: caller-supplied frame paint →
   *  teardown → render → Mode.STOPPED. Two callers: `endGame` (the
   *  game-over transition dispatches locally on EVERY peer —
   *  last-player-standing included, via the life-lost route) and the
   *  watcher's MESSAGE.GAME_OVER handler (re-paints from the host's
   *  authoritative scores). Idempotent — safe when the local dispatch
   *  fires before the message arrives. */
  finalizeGameOver: (setFrame: () => void) => void;
}

interface GameLifecycleSystem extends RuntimeLifecycle {
  endGame: (winner: { id: ValidPlayerId }) => void;
  returnToLobby: () => void;
  gameOverClick: (canvasX: number, canvasY: number) => void | Promise<void>;
  /** Per-session reset matrix shared by `endGame`, `returnToLobby`, and
   *  the composition root's `shutdown`. Internal to the wiring — online
   *  paths run it indirectly through `finalizeGameOver`. */
  teardownSession: () => void;
}

interface LifecycleWiringDeps {
  readonly runtimeState: RuntimeState;
  readonly config: Pick<RuntimeConfig, "log" | "showLobby" | "onEndGame">;
  /** Injected timing primitives — replaces bare `globalThis.setTimeout` /
   *  `globalThis.clearTimeout` access in the demo-return timer. */
  readonly timing: TimingApi;
  readonly render: () => void;
  readonly bootstrapNewGame: () => void | Promise<void>;

  // Subsystems needed for reset/cleanup
  readonly selection: Pick<RuntimeSelection, "reset">;
  readonly banner: { reset: () => void };
  readonly cannonAnimator: { reset: () => void };
  readonly camera: Pick<RuntimeCamera, "clearAllZoomState" | "resetCamera">;
  readonly getLifeLost: () => Pick<RuntimeLifeLost, "set">;
  readonly getUpgradePick: () => Pick<RuntimeUpgradePick, "set">;
  readonly scoreDelta: { reset: () => void };
  readonly input: { resetForLobby: () => void };
  readonly stopAudio: () => void;

  // Game-over UI
  readonly hitTestGameOver: (
    canvasX: number,
    canvasY: number,
  ) => GameOverFocus | null;
  readonly isTouchDevice: boolean;

  // Render-domain (injected from composition root)
  readonly buildGameOverOverlay: (
    winnerId: ValidPlayerId,
    players: readonly {
      id: ValidPlayerId;
      score: number;
      eliminated: boolean;
    }[],
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
    deps.invalidateInFlightBootstrap();
    deps.clearDemoTimer();
    deps.resetScoreDeltas();
    deps.clearAllZoomState();
    deps.resetLifeLostDialog();
    // The upgrade-pick dialog and banner render unconditionally (no mode
    // gating — deliberate, for banner-preview windows), so a watcher frozen
    // mid-UPGRADE_PICK or mid-sweep when MESSAGE.GAME_OVER arrives would
    // otherwise paint a stale modal / half-swept banner on the game-over
    // screen. The dialog clears mirror `resetLifeLostDialog` for symmetry —
    // both dialogs are also dismissed on the watcher by the phase-transition
    // handler (online-server-lifecycle.ts), so these are defense-in-depth.
    // The banner has no such dismissal: clearing it here is the actual fix
    // (see network-vs-local.test.ts "frozen watcher clears the stale
    // banner"). On the host path all three are no-ops: game-over only fires
    // from the life-lost route, where the dialogs are closed and runDisplay
    // already hid the banner.
    deps.resetUpgradePickDialog();
    deps.resetBanner();
  }

  /** Shared terminal sequence for game-over: snapshot the game-over frame
   *  (every peer's `endGame` builds it from its own live state; the
   *  watcher's MESSAGE.GAME_OVER handler re-paints from the host's
   *  authoritative scores), then clean up display caches, then render +
   *  stop the loop. Idempotent — safe to call twice when the local
   *  dispatch fires before MESSAGE.GAME_OVER arrives. */
  function finalizeGameOver(setFrame: () => void): void {
    setFrame();
    teardownSession();
    deps.render();
    deps.setModeStopped();
  }

  function endGame(winner: { id: ValidPlayerId }): void {
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
    // Cut the game-over audio (welldone + winner stinger, any score-screen
    // bg) before the new game. `returnToLobby` already does this via
    // `stopAudio`; rematch skipped it, so the previous match's victory
    // stinger bled into the next game's opening. The bootstrap's
    // `subscribeBus` re-arms playback for the new bus.
    deps.stopAudio();
    await startGame();
  }

  function returnToLobby(): void {
    // ESC / ✕ / game-over Menu / demo auto-return all land here. The
    // game state freezes mid-phase, so the state-derived snare loop
    // has no way to detect that the game is over, and any in-flight
    // fanfare would otherwise ring under the lobby. Route-level exits
    // share the same helper via `runtime.shutdown`. The lobby's
    // `showLobby` callback re-starts the title track immediately
    // afterwards.
    deps.stopAudio();
    // Clear stale per-phase pinch memory + viewport targets from the
    // game we just quit so the lobby's background demo doesn't snap to
    // the previous human's favourite zoom when it reaches that phase.
    // The mobile-auto-zoom predicate (`mobileAutoZoomActive` in the
    // camera system) already gates on `hasPointerPlayer`, so the demo
    // session reads as inactive regardless of `zoomActivated`'s value.
    teardownSession();
    // Null the stale lobby preview map so the next lobby session
    // regenerates it fresh from the (possibly new) seed. The in-game map
    // is a separate object generated in `bootstrap` from the seed
    // (`createGameFromSeed`), NOT this preview reference, so in-game
    // tile/house mutations never touched it.
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
    invalidateInFlightBootstrap: () => {
      runtimeState.bootGeneration++;
    },

    resetAll: () => {
      wiringDeps.selection.reset();
      wiringDeps.banner.reset();
      wiringDeps.cannonAnimator.reset();
      resetTransientState(runtimeState);
      wiringDeps.getLifeLost().set(null);
      wiringDeps.getUpgradePick().set(null);
      wiringDeps.scoreDelta.reset();
      wiringDeps.camera.resetCamera();
    },
    resetScoreDeltas: wiringDeps.scoreDelta.reset,
    resetLifeLostDialog: () => wiringDeps.getLifeLost().set(null),
    resetUpgradePickDialog: () => wiringDeps.getUpgradePick().set(null),
    resetBanner: wiringDeps.banner.reset,
    clearAllZoomState: wiringDeps.camera.clearAllZoomState,
    clearLobbyMap: () => {
      runtimeState.lobby.map = null;
    },
    resetInputForLobby: () => wiringDeps.input.resetForLobby(),
    stopAudio: wiringDeps.stopAudio,

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
    showLobby: config.showLobby,

    hitTestGameOver: wiringDeps.hitTestGameOver,
    // Fallback (no overlay, e.g. STOPPED via route-level shutdown) is
    // MENU: confirming into a rematch with no game-over screen would
    // boot a game under whatever UI replaced it.
    getGameOverFocused: () =>
      runtimeState.frame.gameOver?.focused ?? FOCUS_MENU,
    isTouchDevice: wiringDeps.isTouchDevice,
  };
}
