import {
  type FullStateMessage,
  type GameMessage,
  type InitMessage,
  MESSAGE,
} from "../../server/protocol.ts";
import { createCanvasRenderer } from "../render/render-canvas.ts";
import { precomputeTerrainCache } from "../render/render-map.ts";
import {
  GAME_CONTAINER_ACTIVE,
  GAME_EXIT_EVENT,
  navigateTo,
} from "../runtime/router.ts";
import { createGameRuntime, type GameRuntime } from "../runtime/runtime.ts";
import {
  bootstrapGame,
  initWaitingRoom,
} from "../runtime/runtime-bootstrap.ts";
import { setMode } from "../runtime/runtime-state.ts";
import { LifeLostChoice } from "../shared/dialog-types.ts";
import {
  BANNER_DURATION,
  DIFFICULTY_NORMAL,
  DIFFICULTY_PARAMS,
  SELECT_TIMER,
} from "../shared/game-constants.ts";
import {
  MAX_PLAYERS,
  PLAYER_COLORS,
  PLAYER_NAMES,
} from "../shared/player-config.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import { isHostInContext } from "../shared/tick-context.ts";
import { Mode } from "../shared/ui-mode.ts";
import type { UpgradeId } from "../shared/upgrade-defs.ts";
import {
  applyBattleStartCheckpoint,
  applyBuildEndCheckpoint,
  applyBuildStartCheckpoint,
  applyCannonStartCheckpoint,
  type CheckpointDeps,
} from "./online-checkpoints.ts";
import { canvas, pageOnline, roomCodeOverlay } from "./online-dom.ts";
import { restoreFullStateUiRecovery } from "./online-full-state-recovery.ts";
import {
  broadcastLocalCrosshair,
  extendWithRemoteCrosshairs,
} from "./online-host-crosshairs.ts";
import {
  buildRoomCodeOverlay,
  hideRoomCodeOverlay,
} from "./online-lobby-ui.ts";
import type { TransitionContext } from "./online-phase-transitions.ts";
import {
  fireAndSend,
  tryPlaceCannonAndSend,
  tryPlacePieceAndSend,
} from "./online-send-actions.ts";
import {
  createBattleStartMessage,
  createBuildStartMessage,
  createCannonStartMessage,
  createGameOverPayload,
  restoreFullStateSnapshot,
  serializePlayers,
} from "./online-serialize.ts";
import { defaultClient, RESET_SCOPE_NEW_GAME } from "./online-stores.ts";
import { setWatcherPhaseTimer } from "./online-types.ts";
import {
  tickMigrationAnnouncement,
  tickWatcher,
  type WatcherTickContext,
} from "./online-watcher-tick.ts";
import { initDeps } from "./runtime-online-deps.ts";
import { initPromote } from "./runtime-online-promote.ts";
import { initWs } from "./runtime-online-ws.ts";

// ── Client shorthand ───────────────────────────────────────────────
// Destructured from defaultClient singleton for brevity. All five names
// reference the same client instance — used throughout this module.
const { ctx, send, devLog, devLogThrottled, maybeSendAimUpdate } =
  defaultClient;
