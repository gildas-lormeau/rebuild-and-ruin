/**
 * Online play entry point.
 *
 * All shared game logic lives in game-runtime.ts via createGameRuntime().
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
import { autoPlaceCannons } from "./ai-strategy.ts";
import {
  aimCannons, applyImpactEvent,
  nextReadyCombined
} from "./battle-system.ts";
import { applyCannonPlacement } from "./cannon-system.ts";
import { createController } from "./controller-factory.ts";
import { bootstrapGame, setupWaitingRoom } from "./game-bootstrap.ts";
import {
  enterCannonPlacePhase,
  finalizeCastleConstruction,
  markPlayerReselected,
  resetZoneState,
} from "./game-engine.ts";
import type { GameRuntime } from "./game-runtime.ts";
import { createGameRuntime } from "./game-runtime.ts";
import { Mode } from "./game-ui-types.ts";
import { GRID_COLS } from "./grid.ts";
import { setupLobbyUi, showLobbySection } from "./online-lobby-ui.ts";
import type { TransitionContext } from "./online-phase-transitions.ts";
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
  serializePlayers,
} from "./online-serialize.ts";
import { handleServerIncrementalMessage } from "./online-server-events.ts";
import { handleServerLifecycleMessage } from "./online-server-lifecycle.ts";
import { interpolateToward } from "./online-types.ts";
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
import { applyPiecePlacement } from "./phase-build.ts";
import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  PLAYER_NAMES,
} from "./player-config.ts";
import { CROSSHAIR_SPEED } from "./player-controller.ts";
import { MAX_UINT32 } from "./rng.ts";
import { loadAtlas } from "./sprites.ts";
import type { GameState } from "./types.ts";
import {
  BANNER_DURATION,
  BATTLE_COUNTDOWN,
  BATTLE_TIMER,
  BUILD_TIMER,
  CANNON_PLACE_TIMER,
  CannonMode,
  LOBBY_TIMER,
  Phase,
  SELECT_TIMER,
} from "./types.ts";

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
      type: MSG.GAME_OVER,
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
// Watcher state: timing, crosshairs, phantoms, migration announcement
const watcher = createWatcherState();

// @ts-ignore — import.meta.env is Vite-specific (not recognized by Deno LSP)
const DEV = import.meta.env?.DEV ?? (location?.hostname === "localhost");

/** Structured log for E2E test analysis (dev only). */
function log(msg: string): void {
  if (!DEV) return;
  const modeStr = isHost ? "host" : myPlayerId >= 0 ? "player" : "watcher";
  console.log(`[online] (mode=${modeStr} pid=${myPlayerId}) ${msg}`);
}

const LOG_THROTTLE_MS = 1000;
const MIGRATION_ANNOUNCEMENT_DURATION = 3;

/** Throttled log — logs at most once per second per key (dev only). */
const _throttleTimestamps = new Map<string, number>();
function logThrottled(key: string, msg: string): void {
  if (!DEV) return;
  const now = performance.now();
  const last = _throttleTimestamps.get(key) ?? 0;
  if (now - last < LOG_THROTTLE_MS) return;
  _throttleTimestamps.set(key, now);
  log(msg);
}

import { getWsUrl } from "./online-config.ts";

const KEEPALIVE_MS = 30_000;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

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
  ws.onopen = () => {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: MSG.PING }));
      }
    }, KEEPALIVE_MS);
  };
  ws.onclose = () => {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    const m = runtime.rs.mode;
    log(`WebSocket closed (mode=${Mode[m]} isHost=${isHost})`);
    if (!isHost && m !== Mode.STOPPED && m !== Mode.LOBBY) {
      runtime.rs.frame.announcement = "Disconnected from server";
      runtime.render();
      runtime.rs.mode = Mode.STOPPED;
    }
  };
  ws.onerror = () => {
    console.error("[online] WebSocket connection failed");
    createError.textContent = "Connection failed — is the server running?";
    joinError.textContent = "Connection failed — is the server running?";
  };
}

