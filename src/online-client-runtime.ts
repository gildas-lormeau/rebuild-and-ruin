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
  clearReconnect,
  dedup,
  devLog,
  devLogThrottled,
  maybeSendAimUpdate,
  resetDedup,
  resetForNewGame,
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
import type { WatcherTickContext } from "./online-watcher-tick.ts";
import {
  applyBattleStartData,
  applyBuildStartData,
  applyCannonStartData,
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
  getState: () => runtime.rs.state,
  getMyPlayerId: () => session.myPlayerId,
  getControllers: () => runtime.rs.controllers,
  setMode: (mode: Mode) => {
    runtime.rs.mode = mode;
  },
  now: () => performance.now(),

  ui: {
    showBanner: (
      t: string,
      cb: () => void,
      r?: boolean,
      nb?: { territory: Set<number>[]; walls: Set<number>[] },
      sub?: string,
    ) => runtime.showBanner(t, cb, r, nb, sub),
    get banner() {
      return runtime.rs.banner;
    },
    render: () => runtime.render(),
    watcherTiming: watcher.timing,
    bannerDuration: BANNER_DURATION,
  },

  checkpoint: {
    applyCannonStart: (data) => applyCannonStartData(...checkpointArgs(data)),
    applyBattleStart: (data) => applyBattleStartData(...checkpointArgs(data)),
    applyBuildStart: (data) => applyBuildStartData(...checkpointArgs(data)),
    applyPlayers: applyPlayersCheckpoint,
  },

  selection: {
    clearSelectionOverlay: () => {
      const overlay = runtime.rs.overlay;
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
      runtime.rs.castleBuilds.push({
        wallPlans: plans,
        maxTiles,
        tileIdx: 0,
        accum: 0,
        onDone,
      });
      runtime.rs.castleBuildOnDone = onDone;
    },
    setCastleBuildViewport: (
      plans: readonly { playerId: number; tiles: number[] }[],
    ) => runtime.selection.setCastleBuildViewport(plans),
  },

  battle: {
    setFlights: (
      v: readonly {
        flight: {
          startX: number;
          startY: number;
          endX: number;
          endY: number;
        };
        progress: number;
      }[],
    ) => {
      runtime.rs.battleAnim.flights = v;
    },
    snapshotTerritory: () => runtime.snapshotTerritory(),
    beginBattle: () => runtime.phaseTicks.beginBattle(),
  },

  endPhase: {
    resetZoneState,
    showLifeLostDialog: (nr: readonly number[], el: readonly number[]) => {
      runtime.lifeLost.show(nr, el);
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
      runtime.rs.preScores = preScores;
      runtime.selection.showBuildScoreDeltas(onDone);
    },
    setGameOverFrame: (p: NonNullable<typeof runtime.rs.frame.gameOver>) => {
      runtime.rs.frame.gameOver = p;
    },
    playerColors: PLAYER_COLORS,
  },
};
// ── Watcher tick context ────────────────────────────────────────────
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
    if (runtime.rs.optionsReturnMode === null) {
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
  everyTick: (dt) => tickMigrationAnnouncementFn(watcher, runtime.rs.frame, dt),
  onLocalCrosshairCollected: (ctrl, ch) => {
    if (session.isHost)
      broadcastLocalCrosshair(ctrl, ch, {
        lastSentAimTarget: dedup.aimTarget,
        send,
      });
  },
  extendCrosshairs: (crosshairs, dt) =>
    extendWithRemoteCrosshairs(crosshairs, runtime.rs.state, dt, {
      remoteCrosshairs: watcher.remoteCrosshairs,
      crosshairPos: watcher.crosshairPos,
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
  tryPlaceCannonAndSend: (ctrl, gs, max) =>
    tryPlaceCannonAndSendAction(ctrl, gs, max, send),
  tryPlacePieceAndSend: (ctrl, gs) =>
    tryPlacePieceAndSendAction(ctrl, gs, send),
  fireAndSend: (ctrl, gs) => fireAndSendAction(ctrl, gs, send),
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
  runtime.rs.settings.seed = String(seed);
  initWaitingRoom({
    code,
    seed,
    lobbyEl: pageOnline,
    container: renderer.container,
    roomCodeOverlay,
    lobby: runtime.rs.lobby,
    maxPlayers: MAX_PLAYERS,
    now: () => performance.now(),
    setLobbyStartTime: (t: number) => {
      session.lobbyStartTime = t;
    },
    setModeLobby: () => {
      runtime.rs.mode = Mode.LOBBY;
    },
    setLastTime: (t: number) => {
      runtime.rs.lastTime = t;
    },
    requestFrame: () => {
      requestAnimationFrame(runtime.mainLoop);
    },
  });
}

export function initFromServer(msg: InitMessage): void {
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
    log: devLog,
    resetFrame: () => runtime.resetFrame(),
    setState: (s) => {
      runtime.rs.state = s;
    },
    setControllers: (c) => {
      runtime.rs.controllers = [...c];
    },
    resetUIState: () => {
      runtime.lifecycle.resetUIState();
      resetForNewGame();
    },
    createControllerForSlot: createOnlineControllerSlotFactory(
      session.myPlayerId,
      settings.keyBindings[0]!,
    ),
    enterSelection: () => runtime.selection.enter(),
  });
}

export function applyFullState(msg: FullStateMessage): void {
  const state = runtime.rs.state;
  const result = applyFullStateSnapshot(state, msg);
  if (!result) return; // Validation failed — no state was mutated

  applyFullStateUiRecovery(
    {
      setMode: (mode) => {
        runtime.rs.mode = mode;
      },
      onModeSet: (mode) => {
        if (mode === Mode.SELECTION) runtime.sound.drumsStart();
        else runtime.sound.drumsStop();
      },
      clearCastleBuilds: () => {
        runtime.rs.castleBuilds = [];
      },
      clearLifeLostDialog: () => {
        runtime.lifeLost.set(null);
      },
      clearAnnouncement: () => {
        runtime.rs.frame.announcement = undefined;
      },
      setBattleFlights: (flights) => {
        runtime.rs.battleAnim.flights = flights;
      },
    },
    state.phase,
    result.balloonFlights,
  );

  watcher.timing.phaseStartTime = performance.now();
  watcher.timing.phaseDuration = state.timer;
  if (state.battleCountdown > 0) {
    watcher.timing.countdownStartTime = performance.now();
    watcher.timing.countdownDuration = state.battleCountdown;
  }
}

// ── Checkpoint helper ───────────────────────────────────────────────
/** Build a positional arg tuple for applyCannonStartData / applyBattleStartData / applyBuildStartData.
 *  Spread as: `applyXxxData(...checkpointArgs(msg))`.
 *  Order is load-bearing — must match the shared function signatures:
 *    (watcher, data, state, battleAnim, accum, snapshotTerritory).
 *  If a signature changes, update this tuple to match. */
function checkpointArgs<T>(data: T) {
  return [
    watcher,
    data,
    runtime.rs.state,
    runtime.rs.battleAnim,
    runtime.rs.accum,
    () => runtime.snapshotTerritory(),
  ] as const;
}

// ── Functions that close over runtime ───────────────────────────────
function showLobby(): void {
  runtime.rs.mode = Mode.STOPPED;
  runtime.rs.lobby.active = false;
  renderer.container.classList.remove(GAME_CONTAINER_ACTIVE);
  roomCodeOverlay.style.display = "none";
  navigateTo("/online");
  resetSession();
}

// ── Side effects ────────────────────────────────────────────────────
runtime.registerInputHandlers();

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