// ── DOM singletons (from centralized boundary) ─────────────────────
const renderer = createCanvasRenderer(canvas);
// ── Assemble transition context ─────────────────────────────────────
const transitionCtx: TransitionContext = {
  getState: () => runtime.runtimeState.state,
  session: ctx.session,
  getControllers: () => runtime.runtimeState.controllers,
  setMode: (mode: Mode) => {
    setMode(runtime.runtimeState, mode);
  },
  ui: buildTransitionUiCtx(),
  checkpoint: buildTransitionCheckpointCtx(),
  selection: buildTransitionSelectionCtx(),
  battleLifecycle: buildTransitionBattleCtx(),
  endPhase: buildTransitionEndPhaseCtx(),
  upgradePick: {
    prepare: () => runtime.upgradePick.prepare(),
    tryShow: (onDone) => {
      const shown = runtime.upgradePick.tryShow(onDone);
      // Drain early picks (race: watcher sent pick before host created dialog)
      if (shown) {
        const dialog = runtime.upgradePick.get();
        if (dialog) {
          for (const [pid, choice] of ctx.session.earlyUpgradePickChoices) {
            const entry = dialog.entries.find(
              (en) =>
                en.playerId === pid &&
                en.choice === null &&
                en.offers.includes(choice as UpgradeId),
            );
            if (entry) entry.choice = choice as UpgradeId;
          }
          ctx.session.earlyUpgradePickChoices.clear();
        }
      }
      return shown;
    },
  },
};
// ── Watcher tick context ────────────────────────────────────────────
const watcherTickCtx: WatcherTickContext = {
  getState: () => runtime.runtimeState.state,
  getFrame: () => runtime.runtimeState.frame,
  getAccum: () => runtime.runtimeState.accum,
  getBattleAnim: () => runtime.runtimeState.battleAnim,
  getControllers: () => runtime.runtimeState.controllers,
  session: ctx.session,
  dedup: ctx.dedup,
  send: (msg) => send(msg as GameMessage),
  logThrottled: devLogThrottled,
  maybeSendAimUpdate,
  render: () => runtime.render(),
  now: () => performance.now(),
};
// ── Runtime creation ────────────────────────────────────────────────
const runtime: GameRuntime = createGameRuntime({
  renderer,
  send,
  // eslint-disable-next-line no-restricted-syntax -- bridge to runtime layer
  getIsHost: () => ctx.session.isHost,
  getMyPlayerId: () => ctx.session.myPlayerId,
  getRemoteHumanSlots: () => ctx.session.remoteHumanSlots,
  log: devLog,
  logThrottled: devLogThrottled,
  // -1 grace: server fires setTimeout(waitSec * 1000) exactly at waitSec.
  // Subtracting 1 ensures the client shows 0 one second early, so the UI
  // never displays "1" while the server is already starting the game.
  getLobbyRemaining: () =>
    Math.max(
      0,
      ctx.session.roomWaitTimerSec -
        1 -
        (performance.now() - ctx.session.lobbyStartTime) / 1000,
    ),
  getUrlRoundsOverride: () => {
    const param = new URL(location.href).searchParams.get("rounds");
    return param ? Number(param) : 0;
  },
  showLobby,
  onLobbySlotJoined: (pid: ValidPlayerSlot) => {
    send({ type: MESSAGE.SELECT_SLOT, playerId: pid });
  },
  onCloseOptions: () => {
    if (runtime.runtimeState.optionsUI.returnMode === null) {
      ctx.session.lobbyStartTime = performance.now();
    }
  },
  onTickLobbyExpired: () => {
    if (!isHostInContext(ctx.session)) return;
    const diffParams =
      DIFFICULTY_PARAMS[runtime.runtimeState.settings.difficulty] ??
      DIFFICULTY_PARAMS[DIFFICULTY_NORMAL]!;
    const initMsg: InitMessage = {
      type: MESSAGE.INIT,
      seed: ctx.session.roomSeed,
      playerCount: MAX_PLAYERS,
      settings: {
        maxRounds: ctx.session.roomMaxRounds,
        cannonMaxHp: ctx.session.roomCannonMaxHp,
        buildTimer: diffParams.buildTimer,
        cannonPlaceTimer: diffParams.cannonPlaceTimer,
        firstRoundCannons: diffParams.firstRoundCannons,
        gameMode: ctx.session.roomGameMode,
      },
    };
    send(initMsg);
    initFromServer(initMsg);
    send({ type: MESSAGE.SELECT_START, timer: SELECT_TIMER });
  },

  onlineConfig: {
    tickNonHost: (dt) => tickWatcher(ctx.watcher, dt, watcherTickCtx),
    everyTick: (dt) =>
      tickMigrationAnnouncement(ctx.watcher, runtime.runtimeState.frame, dt),
    onLocalCrosshairCollected: (ctrl, crosshair) => {
      if (isHostInContext(ctx.session))
        broadcastLocalCrosshair(ctrl, crosshair, {
          lastSentAimTarget: ctx.dedup.aimTarget,
          send,
        });
    },
    extendCrosshairs: (crosshairs, dt) =>
      extendWithRemoteCrosshairs(crosshairs, runtime.runtimeState.state, dt, {
        remoteCrosshairs: ctx.watcher.remoteCrosshairs,
        watcherCrosshairPos: ctx.watcher.watcherCrosshairPos,
        remoteHumanSlots: ctx.session.remoteHumanSlots,
        logThrottled: devLogThrottled,
      }),
    hostNetworking: {
      serializePlayers,
      createCannonStartMessage,
      createBattleStartMessage,
      createBuildStartMessage,
      remoteCannonPhantoms: () => ctx.watcher.remoteCannonPhantoms,
      remotePiecePhantoms: () => ctx.watcher.remotePiecePhantoms,
      lastSentCannonPhantom: () => ctx.dedup.cannonPhantom,
      lastSentPiecePhantom: () => ctx.dedup.piecePhantom,
    },
    watcherTiming: ctx.watcher.timing,
    maybeSendAimUpdate,
    tryPlaceCannonAndSend: (ctrl, state, maxSlots) =>
      tryPlaceCannonAndSend(ctrl, state, maxSlots, send),
    tryPlacePieceAndSend: (ctrl, state) =>
      tryPlacePieceAndSend(ctrl, state, send),
    fireAndSend: (ctrl, state) => fireAndSend(ctrl, state, send),
    onEndGame: (winner, gameState) => {
      const payloads = createGameOverPayload(winner, gameState, PLAYER_NAMES);
      devLog(
        `endGame winner=${payloads.winnerName} round=${gameState.round} maxRounds=${gameState.maxRounds}`,
      );
      if (isHostInContext(ctx.session)) send(payloads.serverPayload);
    },
  },
});

