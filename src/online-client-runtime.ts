/**
 * Online runtime wiring.
 *
 * Creates the GameRuntime with all online-specific callbacks, owns the
 * DOM canvas singletons, and defines functions that close over `runtime`.
 *
 * The TransitionContext and networking config are assembled from focused
 * builder functions (one per concern) to keep each section small and
 * colocated with its domain logic.
 */

import type {
  FullStateMessage,
  GameMessage,
  InitMessage,
} from "../server/protocol.ts";
import { MESSAGE } from "../server/protocol.ts";
import {
  BANNER_DURATION,
  BUILD_TIMER,
  CANNON_PLACE_TIMER,
  SELECT_TIMER,
} from "./game-constants.ts";
import {
  applyBattleStartCheckpoint,
  applyBuildStartCheckpoint,
  applyCannonStartCheckpoint,
  type CheckpointDeps,
} from "./online-checkpoints.ts";
import { applyFullStateUiRecovery } from "./online-full-state-recovery.ts";
import {
  broadcastLocalCrosshair,
  extendWithRemoteCrosshairs,
} from "./online-host-crosshairs.ts";
import type { TransitionContext } from "./online-phase-transitions.ts";
import {
  fireAndSend as fireAndSendAction,
  tryPlaceCannonAndSend as tryPlaceCannonAndSendAction,
  tryPlacePieceAndSend as tryPlacePieceAndSendAction,
} from "./online-send-actions.ts";
import {
  applyFullStateSnapshot,
  applyPlayersCheckpoint,
  createBattleStartMessage,
  createBuildStartMessage,
  createCannonStartMessage,
  createGameOverPayload,
  serializePlayers,
} from "./online-serialize.ts";
import { resetSessionState } from "./online-session.ts";
import { startWatcherPhaseTimer } from "./online-types.ts";
import type { WatcherTickContext } from "./online-watcher-tick.ts";
import {
  tickMigrationAnnouncement as tickMigrationAnnouncementFn,
  tickWatcher as tickWatcherFn,
} from "./online-watcher-tick.ts";
import { MAX_PLAYERS, PLAYER_COLORS, PLAYER_NAMES } from "./player-config.ts";
import { createCanvasRenderer } from "./render-canvas.ts";
import {
  GAME_CONTAINER_ACTIVE,
  GAME_EXIT_EVENT,
  navigateTo,
} from "./router.ts";
import { createGameRuntime, type GameRuntime } from "./runtime.ts";
import {
  bootstrapGame,
  createOnlineControllerSlotFactory,
  initWaitingRoom,
} from "./runtime-bootstrap.ts";
import {
  clearReconnect,
  dedup,
  devLog,
  devLogThrottled,
  maybeSendAimUpdate,
  resetNetworking,
  send,
  session,
  watcher,
} from "./runtime-online-stores.ts";
import { LifeLostChoice, Mode } from "./types.ts";

