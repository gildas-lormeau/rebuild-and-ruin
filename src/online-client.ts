/**
 * Online play entry point.
 *
 * All shared game logic lives in game-runtime.ts via createGameRuntime().
 * This file only provides the online-specific wiring: WebSocket networking,
 * DOM lobby, watcher state, server message handling, and phase handlers.
 */

import { GRID_COLS } from "./grid.ts";
import { TILE } from "./map-renderer.ts";
import {
  Phase,
  SELECT_TIMER,
  LOBBY_TIMER,
  BUILD_TIMER,
  CANNON_PLACE_TIMER,
  CROSSHAIR_SPEED,
  BATTLE_COUNTDOWN,
  BANNER_DURATION,
  CannonMode,
} from "./types.ts";
import type { GameState } from "./types.ts";
import {
  nextReadyCombined,
  aimCannons,
} from "./battle-system.ts";
import { autoPlaceCannons } from "./ai-strategy.ts";
import {
  serializePlayers,
  applyPlayersCheckpoint,
  buildBuildStartMessage,
  buildCannonStartMessage,
  buildBattleStartMessage,
} from "./online-serialize.ts";
import {
  fireAndSend as fireAndSendAction,
  tryPlaceCannonAndSend as tryPlaceCannonAndSendAction,
  tryPlacePieceAndSend as tryPlacePieceAndSendAction,
} from "./online-send-actions.ts";
import { interpolateToward } from "./online-types.ts";
import type { CannonPhantom, PiecePhantom } from "./online-types.ts";
import { tickGrunts } from "./grunt-system.ts";
import { isHuman, createController } from "./player-controller.ts";
import type { PlayerController } from "./player-controller.ts";
import { showLobbySection, setupLobbyUi } from "./online-lobby-ui.ts";
import { bootstrapGame, setupWaitingRoom } from "./game-bootstrap.ts";
import { handleServerLifecycleMessage } from "./online-server-lifecycle.ts";
import { handleServerIncrementalMessage } from "./online-server-events.ts";
import {
  handleCastleWallsTransition,
  handleCannonStartTransition,
  handleBattleStartTransition,
  handleBuildStartTransition,
  handleBuildEndTransition,
  handleGameOverTransition,
} from "./online-phase-transitions.ts";
import type { TransitionContext } from "./online-phase-transitions.ts";
import { Mode } from "./game-ui-types.ts";
import { loadAtlas } from "./sprites.ts";
import {
  applyCannonStartCheckpoint,
  applyBattleStartCheckpoint,
  applyBuildStartCheckpoint,
} from "./online-checkpoints.ts";
import {
  markPlayerReselected,
  prepareCastleWalls,
  enterCannonPlacePhase,
  finalizeCastleConstruction,
  resetZoneState,
} from "./game-engine.ts";
import { applyPiecePlacement } from "./build-phase.ts";
import { applyCannonPlacement } from "./cannon-system.ts";
import { applyImpactEvent } from "./battle-system.ts";
import {
  tickWatcherTimers as updateWatcherTimers,
  tickWatcherBattlePhase,
  tickWatcherCannonPhantomsPhase,
  tickWatcherBuildPhantomsPhase,
} from "./online-watcher-battle.ts";
import type { WatcherTimingState } from "./online-watcher-battle.ts";
import {
  PLAYER_COLORS,
  PLAYER_NAMES,
  MAX_PLAYERS,
} from "./player-config.ts";
import type {
  ClientMessage,
  ServerMessage,
  InitMessage,
} from "../server/protocol.ts";
import { createGameRuntime } from "./game-runtime.ts";
import type { GameRuntime } from "./game-runtime.ts";

// ---------------------------------------------------------------------------
// Game over payloads
// ---------------------------------------------------------------------------

