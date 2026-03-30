/**
 * Online runtime wiring.
 *
 * Creates the GameRuntime with all online-specific callbacks, owns the
 * DOM canvas singletons, and defines functions that close over `runtime`.
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
  enterCannonPlacePhase,
  finalizeCastleConstruction,
  resetZoneState,
} from "./game-engine.ts";
import {
  applyBattleStartCheckpoint,
  applyBuildStartCheckpoint,
  applyCannonStartCheckpoint,
  type CheckpointDeps,
} from "./online-checkpoints.ts";
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
} from "./online-client-stores.ts";
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
import { LifeLostChoice, Mode } from "./types.ts";

// ── DOM singletons ──────────────────────────────────────────────────
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = createCanvasRenderer(canvas);
const roomCodeOverlay = document.getElementById("room-code-overlay")!;
export const pageOnline = document.getElementById("page-online")!;
// ── Transition context ──────────────────────────────────────────────
export const transitionCtx: TransitionContext = {
  getState: () => runtime.runtimeState.state,
  getMyPlayerId: () => session.myPlayerId,
  getControllers: () => runtime.runtimeState.controllers,
  setMode: (mode: Mode) => {
    runtime.runtimeState.mode = mode;
  },
  now: () => performance.now(),

  ui: {
    showBanner: (
      text: string,
      onDone: () => void,
      preserveOldScene?: boolean,
      newBattle?: { territory: Set<number>[]; walls: Set<number>[] },
      subtitle?: string,
    ) =>
      runtime.showBanner(text, onDone, preserveOldScene, newBattle, subtitle),
    get banner() {
      return runtime.runtimeState.banner;
    },
    render: () => runtime.render(),
    watcherTiming: watcher.timing,
    bannerDuration: BANNER_DURATION,
  },

  checkpoint: {
    applyCannonStart: (data) =>
      applyCannonStartCheckpoint(data, buildCheckpointDeps()),
    applyBattleStart: (data) =>
      applyBattleStartCheckpoint(data, buildCheckpointDeps()),
    applyBuildStart: (data) =>
      applyBuildStartCheckpoint(data, buildCheckpointDeps()),
    applyPlayersCheckpoint,
  },

  selection: {
    clearSelectionOverlay: () => {
      const overlay = runtime.runtimeState.overlay;
      if (overlay.selection) {
        overlay.selection.highlights = undefined;
        overlay.selection.highlighted = null;
        overlay.selection.selected = null;
      }
    },
    getStates: () => runtime.selection.getStates(),
    finalizeCastleConstruction,
    enterCannonPlacePhase,
    setCastleBuildFromPlans: (
      plans: readonly { playerId: number; tiles: number[] }[],
      maxTiles: number,
      onDone: () => void,
    ) => {
      runtime.runtimeState.castleBuilds.push({
        wallPlans: plans,
        maxTiles,
        tileIdx: 0,
        accum: 0,
        onDone,
      });
      runtime.runtimeState.castleBuildOnDone = onDone;
    },
    setCastleBuildViewport: (
      plans: readonly { playerId: number; tiles: number[] }[],
    ) => runtime.selection.setCastleBuildViewport(plans),
  },

  battle: {
    setFlights: (
      flights: readonly {
        flight: {
          startX: number;
          startY: number;
          endX: number;
          endY: number;
        };
        progress: number;
      }[],
    ) => {
      runtime.runtimeState.battleAnim.flights = flights;
    },
    snapshotTerritory: () => runtime.snapshotTerritory(),
    beginBattle: () => runtime.phaseTicks.beginBattle(),
  },

  endPhase: {
    resetZoneState,
    showLifeLostDialog: (
      needsReselect: readonly number[],
      eliminated: readonly number[],
    ) => {
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
    showScoreDeltas: (preScores: readonly number[], onDone: () => void) => {
      runtime.runtimeState.preScores = preScores;
      runtime.selection.showBuildScoreDeltas(onDone);
    },
    setGameOverFrame: (
      gameOver: NonNullable<typeof runtime.runtimeState.frame.gameOver>,
    ) => {
      runtime.runtimeState.frame.gameOver = gameOver;
    },
    playerColors: PLAYER_COLORS,
  },
};
// ── Watcher tick context ────────────────────────────────────────────
const watcherTickCtx: WatcherTickContext = {
  getState: () => runtime.runtimeState.state,
  getFrame: () => runtime.runtimeState.frame,
  getAccum: () => runtime.runtimeState.accum,
  getBattleAnim: () => runtime.runtimeState.battleAnim,
  getControllers: () => runtime.runtimeState.controllers,
  getMyPlayerId: () => session.myPlayerId,
  lastSentCannonPhantom: dedup.cannonPhantom,
  lastSentPiecePhantom: dedup.piecePhantom,
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

  // Networking callbacks
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

// ── Checkpoint helper ───────────────────────────────────────────────
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