// ── DOM singletons ──────────────────────────────────────────────────
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = createCanvasRenderer(canvas);
const roomCodeOverlay = document.getElementById("room-code-overlay")!;
export const pageOnline = document.getElementById("page-online")!;
// ── Assemble transition context ─────────────────────────────────────
export const transitionCtx: TransitionContext = {
  getState: () => runtime.runtimeState.state,
  session,
  getControllers: () => runtime.runtimeState.controllers,
  setMode: (mode: Mode) => {
    runtime.runtimeState.mode = mode;
  },
  now: () => performance.now(),
  ui: buildTransitionUiCtx(),
  checkpoint: buildTransitionCheckpointCtx(),
  selection: buildTransitionSelectionCtx(),
  battle: buildTransitionBattleCtx(),
  endPhase: buildTransitionEndPhaseCtx(),
};
// ── Watcher tick context ────────────────────────────────────────────
const watcherTickCtx: WatcherTickContext = {
  getState: () => runtime.runtimeState.state,
  getFrame: () => runtime.runtimeState.frame,
  getAccum: () => runtime.runtimeState.accum,
  getBattleAnim: () => runtime.runtimeState.battleAnim,
  getControllers: () => runtime.runtimeState.controllers,
  session,
  dedup,
  send: (msg) => send(msg as GameMessage),
  logThrottled: devLogThrottled,
  maybeSendAimUpdate,
  render: () => runtime.render(),
  now: () => performance.now(),
};
// ── Runtime creation ────────────────────────────────────────────────
export const runtime: GameRuntime = createGameRuntime({
  renderer,
  isOnline: true,
  send,
  getIsHost: () => session.isHost,
  getMyPlayerId: () => session.myPlayerId,
  getRemoteHumanSlots: () => session.remoteHumanSlots,
  log: devLog,
  logThrottled: devLogThrottled,
  getLobbyRemaining: () =>
    Math.max(
      0,
      session.lobbyWaitTimer -
        1 -
        (performance.now() - session.lobbyStartTime) / 1000,
    ),
  showLobby,
  onLobbySlotJoined: (pid) => {
    send({ type: MESSAGE.SELECT_SLOT, slotId: pid });
  },
  onCloseOptions: () => {
    if (runtime.runtimeState.optionsReturnMode === null) {
      session.lobbyStartTime = performance.now();
    }
  },
  onTickLobbyExpired: () => {
    // Re-read isHost (volatile — can flip during host promotion)
    if (!session.isHost) return;
    const initMsg: InitMessage = {
      type: MESSAGE.INIT,
      seed: session.roomSeed,
      playerCount: MAX_PLAYERS,
      settings: {
        battleLength: session.roomBattleLength,
        cannonMaxHp: session.roomCannonMaxHp,
        buildTimer: BUILD_TIMER,
        cannonPlaceTimer: CANNON_PLACE_TIMER,
      },
    };
    send(initMsg);
    initFromServer(initMsg);
    send({ type: MESSAGE.SELECT_START, timer: SELECT_TIMER });
  },

  // ── Networking callbacks ──
  tickNonHost: (dt) => tickWatcherFn(watcher, dt, watcherTickCtx),
  everyTick: (dt) =>
    tickMigrationAnnouncementFn(watcher, runtime.runtimeState.frame, dt),
  onLocalCrosshairCollected: (ctrl, crosshair) => {
    if (session.isHost)
      broadcastLocalCrosshair(ctrl, crosshair, {
        lastSentAimTarget: dedup.aimTarget,
        send,
      });
  },
  extendCrosshairs: (crosshairs, dt) =>
    extendWithRemoteCrosshairs(crosshairs, runtime.runtimeState.state, dt, {
      remoteCrosshairs: watcher.remoteCrosshairs,
      watcherCrosshairPos: watcher.crosshairPos,
      remoteHumanSlots: session.remoteHumanSlots,
      logThrottled: devLogThrottled,
    }),
  hostNetworking: {
    serializePlayers,
    createCannonStartMessage,
    createBattleStartMessage,
    createBuildStartMessage,
    remoteCannonPhantoms: () => watcher.remoteCannonPhantoms,
    remotePiecePhantoms: () => watcher.remotePiecePhantoms,
    lastSentCannonPhantom: () => dedup.cannonPhantom,
    lastSentPiecePhantom: () => dedup.piecePhantom,
  },
  watcherTiming: watcher.timing,
  maybeSendAimUpdate,
  tryPlaceCannonAndSend: (ctrl, state, maxSlots) =>
    tryPlaceCannonAndSendAction(ctrl, state, maxSlots, send),
  tryPlacePieceAndSend: (ctrl, state) =>
    tryPlacePieceAndSendAction(ctrl, state, send),
  fireAndSend: (ctrl, state) => fireAndSendAction(ctrl, state, send),
  onEndGame: (winner, gameState) => {
    const payloads = createGameOverPayload(winner, gameState, PLAYER_NAMES);
    devLog(
      `endGame winner=${payloads.winnerName} round=${gameState.round} battleLength=${gameState.battleLength}`,
    );
    if (session.isHost) send(payloads.serverPayload);
  },
});