function send(msg: GameMessage): void {
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
  send({ type: MSG.AIM_UPDATE, playerId: pid, x, y });
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
  runtime.rs.mode = Mode.STOPPED;
  runtime.rs.lobby.active = false;
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
// Watcher tick context (built once, reused each frame)
// ---------------------------------------------------------------------------

const watcherTickCtx: WatcherTickContext = {
  getState: () => runtime.rs.state,
  getFrame: () => runtime.rs.frame,
  getAccum: () => runtime.rs.accum,
  getBattleAnim: () => runtime.rs.battleAnim,
  getControllers: () => runtime.rs.controllers,
  getMyPlayerId: () => myPlayerId,
  lastSentCannonPhantom,
  lastSentPiecePhantom,
  send: (msg) => send(msg as GameMessage),
  logThrottled,
  maybeSendAimUpdate,
  render: () => runtime.render(),
  now: () => performance.now(),
};

/** Checkpoint helper: pass watcher + runtime state to checkpoint functions. */
function checkpointArgs(msg: ServerMessage) {
  return [
    watcher, msg,
    runtime.rs.state, runtime.rs.battleAnim, runtime.rs.accum,
    () => runtime.snapshotTerritory(),
  ] as const;
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
    lobby: runtime.rs.lobby,
    maxPlayers: MAX_PLAYERS,
    now: () => performance.now(),
    setLobbyStartTime: (timeMs: number) => {
      lobbyStartTime = timeMs;
    },
    setModeLobby: () => {
      runtime.rs.mode = Mode.LOBBY;
    },
    setLastTime: (timeMs: number) => {
      runtime.rs.lastTime = timeMs;
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
    setControllers: (c) => { runtime.rs.controllers = c; },
    resetUIState: () => {
      runtime.resetUIState();
      // Online-specific resets
      resetWatcherState(watcher);
      lastSentAimTarget.clear();
      lastSentPiecePhantom.clear();
      lastSentCannonPhantom.clear();
    },
    createControllerForSlot: (i, gameState) => {
      const isAi = (i !== myPlayerId);
      const strategySeed = isAi ? gameState.rng.int(0, MAX_UINT32) : undefined;
      const kb = isAi ? undefined : settings.keyBindings[0]!;
      return createController(i, isAi, kb, strategySeed);
    },
    enterSelection: () => runtime.selection.enter(),
  });
}

// ---------------------------------------------------------------------------
// Host migration (promotion + full state transfer)
// ---------------------------------------------------------------------------

function promoteToHost(): void {
  log("PROMOTING TO HOST");
  isHost = true;

  const state = runtime.rs.state;
  const controllers = runtime.rs.controllers;

  // Rebuild controllers: keep self as human, convert everyone else to AI
  for (let i = 0; i < controllers.length; i++) {
    if (i === myPlayerId) continue;
    const player = state.players[i];
    if (!player || player.eliminated) continue;

    const strategySeed = state.rng.int(0, MAX_UINT32);
    controllers[i] = createController(i, true, undefined, strategySeed);

    // Re-initialize the AI for the current phase
    if (state.phase === Phase.WALL_BUILD) {
      controllers[i]!.startBuild(state);
    } else if (state.phase === Phase.CANNON_PLACE) {
      const max = state.cannonLimits[i] ?? 0;
      controllers[i]!.placeCannons(state, max);
      if (player.homeTower) {
        controllers[i]!.cannonCursor = { row: player.homeTower.row, col: player.homeTower.col };
      }
      controllers[i]!.onCannonPhaseStart(state);
    } else if (state.phase === Phase.BATTLE) {
      controllers[i]!.resetBattle(state);
    }
  }

  // Sync accumulators from watcher's wall-clock timer (reset all, then set current phase)
  const accum = runtime.rs.accum;
  accum.build = 0; accum.cannon = 0; accum.battle = 0; accum.grunt = 0; accum.select = 0;
  if (state.phase === Phase.WALL_BUILD) {
    accum.build = state.buildTimer - state.timer;
  } else if (state.phase === Phase.CANNON_PLACE) {
    accum.cannon = state.cannonPlaceTimer - state.timer;
  } else if (state.phase === Phase.BATTLE) {
    accum.battle = BATTLE_TIMER - state.timer;
  }

  // Handle special modes: skip animations that depend on old host's state
  const mode = runtime.rs.mode;
  if (mode === Mode.CASTLE_BUILD) {
    // Castle build animation was driven by old host — skip to cannon phase
    runtime.rs.castleBuilds = [];
    finalizeCastleConstruction(state);
    enterCannonPlacePhase(state);
    runtime.startCannonPhase();
    runtime.rs.mode = Mode.GAME;
    log("Skipped castle build animation → cannon phase");
  } else if (mode === Mode.LIFE_LOST) {
    // Life-lost dialog resolution depends on host — auto-continue all pending
    runtime.lifeLost.set(null);
    runtime.rs.mode = Mode.GAME;
    log("Cleared life-lost dialog → game mode");
  } else if (mode === Mode.BANNER || mode === Mode.BALLOON_ANIM) {
    // Visual transitions — skip to game mode
    runtime.rs.mode = Mode.GAME;
    log("Skipped banner/animation → game mode");
  }

  // Send full state so other watchers reconcile
  send(buildFullStateMessage(state));

  log("Promotion complete, now running as host");
}

