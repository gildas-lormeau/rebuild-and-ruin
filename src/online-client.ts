/**
 * Online play entry point.
 *
 * All shared game logic lives in runtime.ts via createGameRuntime().
 * This file only provides the online-specific wiring: WebSocket networking,
 * DOM lobby, watcher state, server message handling, and phase handlers.
 */

import type {
  FullStateMessage,
  GameMessage,
  InitMessage,
  ServerMessage,
} from "../server/protocol.ts";
import {
  MSG,
} from "../server/protocol.ts";
import { applyImpactEvent } from "./battle-system.ts";
import { applyPiecePlacement, canPlacePieceOffsets } from "./build-system.ts";
import { applyCannonPlacement, cannonSlotCost, cannonSlotsUsed, canPlaceCannon } from "./cannon-system.ts";
import { createController } from "./controller-factory.ts";
import {
  enterCannonPlacePhase,
  finalizeCastleConstruction,
  markPlayerReselected,
  resetZoneState,
} from "./game-engine.ts";
import { GAME_CONTAINER_ACTIVE, GAME_EXIT_EVENT } from "./game-ui-types.ts";
import { GRID_COLS } from "./grid.ts";
import { LifeLostChoice } from "./life-lost.ts";
import { getWsUrl } from "./online-config.ts";
import { broadcastLocalCrosshair, extendWithRemoteCrosshairs } from "./online-host-crosshairs.ts";
import { rebuildControllersForPhase, syncAccumulatorsFromTimer } from "./online-host-promotion.ts";
import { initLobbyUi } from "./online-lobby-ui.ts";
import {
  handleBattleStartTransition,
  handleBuildEndTransition,
  handleBuildStartTransition,
  handleCannonStartTransition,
  handleCastleWallsTransition,
  handleGameOverTransition,
} from "./online-phase-transitions.ts";
import {
  fireAndSend as fireAndSendAction,
  tryPlaceCannonAndSend as tryPlaceCannonAndSendAction,
  tryPlacePieceAndSend as tryPlacePieceAndSendAction,
} from "./online-send-actions.ts";
import {
  applyFullStateSnapshot,
  applyPlayersCheckpoint,
  buildBattleStartMessage,
  buildBuildStartMessage,
  buildCannonStartMessage,
  buildFullStateMessage,
  buildGameOverPayload,
  serializePlayers,
} from "./online-serialize.ts";
import { handleServerIncrementalMessage } from "./online-server-events.ts";
import { handleServerLifecycleMessage } from "./online-server-lifecycle.ts";
import { connectWebSocket, createDedupMaps, createSession, type DedupMaps, type OnlineSession, resetDedupMaps, resetSessionState, sendAimUpdate, sendMessage } from "./online-session.ts";
import type { WatcherTickContext } from "./online-watcher-tick.ts";
import {
  applyBattleStartData,
  applyBuildStartData,
  applyCannonStartData,
  createWatcherState,
  resetWatcherState,
  tickMigrationAnnouncement as tickMigrationAnnouncementFn,
  tickWatcher as tickWatcherFn,
} from "./online-watcher-tick.ts";
import { IS_DEV } from "./platform.ts";
import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  PLAYER_NAMES,
} from "./player-config.ts";
import { createCanvasRenderer } from "./render-canvas.ts";
import { loadAtlas } from "./render-sprites.ts";
import { navigateTo } from "./router.ts";
import { createGameRuntime, type GameRuntime } from "./runtime.ts";
import { bootstrapGame, createOnlineControllerSlotFactory, initWaitingRoom } from "./runtime-bootstrap.ts";
import {
  BANNER_DURATION,
  BATTLE_COUNTDOWN,
  BUILD_TIMER,
  CANNON_PLACE_TIMER,
  CannonMode,
  isReselectPhase,
  MIGRATION_ANNOUNCEMENT_DURATION,
  Mode,
  SELECT_TIMER,
} from "./types.ts";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const renderer = createCanvasRenderer(canvas);
const pageOnline = document.getElementById("page-online")!;
const roomCodeOverlay = document.getElementById("room-code-overlay")!;
// Lobby DOM elements — queried once, shared with initLobbyUi
const lobbyElements = {
  btnCreateConfirm: document.getElementById("btn-create-confirm")!,
  btnJoinConfirm: document.getElementById("btn-join-confirm")!,
  setRounds: document.getElementById("set-rounds") as HTMLSelectElement,
  setHp: document.getElementById("set-hp") as HTMLSelectElement,
  setWait: document.getElementById("set-wait") as HTMLSelectElement,
  joinCodeInput: document.getElementById("join-code") as HTMLInputElement,
  createError: document.getElementById("create-error")!,
  joinError: document.getElementById("join-error")!,
};
const session: OnlineSession = createSession();
/** Network dedup maps — cleared on reset and host promotion. */
const dedup: DedupMaps = createDedupMaps();
const watcher = createWatcherState();
const DEV = IS_DEV;
const LOG_THROTTLE_MS = 1000;
const _throttleTimestamps = new Map<string, number>();
const initDomLobby = () =>
  initLobbyUi({
    elements: lobbyElements,
    connect,
    send,
    getSocket: () => session.ws,
    setIsHost: (value) => { session.isHost = value; },
    isVisible: () => !pageOnline.hidden,
  });
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
export const lobbyReady = loadAtlas().then(initDomLobby, initDomLobby).then((lobby) => {
  pageOnline.setAttribute("data-ready", "1");
  return lobby;
});
const watcherTickCtx: WatcherTickContext = {
  getState: () => runtime.rs.state,
  getFrame: () => runtime.rs.frame,
  getAccum: () => runtime.rs.accum,
  getBattleAnim: () => runtime.rs.battleAnim,
  getControllers: () => runtime.rs.controllers,
  getMyPlayerId: () => session.myPlayerId,
  lastSentCannonPhantom: dedup.cannonPhantom,
  lastSentPiecePhantom: dedup.piecePhantom,
  send: (msg) => send(msg as GameMessage),
  logThrottled,
  maybeSendAimUpdate,
  render: () => runtime.render(),
  now: () => performance.now(),
};
const transitionCtx = {
  getState: () => runtime.rs.state,
  getMyPlayerId: () => session.myPlayerId,
  getControllers: () => runtime.rs.controllers,
  showBanner: (t: string, cb: () => void, r?: boolean, nb?: { territory: Set<number>[]; walls: Set<number>[] }) => runtime.showBanner(t, cb, r, nb),
  clearSelectionOverlay: () => {
    const overlay = runtime.rs.overlay;
    if (overlay.selection) {
      overlay.selection.highlights = undefined;
      overlay.selection.highlighted = null;
      overlay.selection.selected = null;
    }
  },
  now: () => performance.now(),
  watcherTiming: watcher.timing,
  setMode: (mode: Mode) => { runtime.rs.mode = mode; },
  battleCountdown: BATTLE_COUNTDOWN,
  bannerDuration: BANNER_DURATION,
  playerColors: PLAYER_COLORS,
  applyCannonStartData: (msg: ServerMessage) => applyCannonStartData(...checkpointArgs(msg)),
  applyBattleStartData: (msg: ServerMessage) => applyBattleStartData(...checkpointArgs(msg)),
  applyBuildStartData: (msg: ServerMessage) => applyBuildStartData(...checkpointArgs(msg)),
  applyPlayersCheckpoint,
  resetZoneState,
  finalizeCastleConstruction,
  enterCannonPlacePhase,
  getSelectionStates: () => runtime.selection.getStates(),
  setCastleBuildFromPlans: (plans: readonly { playerId: number; tiles: number[] }[], maxTiles: number, onDone: () => void) => {
    runtime.rs.castleBuilds.push({ wallPlans: plans, maxTiles, tileIdx: 0, accum: 0, onDone });
    runtime.rs.castleBuildOnDone = onDone;
  },
  setCastleBuildViewport: (plans: readonly { playerId: number; tiles: number[] }[]) => runtime.selection.setCastleBuildViewport(plans),
  setBattleFlights: (v: readonly { flight: { startX: number; startY: number; endX: number; endY: number }; progress: number }[]) => { runtime.rs.battleAnim.flights = v; },
  snapshotTerritory: () => runtime.snapshotTerritory(),
  showLifeLostDialog: (nr: readonly number[], el: readonly number[]) => {
    runtime.lifeLost.show(nr, el);
    // Apply any choices that arrived before the dialog was created
    const dialog = runtime.lifeLost.get();
    if (dialog) {
      for (const [pid, choice] of session.earlyLifeLostChoices) {
        const entry = dialog.entries.find(e => e.playerId === pid);
        if (entry && entry.choice === LifeLostChoice.PENDING) entry.choice = choice;
      }
    }
    session.earlyLifeLostChoices.clear();
  },
  showScoreDeltas: (preScores: readonly number[], onDone: () => void) => {
    runtime.rs.preScores = preScores;
    runtime.selection.showBuildScoreDeltas(onDone);
  },
  aimAtEnemyCastle: () => runtime.aimAtEnemyCastle(),
  render: () => runtime.render(),
  setGameOverFrame: (p: NonNullable<typeof runtime.rs.frame.gameOver>) => { runtime.rs.frame.gameOver = p; },
};
const runtime: GameRuntime = createGameRuntime({
  renderer,
  isOnline: true,
  send,
  getIsHost: () => session.isHost,
  getMyPlayerId: () => session.myPlayerId,
  getRemoteHumanSlots: () => session.remoteHumanSlots,
  log,
  logThrottled,
  getLobbyRemaining: () => Math.max(0, session.lobbyWaitTimer - 1 - (performance.now() - session.lobbyStartTime) / 1000),
  showLobby,
  onLobbySlotJoined: (pid) => {
    send({ type: MSG.SELECT_SLOT, slotId: pid });
  },
  onCloseOptions: () => {
    if (runtime.rs.optionsReturnMode === null) {
      session.lobbyStartTime = performance.now();
    }
  },
  onTickLobbyExpired: () => {
    if (!session.isHost) return;
    const initMsg: InitMessage = {
      type: MSG.INIT,
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
    send({ type: MSG.SELECT_START, timer: SELECT_TIMER });
  },

  // Networking callbacks
  tickNonHost: (dt) => tickWatcherFn(watcher, dt, watcherTickCtx),
  everyTick: (dt) => tickMigrationAnnouncementFn(watcher, runtime.rs.frame, dt),
  onLocalCrosshairCollected: (ctrl, ch) => {
    if (session.isHost) broadcastLocalCrosshair(ctrl, ch, { lastSentAimTarget: dedup.aimTarget, send });
  },
  extendCrosshairs: (crosshairs, dt) =>
    extendWithRemoteCrosshairs(crosshairs, runtime.rs.state, dt, {
      remoteCrosshairs: watcher.remoteCrosshairs,
      crosshairPos: watcher.crosshairPos,
      remoteHumanSlots: session.remoteHumanSlots,
      logThrottled,
    }),
  hostNetworking: {
    serializePlayers,
    buildCannonStartMessage,
    buildBattleStartMessage,
    buildBuildStartMessage,
    remoteCannonPhantoms: () => watcher.remoteCannonPhantoms,
    remotePiecePhantoms: () => watcher.remotePiecePhantoms,
    lastSentCannonPhantom: () => dedup.cannonPhantom,
    lastSentPiecePhantom: () => dedup.piecePhantom,
  },
  watcherTiming: watcher.timing,
  maybeSendAimUpdate,
  tryPlaceCannonAndSend: (ctrl, gs, max) => tryPlaceCannonAndSendAction(ctrl, gs, max, send),
  tryPlacePieceAndSend: (ctrl, gs) => tryPlacePieceAndSendAction(ctrl, gs, send),
  fireAndSend: (ctrl, gs) => fireAndSendAction(ctrl, gs, send),
  onEndGame: (winner, gameState) => {
    const payloads = buildGameOverPayload(winner, gameState, PLAYER_NAMES);
    log(`endGame winner=${payloads.winnerName} round=${gameState.round} battleLength=${gameState.battleLength}`);
    if (session.isHost) send(payloads.serverPayload);
  },
});

let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function logThrottled(key: string, msg: string): void {
  if (!DEV) return;
  const now = performance.now();
  const last = _throttleTimestamps.get(key) ?? 0;
  if (now - last < LOG_THROTTLE_MS) return;
  _throttleTimestamps.set(key, now);
  log(msg);
}

function connect(): void {
  connectWebSocket(session, getWsUrl(), {
    onMessage: (msg) => {
      if (reconnectAttempt > 0) {
        log(`reconnected after ${reconnectAttempt} attempt(s)`);
        clearReconnect();
      }
      handleServerMessage(msg);
    },
    onClose: () => {
      const m = runtime.rs.mode;
      log(`WebSocket closed (mode=${Mode[m]} isHost=${session.isHost})`);
      if (session.isHost || m === Mode.STOPPED || m === Mode.LOBBY) return;
      if (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempt++;
        const delay = RECONNECT_BASE_DELAY_MS * (1 << (reconnectAttempt - 1));
        runtime.rs.frame.announcement = "Reconnecting\u2026";
        runtime.render();
        log(`reconnect attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
      } else {
        clearReconnect();
        runtime.rs.frame.announcement = "Disconnected from server";
        runtime.render();
        runtime.rs.mode = Mode.STOPPED;
      }
    },
    onError: () => {
      console.error("[online] WebSocket connection failed");
      lobbyElements.createError.textContent = "Connection failed \u2014 is the server running?";
      lobbyElements.joinError.textContent = "Connection failed \u2014 is the server running?";
    },
  });
}

function maybeSendAimUpdate(x: number, y: number, playerId?: number): void {
  sendAimUpdate(session, dedup, x, y, playerId);
}

function showLobby(): void {
  runtime.rs.mode = Mode.STOPPED;
  runtime.rs.lobby.active = false;
  renderer.container.classList.remove(GAME_CONTAINER_ACTIVE);
  roomCodeOverlay.style.display = "none";
  navigateTo("/online");
  resetSession();
}

function checkpointArgs(msg: ServerMessage) {
  return [
    watcher, msg,
    runtime.rs.state, runtime.rs.battleAnim, runtime.rs.accum,
    () => runtime.snapshotTerritory(),
  ] as const;
}

function handleServerMessage(msg: ServerMessage): void {
  log(`received: ${msg.type}`);
  if (handleServerLifecycleMessage(msg, buildLifecycleDeps())) return;
  handleServerIncrementalMessage(msg, buildIncrementalDeps());
}

function buildLifecycleDeps() {
  return {
    log,
    isHost: session.isHost,
    getState: () => runtime.rs.state,
    getLifeLostDialog: () => runtime.lifeLost.get(),
    clearLifeLostDialog: () => { runtime.lifeLost.set(null); },
    isLifeLostMode: () => runtime.rs.mode === Mode.LIFE_LOST,
    setGameMode: () => { runtime.rs.mode = Mode.GAME; },
    setLobbyWaitTimer: (s: number) => { session.lobbyWaitTimer = s; },
    setRoomSettings: (bl: number, hp: number) => { session.roomBattleLength = bl; session.roomCannonMaxHp = hp; },
    showWaitingRoom,
    setLobbyStartTime: (t: number) => { session.lobbyStartTime = t; },
    now: () => performance.now(),
    lobbyJoined: runtime.rs.lobby.joined,
    occupiedSlots: session.occupiedSlots,
    remoteHumanSlots: session.remoteHumanSlots,
    getMyPlayerId: () => session.myPlayerId,
    setMyPlayerId: (pid: number) => { session.myPlayerId = pid; },
    createErrorEl: lobbyElements.createError,
    joinErrorEl: lobbyElements.joinError,
    initFromServer,
    enterTowerSelection: () => runtime.selection.enter(),
    onCastleWalls: (msg: ServerMessage) => handleCastleWallsTransition(msg, transitionCtx),
    onCannonStart: (msg: ServerMessage) => handleCannonStartTransition(msg, transitionCtx),
    onBattleStart: (msg: ServerMessage) => handleBattleStartTransition(msg, transitionCtx),
    onBuildStart: (msg: ServerMessage) => handleBuildStartTransition(msg, transitionCtx),
    onBuildEnd: (msg: ServerMessage) => handleBuildEndTransition(msg, transitionCtx),
    onGameOver: (msg: ServerMessage) => handleGameOverTransition(msg, transitionCtx),
    setAnnouncement: (text: string) => {
      watcher.migrationText = text;
      watcher.migrationTimer = MIGRATION_ANNOUNCEMENT_DURATION;
    },
    getHostMigrationSeq: () => session.hostMigrationSeq,
    setHostMigrationSeq: (seq: number) => {
      session.hostMigrationSeq = seq;
    },
    bumpHostMigrationSeq: () => {
      session.hostMigrationSeq++;
    },
    playerNames: PLAYER_NAMES,
    promoteToHost,
    applyFullState,
  };
}

function showWaitingRoom(code: string, seed: number): void {
  session.roomSeed = seed;
  runtime.rs.settings.seed = String(seed);
  initWaitingRoom({
    code, seed, lobbyEl: pageOnline, container: renderer.container, roomCodeOverlay,
    lobby: runtime.rs.lobby,
    maxPlayers: MAX_PLAYERS,
    now: () => performance.now(),
    setLobbyStartTime: (t: number) => { session.lobbyStartTime = t; },
    setModeLobby: () => { runtime.rs.mode = Mode.LOBBY; },
    setLastTime: (t: number) => { runtime.rs.lastTime = t; },
    requestFrame: () => { requestAnimationFrame(runtime.mainLoop); },
  });
}

function initFromServer(msg: InitMessage): void {
  roomCodeOverlay.style.display = "none";
  runtime.rs.lobby.active = false;
  const settings = runtime.rs.settings;
  bootstrapGame({
    seed: msg.seed,
    maxPlayers: msg.playerCount,
    battleLength: msg.settings.battleLength,
    cannonMaxHp: msg.settings.cannonMaxHp,
    buildTimer: msg.settings.buildTimer,
    cannonPlaceTimer: msg.settings.cannonPlaceTimer,
    log,
    resetFrame: () => runtime.resetFrame(),
    setState: (s) => { runtime.rs.state = s; },
    setControllers: (c) => { runtime.rs.controllers = [...c]; },
    resetUIState: () => {
      runtime.resetUIState();
      resetWatcherState(watcher);
      resetDedup();
    },
    createControllerForSlot: createOnlineControllerSlotFactory(session.myPlayerId, settings.keyBindings[0]!),
    enterSelection: () => runtime.selection.enter(),
  });
}

function buildIncrementalDeps() {
  return {
    log,
    isHost: session.isHost,
    getState: () => runtime.rs.state,
    remoteHumanSlots: session.remoteHumanSlots,
    selectionStates: runtime.selection.getStates(),
    syncSelectionOverlay: () => runtime.selection.syncOverlay(),
    isCastleReselectPhase: () => isReselectPhase(runtime.rs.state.phase),
    onRemotePlayerReselected: (playerId: number) => {
      markPlayerReselected(runtime.rs.state, playerId);
      runtime.rs.reselectionPids.push(playerId);
    },
    confirmSelectionForPlayer: (playerId: number, isReselect: boolean) => {
      runtime.selection.confirm(playerId, isReselect);
    },
    allSelectionsConfirmed: () => runtime.selection.allConfirmed(),
    finishReselection: () => runtime.selection.finishReselection(),
    finishSelection: () => runtime.selection.finish(),
    applyPiecePlacement,
    canApplyPiecePlacement: (state: import("./types.ts").GameState, playerId: number, offsets: readonly [number, number][], row: number, col: number) =>
      canPlacePieceOffsets(state, playerId, offsets, row, col),
    applyCannonPlacement: (state: import("./types.ts").GameState, playerId: number, row: number, col: number, mode: string) => {
      applyCannonPlacement(state.players[playerId]!, row, col, mode as CannonMode, state);
    },
    canApplyCannonPlacement: (state: import("./types.ts").GameState, playerId: number, row: number, col: number, mode: string) => {
      const player = state.players[playerId];
      if (!player) return false;
      const maxCannons = state.cannonLimits[playerId] ?? 0;
      const normalizedMode = mode as CannonMode;
      if (cannonSlotsUsed(player) + cannonSlotCost({ kind: normalizedMode }) > maxCannons) return false;
      return canPlaceCannon(player, row, col, normalizedMode, state);
    },
    applyImpactEvent,
    gridCols: GRID_COLS,
    remoteCrosshairs: watcher.remoteCrosshairs,
    watcherOrbitParams: watcher.orbitParams,
    getRemotePiecePhantoms: () => watcher.remotePiecePhantoms,
    setRemotePiecePhantoms: (value: typeof watcher.remotePiecePhantoms) => { watcher.remotePiecePhantoms = value; },
    getRemoteCannonPhantoms: () => watcher.remoteCannonPhantoms,
    setRemoteCannonPhantoms: (value: typeof watcher.remoteCannonPhantoms) => { watcher.remoteCannonPhantoms = value; },
    getLifeLostDialog: () => runtime.lifeLost.get(),
    queueEarlyLifeLostChoice: (playerId: number, choice: LifeLostChoice) => {
      session.earlyLifeLostChoices.set(playerId, choice);
    },
  };
}

function promoteToHost(): void {
  log("PROMOTING TO HOST");
  session.isHost = true;

  resetNetworkingForHost();
  rebuildControllersForPhase(runtime.rs.state, runtime.rs.controllers, session.myPlayerId, (id, seed) => createController(id, true, undefined, seed));
  syncAccumulatorsFromTimer(runtime.rs.state, runtime.rs.accum);
  skipPendingAnimations();

  send(buildFullStateMessage(runtime.rs.state, session.hostMigrationSeq, runtime.rs.battleAnim.flights));
  log("Promotion complete, now running as host");
}

/**
 * Clear all networking state that the host doesn't carry over from the watcher phase.
 * When adding new online mutable state, add its reset here.
 */
function resetNetworkingForHost(): void {
  resetDedup();
  // Host uses accumulators, not wall-clock timing
  watcher.timing.phaseStartTime = 0;
  watcher.timing.phaseDuration = 0;
  watcher.timing.countdownStartTime = 0;
  watcher.timing.countdownDuration = 0;
  // Host drives crosshair orbit/idle directly via AI controllers
  watcher.idlePhases.clear();
  watcher.orbitParams.clear();
  // Keep remoteCrosshairs, remoteCannonPhantoms, remotePiecePhantoms, crosshairPos
  // — still used by the host for remote human players via extendCrosshairs
}

/**
 * Skip any animations or dialogs that depend on the old host's state.
 * NOTE: when adding new Mode values, check if they need handling here.
 */
function skipPendingAnimations(): void {
  const state = runtime.rs.state;
  const mode = runtime.rs.mode;
  if (mode === Mode.CASTLE_BUILD) {
    runtime.rs.castleBuilds = [];
    finalizeCastleConstruction(state);
    enterCannonPlacePhase(state);
    runtime.startCannonPhase();
    runtime.rs.mode = Mode.GAME;
    log("Skipped castle build animation → cannon phase");
  } else if (mode === Mode.LIFE_LOST) {
    runtime.lifeLost.set(null);
    runtime.rs.mode = Mode.GAME;
    log("Cleared life-lost dialog → game mode");
  } else if (mode === Mode.BANNER || mode === Mode.BALLOON_ANIM) {
    runtime.rs.mode = Mode.GAME;
    log("Skipped banner/animation → game mode");
  }
  // GAME, LOBBY, OPTIONS, CONTROLS, SELECTION, STOPPED — no action needed
}

function log(msg: string): void {
  if (!DEV) return;
  const modeStr = session.isHost ? "host" : session.myPlayerId >= 0 ? "player" : "watcher";
  console.log(`[online] (mode=${modeStr} pid=${session.myPlayerId}) ${msg}`);
}

function send(msg: GameMessage): void {
  sendMessage(session, msg);
}

function applyFullState(msg: FullStateMessage): void {
  // Stale-seq rejection is handled by the lifecycle handler in online-server-lifecycle.ts
  const state = runtime.rs.state;
  const result = applyFullStateSnapshot(state, msg);

  if (result.balloonFlights) {
    runtime.rs.battleAnim.flights = result.balloonFlights;
  }

  watcher.timing.phaseStartTime = performance.now();
  watcher.timing.phaseDuration = state.timer;
  if (state.battleCountdown > 0) {
    watcher.timing.countdownStartTime = performance.now();
    watcher.timing.countdownDuration = state.battleCountdown;
  }
}

runtime.registerInputHandlers();

// Clean up when the router navigates away from the game (back button)
document.addEventListener(GAME_EXIT_EVENT, () => {
  runtime.rs.mode = Mode.STOPPED;
  runtime.rs.lobby.active = false;
  roomCodeOverlay.style.display = "none";
  resetSession();
});

function resetSession(): void {
  clearReconnect();
  resetSessionState(session);
  runtime.rs.settings.seed = "";
  resetDedup();
}

function clearReconnect(): void {
  reconnectAttempt = 0;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function resetDedup(): void {
  resetDedupMaps(dedup);
}