export function showWaitingRoom(code: string, seed: number): void {
  session.roomSeed = seed;
  runtime.runtimeState.settings.seed = String(seed);
  initWaitingRoom({
    code,
    seed,
    lobbyEl: pageOnline,
    container: renderer.container,
    roomCodeOverlay,
    lobby: runtime.runtimeState.lobby,
    maxPlayers: MAX_PLAYERS,
    now: () => performance.now(),
    setLobbyStartTime: (timestamp: number) => {
      session.lobbyStartTime = timestamp;
    },
    setModeLobby: () => {
      runtime.runtimeState.mode = Mode.LOBBY;
    },
    setLastTime: (timestamp: number) => {
      runtime.runtimeState.lastTime = timestamp;
    },
    requestFrame: () => {
      requestAnimationFrame(runtime.mainLoop);
    },
  });
}

export function initFromServer(msg: InitMessage): void {
  roomCodeOverlay.style.display = "none";
  runtime.runtimeState.lobby.active = false;
  const settings = runtime.runtimeState.settings;
  bootstrapGame({
    seed: msg.seed,
    maxPlayers: msg.playerCount,
    battleLength: msg.settings.battleLength,
    cannonMaxHp: msg.settings.cannonMaxHp,
    buildTimer: msg.settings.buildTimer,
    cannonPlaceTimer: msg.settings.cannonPlaceTimer,
    log: devLog,
    clearFrameData: () => runtime.clearFrameData(),
    setState: (state) => {
      runtime.runtimeState.state = state;
    },
    setControllers: (controllers) => {
      runtime.runtimeState.controllers = [...controllers];
    },
    resetUIState: () => {
      runtime.lifecycle.resetUIState();
      resetNetworking("new-game");
    },
    createControllerForSlot: createOnlineControllerSlotFactory(
      session.myPlayerId,
      settings.keyBindings[0]!,
    ),
    enterSelection: () => runtime.selection.enter(),
  });
}

export function applyFullState(msg: FullStateMessage): void {
  const state = runtime.runtimeState.state;
  const result = applyFullStateSnapshot(state, msg);
  if (!result) return; // Validation failed — no state was mutated

  applyFullStateUiRecovery(
    {
      setMode: (mode) => {
        runtime.runtimeState.mode = mode;
      },
      onModeSet: (mode) => {
        if (mode === Mode.SELECTION) runtime.sound.drumsStart();
        else runtime.sound.drumsStop();
      },
      clearCastleBuilds: () => {
        runtime.runtimeState.castleBuilds = [];
      },
      clearLifeLostDialog: () => {
        runtime.lifeLost.set(null);
      },
      clearAnnouncement: () => {
        runtime.runtimeState.frame.announcement = undefined;
      },
      setBattleFlights: (flights) => {
        runtime.runtimeState.battleAnim.flights = flights;
      },
    },
    state.phase,
    result.balloonFlights,
  );

  startWatcherPhaseTimer(watcher.timing, performance.now(), state.timer);
  if (state.battleCountdown > 0) {
    watcher.timing.countdownStartTime = performance.now();
    watcher.timing.countdownDuration = state.battleCountdown;
  }
}

function buildTransitionUiCtx(): TransitionContext["ui"] {
  return {
    showBanner: (text, onDone, preserveOldScene?, newBattle?, subtitle?) =>
      runtime.showBanner(text, onDone, preserveOldScene, newBattle, subtitle),
    get banner() {
      return runtime.runtimeState.banner;
    },
    render: () => runtime.render(),
    watcherTiming: watcher.timing,
    bannerDuration: BANNER_DURATION,
  };
}