// ── Initialize dependent modules and register handlers ─────────────
/** Wire runtime into ws/promote/deps modules and register input + exit
 *  handlers. Called once from online-client.ts after module evaluation. */
export function initOnlineRuntime(): void {
  initWs(
    {
      getMode: () => runtime.runtimeState.mode,
      setMode: (mode) => {
        setMode(runtime.runtimeState, mode);
      },
      setAnnouncement: (text) => {
        runtime.runtimeState.frame.announcement = text;
      },
      render: () => runtime.render(),
    },
    defaultClient,
  );

  initPromote(runtime, defaultClient);

  initDeps({
    runtime,
    initFromServer,
    restoreFullState,
    showWaitingRoom,
    transitionCtx,
    client: defaultClient,
  });

  document.addEventListener(GAME_EXIT_EVENT, () => {
    setMode(runtime.runtimeState, Mode.STOPPED);
    runtime.runtimeState.lobby.active = false;
    hideRoomCodeOverlay(roomCodeOverlay);
    resetSession();
  });
}

function buildTransitionUiCtx(): TransitionContext["ui"] {
  return {
    showBanner: (text, onDone, preservePrevScene?, newBattle?, subtitle?) =>
      runtime.showBanner(text, onDone, preservePrevScene, newBattle, subtitle),
    get banner() {
      return runtime.runtimeState.banner;
    },
    render: () => runtime.render(),
    watcherTiming: ctx.watcher.timing,
    bannerDuration: BANNER_DURATION,
  };
}

function buildTransitionCheckpointCtx(): TransitionContext["checkpoint"] {
  return {
    applyCannonStart: (data, capturePreState) =>
      applyCannonStartCheckpoint(data, buildCheckpointDeps(), capturePreState),
    applyBattleStart: (data, capturePreState) =>
      applyBattleStartCheckpoint(data, buildCheckpointDeps(), capturePreState),
    applyBuildStart: (data) =>
      applyBuildStartCheckpoint(data, buildCheckpointDeps()),
    applyBuildEnd: applyBuildEndCheckpoint,
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
      });
      runtime.runtimeState.castleBuildOnDone = onDone;
    },
    setCastleBuildViewport: (plans) =>
      runtime.selection.setCastleBuildViewport(plans),
  };
}

function buildTransitionBattleCtx(): TransitionContext["battleLifecycle"] {
  return {
    setFlights: (flights) => {
      runtime.runtimeState.battleAnim.flights = flights;
    },
    snapshotTerritory: () => runtime.snapshotTerritory(),
    getTerritory: () => runtime.runtimeState.battleAnim.territory,
    getWalls: () => runtime.runtimeState.battleAnim.walls,
    beginBattle: () => runtime.phaseTicks.beginBattle(),
  };
}