function buildGameOverServerPayload(
  winner: { id: number } | null,
  state: GameState,
  playerNames: ReadonlyArray<string>,
) {
  return {
    winnerName: winner
      ? (playerNames[winner.id] ?? `Player ${winner.id + 1}`)
      : "Nobody",
    serverPayload: {
      type: "game_over" as const,
      winner: winner
        ? (playerNames[winner.id] ?? `Player ${winner.id + 1}`)
        : null,
      scores: state.players.map((p) => ({
        name: playerNames[p.id] ?? `P${p.id + 1}`,
        score: p.score,
        eliminated: p.eliminated,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------------

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

// DOM lobby elements (from index.html)
const lobbyEl = document.getElementById("lobby")!;
const lobbyMenu = document.getElementById("lobby-menu")!;
const lobbyCreate = document.getElementById("lobby-create")!;
const lobbyJoin = document.getElementById("lobby-join")!;
const btnCreate = document.getElementById("btn-create")!;
const btnJoinShow = document.getElementById("btn-join-show")!;
const btnCreateConfirm = document.getElementById("btn-create-confirm")!;
const btnJoinConfirm = document.getElementById("btn-join-confirm")!;
const btnCreateBack = document.getElementById("btn-create-back")!;
const btnJoinBack = document.getElementById("btn-join-back")!;
const setRounds = document.getElementById("set-rounds") as HTMLSelectElement;
const setHp = document.getElementById("set-hp") as HTMLSelectElement;
const setWait = document.getElementById("set-wait") as HTMLSelectElement;
const joinCodeInput = document.getElementById("join-code") as HTMLInputElement;
const createError = document.getElementById("create-error")!;
const joinError = document.getElementById("join-error")!;
const roomCodeOverlay = document.getElementById("room-code-overlay")!;

// ---------------------------------------------------------------------------
// Network state
// ---------------------------------------------------------------------------

let ws: WebSocket | null = null;
let myPlayerId = -1;
let isHost = false;
let occupiedSlots = new Set<number>();
/** Slots occupied by remote humans (other players, not our own slot). */
const remoteHumanSlots = new Set<number>();
let lobbyWaitTimer = LOBBY_TIMER; // overridden by server's waitTimerSec
let roomSeed = 0;
let roomBattleLength = 0;
let roomCannonMaxHp = 3;

// Watcher: wall-clock timer (immune to RAF throttling when tab is backgrounded)
const watcherTiming: WatcherTimingState = {
  phaseStartTime: 0,
  phaseDuration: 0,
  countdownStartTime: 0,
  countdownDuration: 0,
};

// Watcher state: remote crosshairs and phantoms received from host
const remoteCrosshairs = new Map<number, { x: number; y: number }>();
let remoteCannonPhantoms: CannonPhantom[] = [];
const watcherCrosshairPos = new Map<number, { x: number; y: number }>();
const watcherIdlePhases = new Map<number, number>();
const watcherOrbitParams = new Map<
  number,
  { rx: number; ry: number; speed: number; phase: number }
>();
let remotePiecePhantoms: PiecePhantom[] = [];

// @ts-ignore — import.meta.env is Vite-specific (not recognized by Deno LSP)
// @ts-ignore — import.meta.env is Vite-specific
const DEV = import.meta.env?.DEV ?? (location?.hostname === "localhost");

/** Structured log for E2E test analysis (dev only). */
function log(msg: string): void {
  if (!DEV) return;
  const modeStr = isHost ? "host" : myPlayerId >= 0 ? "player" : "watcher";
  console.log(`[online] (mode=${modeStr} pid=${myPlayerId}) ${msg}`);
}

/** Throttled log — logs at most once per second per key (dev only). */
const _throttleTimestamps = new Map<string, number>();
function logThrottled(key: string, msg: string): void {
  if (!DEV) return;
  const now = performance.now();
  const last = _throttleTimestamps.get(key) ?? 0;
  if (now - last < 1000) return;
  _throttleTimestamps.set(key, now);
  log(msg);
}

/** Get the server host — from localStorage, URL param, or same-origin fallback. */
function getServerHost(): string {
  const param = new URLSearchParams(location.search).get("server");
  if (param) return param;
  const saved = localStorage.getItem("castles99_server");
  if (saved) return saved;
  return location.host;
}

/** Get the full WebSocket URL for the game server. */
export function getWsUrl(): string {
  const host = getServerHost();
  const proto = host.includes("localhost") || host.match(/^192\./) ? "ws:" : "wss:";
  return `${proto}//${host}/ws/play`;
}

/** Get the HTTP base URL for the game server API. */
export function getApiUrl(path: string): string {
  const host = getServerHost();
  const proto = host.includes("localhost") || host.match(/^192\./) ? "http:" : "https:";
  return `${proto}//${host}${path}`;
}

function connect(): void {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  ws = new WebSocket(getWsUrl());
  ws.onmessage = (e) => {
    try {
      handleServerMessage(JSON.parse(e.data) as ServerMessage);
    } catch {
      /* ignore malformed */
    }
  };
  ws.onclose = () => {
    const m = runtime.getMode();
    log(`WebSocket closed (mode=${Mode[m]} isHost=${isHost})`);
    if (!isHost && m !== Mode.STOPPED && m !== Mode.LOBBY) {
      runtime.getFrame().announcement = "Disconnected from server";
      runtime.render();
      runtime.setMode(Mode.STOPPED);
    }
  };
  ws.onerror = () => {
    console.error("[online] WebSocket connection failed");
    createError.textContent = "Connection failed — is the server running?";
    joinError.textContent = "Connection failed — is the server running?";
  };
}

function send(msg: ClientMessage | ServerMessage): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Send aim_update only when the target changes (not every frame)
const lastSentAimTarget = new Map<number, string>();
function maybeSendAimUpdate(x: number, y: number, playerId?: number): void {
  const pid = playerId ?? myPlayerId;
  const key = `${Math.round(x)},${Math.round(y)}`;
  if (lastSentAimTarget.get(pid) === key) return;
  lastSentAimTarget.set(pid, key);
  send({ type: "aim_update", playerId: pid, x, y });
}

// Send phantom only when position/piece changes
const lastSentPiecePhantom = new Map<number, string>();
const lastSentCannonPhantom = new Map<number, string>();

// ---------------------------------------------------------------------------
// Lobby start time tracking
// ---------------------------------------------------------------------------

let lobbyStartTime = 0; // performance.now() when lobby started

// ---------------------------------------------------------------------------
// Online showLobby — returns to DOM lobby
// ---------------------------------------------------------------------------

function showLobby(): void {
  runtime.setMode(Mode.STOPPED);
  runtime.getLobby().active = false;
  canvas.style.display = "none";
  roomCodeOverlay.style.display = "none";
  lobbyEl.style.display = "block";
  showLobbySection("lobby-menu", { lobbyMenu, lobbyCreate, lobbyJoin });
  ws?.close();
  ws = null;
  isHost = false;
  myPlayerId = -1;
  occupiedSlots = new Set();
  remoteHumanSlots.clear();
}

// ---------------------------------------------------------------------------
// Watcher tick functions (online-only)
// ---------------------------------------------------------------------------

function tickWatcher(dt: number) {
  const state = runtime.getState();
  const frame = runtime.getFrame();
  const accum = runtime.getAccum();

  updateWatcherTimers(state, frame, watcherTiming, () => performance.now());

  const myHuman = getLocalHuman();

  if (state.phase === Phase.BATTLE) {
    tickWatcherBattle(dt, myHuman);
  } else if (state.phase === Phase.CANNON_PLACE) {
    tickWatcherCannonPhantoms(dt, myHuman);
  } else if (state.phase === Phase.WALL_BUILD) {
    tickWatcherBuildPhantoms(dt, myHuman);
  }

  // Grunt movement during build phase (deterministic — runs locally)
  if (state.phase === Phase.WALL_BUILD) {
    accum.grunt += dt;
    if (accum.grunt >= 1.0) {
      accum.grunt -= 1.0;
      tickGrunts(state);
    }
  }

  runtime.render();
}

/** Get the local human controller, or null if eliminated/watcher. */
function getLocalHuman(): PlayerController | null {
  const state = runtime.getState();
  if (myPlayerId < 0 || state.players[myPlayerId]?.eliminated) return null;
  const ctrl = runtime.getControllers()[myPlayerId];
  return ctrl && isHuman(ctrl) ? ctrl : null;
}

/** Non-host battle: move cannonballs, collect crosshairs, tick local human. */
function tickWatcherBattle(dt: number, myHuman: PlayerController | null): void {
  const state = runtime.getState();
  tickWatcherBattlePhase({
    state,
    frame: runtime.getFrame(),
    battleAnim: runtime.getBattleAnim(),
    dt,
    myPlayerId,
    myHuman,
    remoteCrosshairs,
    watcherCrosshairPos,
    watcherIdlePhases,
    watcherOrbitParams,
    crosshairSpeed: CROSSHAIR_SPEED,
    tileSize: TILE,
    logThrottled,
    interpolateToward,
    nextReadyCombined,
    maybeSendAimUpdate,
    aimCannons,
  });
}

/** Non-host cannon phase: merge remote phantoms + tick local human. */
function tickWatcherCannonPhantoms(
  dt: number,
  myHuman: PlayerController | null,
): void {
  tickWatcherCannonPhantomsPhase({
    state: runtime.getState(),
    frame: runtime.getFrame(),
    dt,
    myPlayerId,
    myHuman,
    remoteCannonPhantoms,
    lastSentCannonPhantom,
    sendOpponentCannonPhantom: (msg) => {
      send({ type: "opponent_cannon_phantom", ...msg });
    },
  });
}

/** Non-host build phase: merge remote phantoms + tick local human. */
function tickWatcherBuildPhantoms(
  dt: number,
  myHuman: PlayerController | null,
): void {
  tickWatcherBuildPhantomsPhase({
    state: runtime.getState(),
    frame: runtime.getFrame(),
    dt,
    myHuman,
    remotePiecePhantoms,
    lastSentPiecePhantom,
    sendOpponentPiecePhantom: (msg) => {
      send({ type: "opponent_phantom", ...msg });
    },
  });
}

// ---------------------------------------------------------------------------
// Watcher: apply checkpoint data from server
// ---------------------------------------------------------------------------

function applyCannonStartData(msg: ServerMessage): void {
  applyCannonStartCheckpoint(msg, {
    state: runtime.getState(),
    battleAnim: runtime.getBattleAnim(),
    accum: runtime.getAccum(),
    remoteCrosshairs,
    watcherCrosshairPos,
    watcherOrbitParams,
    watcherIdlePhases,
    snapshotTerritory: () => runtime.snapshotTerritory(),
  });
}

function applyBattleStartData(msg: ServerMessage): void {
  applyBattleStartCheckpoint(msg, {
    state: runtime.getState(),
    battleAnim: runtime.getBattleAnim(),
    accum: runtime.getAccum(),
    remoteCrosshairs,
    watcherCrosshairPos,
    watcherOrbitParams,
    watcherIdlePhases,
    snapshotTerritory: () => runtime.snapshotTerritory(),
  });
}

function applyBuildStartData(msg: ServerMessage): void {
  applyBuildStartCheckpoint(msg, {
    state: runtime.getState(),
    battleAnim: runtime.getBattleAnim(),
    accum: runtime.getAccum(),
    remoteCrosshairs,
    watcherCrosshairPos,
    watcherOrbitParams,
    watcherIdlePhases,
    snapshotTerritory: () => runtime.snapshotTerritory(),
  });
}

// ---------------------------------------------------------------------------
// Canvas waiting room
// ---------------------------------------------------------------------------

function showWaitingRoom(code: string, seed: number): void {
  roomSeed = seed;
  setupWaitingRoom({
    code,
    seed,
    lobbyEl,
    canvas,
    roomCodeOverlay,
    lobby: runtime.getLobby(),
    maxPlayers: MAX_PLAYERS,
    now: () => performance.now(),
    setLobbyStartTime: (timeMs: number) => {
      lobbyStartTime = timeMs;
    },
    setModeLobby: () => {
      runtime.setMode(Mode.LOBBY);
    },
    setLastTime: (timeMs: number) => {
      runtime.setLastTime(timeMs);
    },
    requestFrame: () => {
      requestAnimationFrame(runtime.mainLoop);
    },
  });
}

// ---------------------------------------------------------------------------
// Game init from server
// ---------------------------------------------------------------------------

function initFromServer(msg: InitMessage): void {
  roomCodeOverlay.style.display = "none";
  runtime.getLobby().active = false;

  const settings = runtime.getSettings();

  bootstrapGame({
    seed: msg.seed,
    maxPlayers: msg.playerCount,
    battleLength: msg.settings.battleLength,
    cannonMaxHp: msg.settings.cannonMaxHp,
    buildTimer: msg.settings.buildTimer,
    cannonPlaceTimer: msg.settings.cannonPlaceTimer,
    log,
    resetFrame: () => runtime.resetFrame(),
    setState: (s) => { runtime.setState(s); },
    setControllers: (c) => { runtime.setControllers(c); },
    resetUIState: () => {
      runtime.resetUIState();
      // Online-specific resets
      remoteCrosshairs.clear();
      remoteCannonPhantoms = [];
      remotePiecePhantoms = [];
      watcherCrosshairPos.clear();
      watcherIdlePhases.clear();
      watcherOrbitParams.clear();
      lastSentAimTarget.clear();
      lastSentPiecePhantom.clear();
      lastSentCannonPhantom.clear();
      watcherTiming.phaseStartTime = 0;
      watcherTiming.phaseDuration = 0;
      watcherTiming.countdownStartTime = 0;
      watcherTiming.countdownDuration = 0;
    },
    createControllerForSlot: (i, gameState) => {
      const isAi = (i !== myPlayerId);
      const strategySeed = isAi ? gameState.rng.int(0, 0xffffffff) : undefined;
      const kb = isAi ? undefined : settings.keyBindings[0]!;
      return createController(i, isAi, kb, strategySeed);
    },
    enterSelection: () => runtime.enterTowerSelection(),
  });
}

// ---------------------------------------------------------------------------
// Phase transition handlers (called from handleServerMessage, non-host only)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transition context (shared by all watcher phase transition handlers)
// ---------------------------------------------------------------------------

const transitionCtx: TransitionContext = {
  getState: () => runtime.getState(),
  getMyPlayerId: () => myPlayerId,
  getControllers: () => runtime.getControllers(),
  showBanner: (t, cb, r, nb) => runtime.showBanner(t, cb, r, nb),
  clearSelectionOverlay: () => {
    const overlay = runtime.getOverlay();
    if (overlay.selection) {
      overlay.selection.highlights = undefined;
      overlay.selection.highlighted = null;
      overlay.selection.selected = null;
    }
  },
  now: () => performance.now(),
  setWatcherPhaseStartTime: (v) => { watcherTiming.phaseStartTime = v; },
  setWatcherPhaseDuration: (v) => { watcherTiming.phaseDuration = v; },
  setWatcherCountdownStartTime: (v) => { watcherTiming.countdownStartTime = v; },
  setWatcherCountdownDuration: (v) => { watcherTiming.countdownDuration = v; },
  setModeGame: () => { runtime.setMode(Mode.GAME); },
  setModeCastleBuild: () => { runtime.setMode(Mode.CASTLE_BUILD); },
  setModeBalloonAnim: () => { runtime.setMode(Mode.BALLOON_ANIM); },
  setModeStopped: () => { runtime.setMode(Mode.STOPPED); },
  battleCountdown: BATTLE_COUNTDOWN,
  bannerDuration: BANNER_DURATION,
  playerColors: PLAYER_COLORS,
  applyCannonStartData,
  applyBattleStartData,
  applyBuildStartData,
  applyPlayersCheckpoint,
  resetZoneState,
  prepareCastleWalls,
  finalizeCastleConstruction,
  enterCannonPlacePhase,
  getSelectionStates: () => runtime.getSelectionStates(),
  setCastleBuildFromPlans: (plans, maxTiles, onDone) => {
    runtime.setCastleBuild({ wallPlans: plans, maxTiles, tileIdx: 0, accum: 0, onDone });
  },
  setBattleFlights: (v) => { runtime.getBattleAnim().flights = v; },
  snapshotTerritory: () => runtime.snapshotTerritory(),
  showLifeLostDialog: (nr, el) => runtime.showLifeLostDialog(nr, el),
  render: () => runtime.render(),
  setGameOverFrame: (p) => { runtime.getFrame().gameOver = p; },
};


// ---------------------------------------------------------------------------
// Server message handler
// ---------------------------------------------------------------------------

function handleServerMessage(msg: ServerMessage): void {
  log(`received: ${msg.type}`);
  if (
    handleServerLifecycleMessage(msg, {
      log,
      isHost,
      getState: () => runtime.getState(),
      getLifeLostDialog: () => runtime.getLifeLostDialog(),
      clearLifeLostDialog: () => {
        runtime.setLifeLostDialog(null);
      },
      isLifeLostMode: () => runtime.getMode() === Mode.LIFE_LOST,
      setGameMode: () => {
        runtime.setMode(Mode.GAME);
      },
      setLobbyWaitTimer: (seconds) => {
        lobbyWaitTimer = seconds;
      },
      setRoomSettings: (battleLength, cannonMaxHp) => {
        roomBattleLength = battleLength;
        roomCannonMaxHp = cannonMaxHp;
      },
      showWaitingRoom,
      setLobbyStartTime: (timeMs) => {
        lobbyStartTime = timeMs;
      },
      now: () => performance.now(),
      lobbyJoined: runtime.getLobby().joined,
      occupiedSlots,
      remoteHumanSlots,
      getMyPlayerId: () => myPlayerId,
      setMyPlayerId: (playerId) => {
        myPlayerId = playerId;
      },
      createErrorEl: createError,
      joinErrorEl: joinError,
      initFromServer,
      enterTowerSelection: () => runtime.enterTowerSelection(),
      onCastleWalls: (msg) => handleCastleWallsTransition(msg, transitionCtx),
      onCannonStart: (msg) => handleCannonStartTransition(msg, transitionCtx),
      onBattleStart: (msg) => handleBattleStartTransition(msg, transitionCtx),
      onBuildStart: (msg) => handleBuildStartTransition(msg, transitionCtx),
      onBuildEnd: (msg) => handleBuildEndTransition(msg, transitionCtx),
      onGameOver: (msg) => handleGameOverTransition(msg, transitionCtx),
    })
  ) {
    return;
  }

  handleServerIncrementalMessage(msg, {
    log,
    isHost,
    getState: () => runtime.getState(),
    remoteHumanSlots,
    selectionStates: runtime.getSelectionStates(),
    syncSelectionOverlay: () => runtime.syncSelectionOverlay(),
    isCastleReselectPhase: () => runtime.getState().phase === Phase.CASTLE_RESELECT,
    onRemotePlayerReselected: (playerId) => {
      markPlayerReselected(runtime.getState(), playerId);
      runtime.getReselectionPids().push(playerId);
    },
    allSelectionsConfirmed: () => runtime.allSelectionsConfirmed(),
    finishReselection: () => runtime.finishReselection(),
    finishSelection: () => runtime.finishSelection(),
    applyPiecePlacement,
    applyCannonPlacement: (currentState, playerId, row, col, mode) => {
      applyCannonPlacement(
        currentState.players[playerId]!,
        row,
        col,
        mode as CannonMode,
        currentState,
      );
    },
    applyImpactEvent,
    gridCols: GRID_COLS,
    remoteCrosshairs,
    watcherOrbitParams,
    getRemotePiecePhantoms: () => remotePiecePhantoms,
    setRemotePiecePhantoms: (value) => {
      remotePiecePhantoms = value;
    },
    getRemoteCannonPhantoms: () => remoteCannonPhantoms,
    setRemoteCannonPhantoms: (value) => {
      remoteCannonPhantoms = value;
    },
    getLifeLostDialog: () => runtime.getLifeLostDialog(),
  });
}

// ---------------------------------------------------------------------------
// Create the runtime
// ---------------------------------------------------------------------------

const runtime: GameRuntime = createGameRuntime({
  canvas,
  isOnline: true,
  send,
  getIsHost: () => isHost,
  getMyPlayerId: () => myPlayerId,
  getRemoteHumanSlots: () => remoteHumanSlots,
  log,
  logThrottled,
  getLobbyRemaining: () => Math.max(0, lobbyWaitTimer - 1 - (performance.now() - lobbyStartTime) / 1000),
  showLobby,
  onLobbySlotJoined: (pid) => {
    send({ type: "select_slot", slotId: pid });
  },
  onCloseOptions: () => {
    if (runtime.getOptionsReturnMode() === null) {
      lobbyStartTime = performance.now();
    }
  },
  onTickLobbyExpired: () => {
    if (!isHost) return;
    // Host: build init message and relay to other clients, then process locally
    const initMsg: InitMessage = {
      type: "init",
      seed: roomSeed,
      playerCount: MAX_PLAYERS,
      settings: {
        battleLength: roomBattleLength,
        cannonMaxHp: roomCannonMaxHp,
        buildTimer: BUILD_TIMER,
        cannonPlaceTimer: CANNON_PLACE_TIMER,
      },
    };
    send(initMsg);
    initFromServer(initMsg);
    send({ type: "select_start", timer: SELECT_TIMER });
  },

  // Networking callbacks
  tickNonHost: tickWatcher,
  onLocalCrosshairCollected: (ctrl, ch, _readyCannon) => {
    if (isHost) {
      const target = ctrl.getCrosshairTarget() ?? ch;
      if (target) {
        const orbit = ctrl.getOrbitParams();
        const key = `${Math.round(target.x)},${Math.round(target.y)},${orbit ? "o" : ""}`;
        if (lastSentAimTarget.get(ctrl.playerId) !== key) {
          lastSentAimTarget.set(ctrl.playerId, key);
          send({
            type: "aim_update",
            playerId: ctrl.playerId,
            x: target.x,
            y: target.y,
            orbit: orbit ?? undefined,
          });
        }
      }
    }
  },
  extendCrosshairs: (crosshairs, dt) => {
    const state = runtime.getState();
    logThrottled(
      "host-ch-remote",
      `collectCrosshairs: localCh=${crosshairs.length} remoteCrosshairs keys=[${[...remoteCrosshairs.keys()]}] cannons=[${state.players.map((p, i) => `P${i}:${p.cannons.length}`).join(",")}]`,
    );
    for (const [pid, target] of remoteCrosshairs) {
      if (!remoteHumanSlots.has(pid)) continue;
      const player = state.players[pid];
      if (!player || player.eliminated) continue;
      const readyCannon = nextReadyCombined(state, pid);
      const anyReloading =
        !readyCannon &&
        state.cannonballs.some(
          (b) => b.playerId === pid || b.scoringPlayerId === pid,
        );
      if (!readyCannon && !anyReloading) continue;
      let vis = watcherCrosshairPos.get(pid);
      if (!vis) {
        vis = { x: target.x, y: target.y };
        watcherCrosshairPos.set(pid, vis);
      }
      interpolateToward(vis, target.x, target.y, CROSSHAIR_SPEED * 2, dt);
      crosshairs.push({
        x: vis.x,
        y: vis.y,
        playerId: pid,
        cannonReady: !!readyCannon,
      });
      aimCannons(state, pid, vis.x, vis.y, dt);
    }
    return crosshairs;
  },
  hostNetworking: {
    autoPlaceCannons,
    serializePlayers,
    buildCannonStartMessage,
    buildBattleStartMessage,
    buildBuildStartMessage,
    remoteCannonPhantoms: () => remoteCannonPhantoms,
    remotePiecePhantoms: () => remotePiecePhantoms,
    lastSentCannonPhantom: () => lastSentCannonPhantom,
    lastSentPiecePhantom: () => lastSentPiecePhantom,
  },
  watcherTiming,
  maybeSendAimUpdate,
  tryPlaceCannonAndSend: (ctrl, gs, max) => tryPlaceCannonAndSendAction(ctrl, gs, max, send),
  tryPlacePieceAndSend: (ctrl, gs) => tryPlacePieceAndSendAction(ctrl, gs, send),
  fireAndSend: (ctrl, gs) => fireAndSendAction(ctrl, gs, send),
  onEndGame: (winner, gameState) => {
    const payloads = buildGameOverServerPayload(winner, gameState, PLAYER_NAMES);
    log(
      `endGame winner=${payloads.winnerName} round=${gameState.round} battleLength=${gameState.battleLength}`,
    );
    if (isHost) send(payloads.serverPayload);
  },
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runtime.registerInputHandlers();

const initDomLobby = () =>
  setupLobbyUi({
    elements: {
      lobbyMenu,
      lobbyCreate,
      lobbyJoin,
      btnCreate,
      btnJoinShow,
      btnCreateConfirm,
      btnJoinConfirm,
      btnCreateBack,
      btnJoinBack,
      setRounds,
      setHp,
      setWait,
      joinCodeInput,
      createError,
      joinError,
    },
    connect,
    send,
    getSocket: () => ws,
    setIsHost: (value) => {
      isHost = value;
    },
  });

loadAtlas().then(initDomLobby, initDomLobby).then(() => {
  document.getElementById("lobby")?.setAttribute("data-ready", "1");
});