function applyFullState(msg: FullStateMessage): void {
  const state = runtime.rs.state;
  applyFullStateSnapshot(state, msg);

  // Reset watcher timing to current moment
  watcher.timing.phaseStartTime = performance.now();
  watcher.timing.phaseDuration = state.timer;
  if (state.battleCountdown > 0) {
    watcher.timing.countdownStartTime = performance.now();
    watcher.timing.countdownDuration = state.battleCountdown;
  }
}

// ---------------------------------------------------------------------------
// Phase transition handlers (called from handleServerMessage, non-host only)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transition context (shared by all watcher phase transition handlers)
// ---------------------------------------------------------------------------

const transitionCtx: TransitionContext = {
  getState: () => runtime.rs.state,
  getMyPlayerId: () => myPlayerId,
  getControllers: () => runtime.rs.controllers,
  showBanner: (t, cb, r, nb) => runtime.showBanner(t, cb, r, nb),
  clearSelectionOverlay: () => {
    const overlay = runtime.rs.overlay;
    if (overlay.selection) {
      overlay.selection.highlights = undefined;
      overlay.selection.highlighted = null;
      overlay.selection.selected = null;
    }
  },
  now: () => performance.now(),
  setWatcherPhaseStartTime: (v) => { watcher.timing.phaseStartTime = v; },
  setWatcherPhaseDuration: (v) => { watcher.timing.phaseDuration = v; },
  setWatcherCountdownStartTime: (v) => { watcher.timing.countdownStartTime = v; },
  setWatcherCountdownDuration: (v) => { watcher.timing.countdownDuration = v; },
  setModeGame: () => { runtime.rs.mode = Mode.GAME; },
  setModeCastleBuild: () => { runtime.rs.mode = Mode.CASTLE_BUILD; },
  setModeBalloonAnim: () => { runtime.rs.mode = Mode.BALLOON_ANIM; },
  setModeStopped: () => { runtime.rs.mode = Mode.STOPPED; },
  battleCountdown: BATTLE_COUNTDOWN,
  bannerDuration: BANNER_DURATION,
  playerColors: PLAYER_COLORS,
  applyCannonStartData: (msg) => applyCannonStartData(...checkpointArgs(msg)),
  applyBattleStartData: (msg) => applyBattleStartData(...checkpointArgs(msg)),
  applyBuildStartData: (msg) => applyBuildStartData(...checkpointArgs(msg)),
  applyPlayersCheckpoint,
  resetZoneState,
  finalizeCastleConstruction,
  enterCannonPlacePhase,
  getSelectionStates: () => runtime.selection.getStates(),
  setCastleBuildFromPlans: (plans, maxTiles, onDone) => {
    runtime.rs.castleBuilds.push({ wallPlans: plans, maxTiles, tileIdx: 0, accum: 0, onDone });
    runtime.rs.castleBuildOnDone = onDone;
  },
  setBattleFlights: (v) => { runtime.rs.battleAnim.flights = v; },
  snapshotTerritory: () => runtime.snapshotTerritory(),
  showLifeLostDialog: (nr, el) => runtime.lifeLost.show(nr, el),
  render: () => runtime.render(),
  setGameOverFrame: (p) => { runtime.rs.frame.gameOver = p; },
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
      getState: () => runtime.rs.state,
      getLifeLostDialog: () => runtime.lifeLost.get(),
      clearLifeLostDialog: () => {
        runtime.lifeLost.set(null);
      },
      isLifeLostMode: () => runtime.rs.mode === Mode.LIFE_LOST,
      setGameMode: () => {
        runtime.rs.mode = Mode.GAME;
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
      lobbyJoined: runtime.rs.lobby.joined,
      occupiedSlots,
      remoteHumanSlots,
      getMyPlayerId: () => myPlayerId,
      setMyPlayerId: (playerId) => {
        myPlayerId = playerId;
      },
      createErrorEl: createError,
      joinErrorEl: joinError,
      initFromServer,
      enterTowerSelection: () => runtime.selection.enter(),
      onCastleWalls: (msg) => handleCastleWallsTransition(msg, transitionCtx),
      onCannonStart: (msg) => handleCannonStartTransition(msg, transitionCtx),
      onBattleStart: (msg) => handleBattleStartTransition(msg, transitionCtx),
      onBuildStart: (msg) => handleBuildStartTransition(msg, transitionCtx),
      onBuildEnd: (msg) => handleBuildEndTransition(msg, transitionCtx),
      onGameOver: (msg) => handleGameOverTransition(msg, transitionCtx),
      setAnnouncement: (text) => {
        watcher.migrationText = text;
        watcher.migrationTimer = MIGRATION_ANNOUNCEMENT_DURATION;
      },
      playerNames: PLAYER_NAMES,
      promoteToHost,
      applyFullState,
    })
  ) {
    return;
  }

  handleServerIncrementalMessage(msg, {
    log,
    isHost,
    getState: () => runtime.rs.state,
    remoteHumanSlots,
    selectionStates: runtime.selection.getStates(),
    syncSelectionOverlay: () => runtime.selection.syncOverlay(),
    isCastleReselectPhase: () => runtime.rs.state.phase === Phase.CASTLE_RESELECT,
    onRemotePlayerReselected: (playerId) => {
      markPlayerReselected(runtime.rs.state, playerId);
      runtime.rs.reselectionPids.push(playerId);
    },
    allSelectionsConfirmed: () => runtime.selection.allConfirmed(),
    finishReselection: () => runtime.selection.finishReselection(),
    finishSelection: () => runtime.selection.finish(),
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
    remoteCrosshairs: watcher.remoteCrosshairs,
    watcherOrbitParams: watcher.orbitParams,
    getRemotePiecePhantoms: () => watcher.remotePiecePhantoms,
    setRemotePiecePhantoms: (value) => {
      watcher.remotePiecePhantoms = value;
    },
    getRemoteCannonPhantoms: () => watcher.remoteCannonPhantoms,
    setRemoteCannonPhantoms: (value) => {
      watcher.remoteCannonPhantoms = value;
    },
    getLifeLostDialog: () => runtime.lifeLost.get(),
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
    send({ type: MSG.SELECT_SLOT, slotId: pid });
  },
  onCloseOptions: () => {
    if (runtime.rs.optionsReturnMode === null) {
      lobbyStartTime = performance.now();
    }
  },
  onTickLobbyExpired: () => {
    if (!isHost) return;
    // Host: build init message and relay to other clients, then process locally
    const initMsg: InitMessage = {
      type: MSG.INIT,
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
    send({ type: MSG.SELECT_START, timer: SELECT_TIMER });
  },

  // Networking callbacks
  tickNonHost: (dt) => tickWatcherFn(watcher, dt, watcherTickCtx),
  everyTick: (dt) => tickMigrationAnnouncementFn(watcher, runtime.rs.frame, dt),
  onLocalCrosshairCollected: (ctrl, ch, _readyCannon) => {
    if (isHost) {
      const target = ctrl.getCrosshairTarget() ?? ch;
      if (target) {
        const orbit = ctrl.getOrbitParams();
        const key = `${Math.round(target.x)},${Math.round(target.y)},${orbit ? "o" : ""}`;
        if (lastSentAimTarget.get(ctrl.playerId) !== key) {
          lastSentAimTarget.set(ctrl.playerId, key);
          send({
            type: MSG.AIM_UPDATE,
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
    const state = runtime.rs.state;
    logThrottled(
      "host-ch-remote",
      `collectCrosshairs: localCh=${crosshairs.length} remoteCrosshairs keys=[${[...watcher.remoteCrosshairs.keys()]}] cannons=[${state.players.map((p, i) => `P${i}:${p.cannons.length}`).join(",")}]`,
    );
    for (const [pid, target] of watcher.remoteCrosshairs) {
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
      let vis = watcher.crosshairPos.get(pid);
      if (!vis) {
        vis = { x: target.x, y: target.y };
        watcher.crosshairPos.set(pid, vis);
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
    remoteCannonPhantoms: () => watcher.remoteCannonPhantoms,
    remotePiecePhantoms: () => watcher.remotePiecePhantoms,
    lastSentCannonPhantom: () => lastSentCannonPhantom,
    lastSentPiecePhantom: () => lastSentPiecePhantom,
  },
  watcherTiming: watcher.timing,
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