function buildTransitionEndPhaseCtx(): TransitionContext["endPhase"] {
  return {
    showLifeLostDialog: (needsReselect, eliminated) => {
      runtime.lifeLost.tryShow(needsReselect, eliminated);
      const dialog = runtime.lifeLost.get();
      if (dialog) {
        for (const [pid, choice] of ctx.session.earlyLifeLostChoices) {
          const entry = dialog.entries.find((e) => e.playerId === pid);
          if (entry && entry.choice === LifeLostChoice.PENDING)
            entry.choice = choice;
        }
      }
      ctx.session.earlyLifeLostChoices.clear();
    },
    showScoreDeltas: (preScores, onDone) => {
      runtime.scoreDelta.setPreScores(preScores);
      runtime.scoreDelta.show(onDone);
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
    remoteCrosshairs: ctx.watcher.remoteCrosshairs,
    watcherCrosshairPos: ctx.watcher.watcherCrosshairPos,
    watcherOrbitParams: ctx.watcher.watcherOrbitParams,
    watcherOrbitAngles: ctx.watcher.watcherOrbitAngles,
    snapshotTerritory: () => runtime.snapshotTerritory(),
  };
}

// ── Functions that close over runtime ───────────────────────────────
function showLobby(): void {
  setMode(runtime.runtimeState, Mode.STOPPED);
  runtime.runtimeState.lobby.active = false;
  renderer.container.classList.remove(GAME_CONTAINER_ACTIVE);
  hideRoomCodeOverlay(roomCodeOverlay);
  navigateTo("/online");
  resetSession();
}

function showWaitingRoom(code: string, seed: number): void {
  ctx.session.roomSeed = seed;
  runtime.runtimeState.settings.seed = String(seed);
  const joinUrl = `${location.origin}${location.pathname}?server=${location.host}&join=${code}`;
  buildRoomCodeOverlay(roomCodeOverlay, code, joinUrl);
  initWaitingRoom({
    seed,
    lobbyEl: pageOnline,
    container: renderer.container,
    lobby: runtime.runtimeState.lobby,
    maxPlayers: MAX_PLAYERS,
    log: devLog,
    setLobbyStartTime: (timestamp: number) => {
      ctx.session.lobbyStartTime = timestamp;
    },
    setModeLobby: () => {
      setMode(runtime.runtimeState, Mode.LOBBY);
    },
    setLastTime: (timestamp: number) => {
      runtime.runtimeState.lastTime = timestamp;
    },
    requestFrame: () => {
      requestAnimationFrame(runtime.mainLoop);
    },
  });
  precomputeTerrainCache(runtime.runtimeState.lobby.map!);
}

function initFromServer(msg: InitMessage): void {
  hideRoomCodeOverlay(roomCodeOverlay);
  runtime.runtimeState.lobby.active = false;
  const settings = runtime.runtimeState.settings;
  const playerCount = Math.min(Math.max(1, msg.playerCount), MAX_PLAYERS);
  const humanSlots = Array.from(
    { length: playerCount },
    (_, i) => i === ctx.session.myPlayerId,
  );
  const keyBindings = Array.from({ length: playerCount }, (_, i) =>
    i === ctx.session.myPlayerId ? settings.keyBindings[0] : undefined,
  );
  bootstrapGame({
    seed: msg.seed,
    maxPlayers: playerCount,
    existingMap: runtime.runtimeState.lobby.map ?? undefined,
    maxRounds: msg.settings.maxRounds,
    cannonMaxHp: msg.settings.cannonMaxHp,
    buildTimer: msg.settings.buildTimer,
    cannonPlaceTimer: msg.settings.cannonPlaceTimer,
    firstRoundCannons: msg.settings.firstRoundCannons,
    gameMode: msg.settings.gameMode,
    humanSlots,
    keyBindings,
    difficulty: settings.difficulty,
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
      defaultClient.resetNetworking(RESET_SCOPE_NEW_GAME);
    },
    enterSelection: () => runtime.selection.enter(),
  });
}

function restoreFullState(msg: FullStateMessage): void {
  const state = runtime.runtimeState.state;
  const result = restoreFullStateSnapshot(state, msg);
  if (!result) return; // Validation failed — no state was mutated

  restoreFullStateUiRecovery(
    {
      setMode: (mode) => {
        setMode(runtime.runtimeState, mode);
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

  setWatcherPhaseTimer(ctx.watcher.timing, performance.now(), state.timer);
  if (state.battleCountdown > 0) {
    ctx.watcher.timing.countdownStartTime = performance.now();
    ctx.watcher.timing.countdownDuration = state.battleCountdown;
  }
}

function resetSession(): void {
  defaultClient.destroy();
  runtime.runtimeState.settings.seed = "";
}