function buildTransitionCheckpointCtx(): TransitionContext["checkpoint"] {
  return {
    applyCannonStart: (data) =>
      applyCannonStartCheckpoint(data, buildCheckpointDeps()),
    applyBattleStart: (data) =>
      applyBattleStartCheckpoint(data, buildCheckpointDeps()),
    applyBuildStart: (data) =>
      applyBuildStartCheckpoint(data, buildCheckpointDeps()),
    applyPlayersCheckpoint,
  };
}

function buildTransitionSelectionCtx(): TransitionContext["selection"] {
  return {
    clearSelectionOverlay: () => {
      const overlay = runtime.runtimeState.overlay;
      if (overlay.selection) {
        overlay.selection.highlights = undefined;
        overlay.selection.highlighted = null;
        overlay.selection.selected = null;
      }
    },
    getStates: () => runtime.selection.getStates(),
    setCastleBuildFromPlans: (plans, maxTiles, onDone) => {
      runtime.runtimeState.castleBuilds.push({
        wallPlans: plans,
        maxTiles,
        tileIdx: 0,
        accum: 0,
        onDone,
      });
      runtime.runtimeState.castleBuildOnDone = onDone;
    },
    setCastleBuildViewport: (plans) =>
      runtime.selection.setCastleBuildViewport(plans),
  };
}

function buildTransitionBattleCtx(): TransitionContext["battle"] {
  return {
    setFlights: (flights) => {
      runtime.runtimeState.battleAnim.flights = flights;
    },
    snapshotTerritory: () => runtime.snapshotTerritory(),
    beginBattle: () => runtime.phaseTicks.beginBattle(),
  };
}

function buildTransitionEndPhaseCtx(): TransitionContext["endPhase"] {
  return {
    showLifeLostDialog: (needsReselect, eliminated) => {
      runtime.lifeLost.show(needsReselect, eliminated);
      const dialog = runtime.lifeLost.get();
      if (dialog) {
        for (const [pid, choice] of session.earlyLifeLostChoices) {
          const entry = dialog.entries.find((e) => e.playerId === pid);
          if (entry && entry.choice === LifeLostChoice.PENDING)
            entry.choice = choice;
        }
      }
      session.earlyLifeLostChoices.clear();
    },
    showScoreDeltas: (preScores, onDone) => {
      runtime.runtimeState.preScores = preScores;
      runtime.selection.showBuildScoreDeltas(onDone);
    },
    setGameOverFrame: (gameOver) => {
      runtime.runtimeState.frame.gameOver = gameOver;
    },
    playerColors: PLAYER_COLORS,
  };
}

/** Build the deps object shared by all three checkpoint functions. */
function buildCheckpointDeps(): CheckpointDeps {
  return {
    state: runtime.runtimeState.state,
    battleAnim: runtime.runtimeState.battleAnim,
    accum: runtime.runtimeState.accum,
    remoteCrosshairs: watcher.remoteCrosshairs,
    watcherCrosshairPos: watcher.crosshairPos,
    watcherOrbitParams: watcher.orbitParams,
    watcherIdlePhases: watcher.idlePhases,
    snapshotTerritory: () => runtime.snapshotTerritory(),
  };
}

// ── Functions that close over runtime ───────────────────────────────
function showLobby(): void {
  runtime.runtimeState.mode = Mode.STOPPED;
  runtime.runtimeState.lobby.active = false;
  renderer.container.classList.remove(GAME_CONTAINER_ACTIVE);
  roomCodeOverlay.style.display = "none";
  navigateTo("/online");
  resetSession();
}

// ── Side effects ────────────────────────────────────────────────────
runtime.registerInputHandlers();

document.addEventListener(GAME_EXIT_EVENT, () => {
  runtime.runtimeState.mode = Mode.STOPPED;
  runtime.runtimeState.lobby.active = false;
  roomCodeOverlay.style.display = "none";
  resetSession();
});

function resetSession(): void {
  clearReconnect();
  resetSessionState(session);
  runtime.runtimeState.settings.seed = "";
  resetNetworking("dedup");
}
