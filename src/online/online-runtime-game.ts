import { aiPickUpgrade } from "../ai/ai-upgrade-pick.ts";
import { executeCannonFire, executePlacePiece } from "../game/game-actions.ts";
import { createCanvasRenderer } from "../render/render-canvas.ts";
import { createGameRuntime } from "../runtime/runtime.ts";
import { setMode } from "../runtime/runtime-state.ts";
import type { GameRuntime } from "../runtime/runtime-types.ts";
import {
  DIFFICULTY_NORMAL,
  DIFFICULTY_PARAMS,
  SELECT_TIMER,
} from "../shared/game-constants.ts";
import { MAX_PLAYERS, PLAYER_NAMES } from "../shared/player-config.ts";
import type { ValidPlayerSlot } from "../shared/player-slot.ts";
import {
  type GameMessage,
  type InitMessage,
  MESSAGE,
} from "../shared/protocol.ts";
import { GAME_EXIT_EVENT } from "../shared/router.ts";
import { isHostInContext } from "../shared/tick-context.ts";
import { Mode } from "../shared/ui-mode.ts";
import { canvas } from "./online-dom.ts";
import {
  broadcastLocalCrosshair,
  extendWithRemoteCrosshairs,
} from "./online-host-crosshairs.ts";
import { initDeps } from "./online-runtime-deps.ts";
import { initPromote } from "./online-runtime-promote.ts";
import { createOnlineRuntimeSessionHelpers } from "./online-runtime-session.ts";
import { createOnlineTransitionContext } from "./online-runtime-transition.ts";
import { initWs } from "./online-runtime-ws.ts";
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
  serializePlayersCheckpoint,
} from "./online-serialize.ts";
import { defaultClient, RESET_SCOPE_NEW_GAME } from "./online-stores.ts";
import {
  tickMigrationAnnouncement,
  tickWatcher,
  type WatcherTickContext,
} from "./online-watcher-tick.ts";

// ── Client shorthand ───────────────────────────────────────────────
// Destructured from defaultClient singleton for brevity. All five names
// reference the same client instance — used throughout this module.
const { ctx, send, devLog, devLogThrottled, maybeSendAimUpdate } =
  defaultClient;
// ── DOM singletons (from centralized boundary) ─────────────────────
const renderer = createCanvasRenderer(canvas);
const sessionHelpers = createOnlineRuntimeSessionHelpers({
  getRuntime: () => runtime,
  session: ctx.session,
  watcher: ctx.watcher,
  resetNetworkingForNewGame: () => {
    defaultClient.resetNetworking(RESET_SCOPE_NEW_GAME);
  },
  destroyClient: () => {
    defaultClient.destroy();
  },
  log: devLog,
  container: renderer.container,
});
const transitionCtx = createOnlineTransitionContext({
  getRuntime: () => runtime,
  session: ctx.session,
  watcher: ctx.watcher,
});
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
  aiPick: aiPickUpgrade,
  // eslint-disable-next-line no-restricted-syntax -- bridge to runtime layer
  getIsHost: () => ctx.session.isHost,
  getMyPlayerId: () => ctx.session.myPlayerId,
  getRemotePlayerSlots: () => ctx.session.remotePlayerSlots,
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
  showLobby: sessionHelpers.showLobby,
  onLobbySlotJoined: (pid: ValidPlayerSlot) => {
    send({ type: MESSAGE.SELECT_SLOT, playerId: pid });
  },
  onCloseOptions: () => {
    if (runtime.runtimeState.optionsUI.returnMode === null) {
      ctx.session.lobbyStartTime = performance.now();
    }
  },
  onTickLobbyExpired: async () => {
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
    await sessionHelpers.initFromServer(initMsg);
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
        remotePlayerSlots: ctx.session.remotePlayerSlots,
        logThrottled: devLogThrottled,
      }),
    hostNetworking: {
      serializePlayers: serializePlayersCheckpoint,
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
      tryPlacePieceAndSend(
        ctrl,
        state,
        (intent) => executePlacePiece(runtime.runtimeState.state, intent, ctrl),
        send,
      ),
    fireAndSend: (ctrl, state) =>
      fireAndSend(
        ctrl,
        state,
        (intent) => executeCannonFire(runtime.runtimeState.state, intent, ctrl),
        send,
      ),
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
 *  handlers. Called once from online-client.ts after module evaluation.
 *
 *  ORDERING INVARIANT — the three init calls must execute in this order:
 *    1. initWs   — sets up WebSocket lifecycle (reconnect, mode reset)
 *    2. initPromote — sets up host promotion (requires runtime)
 *    3. initDeps — sets up server message dispatch (requires all of the above)
 *  Calling out of order will cause "called before init()" runtime errors. */
export function initOnlineRuntime(): void {
  // Step 1: WebSocket lifecycle
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

  // Step 2: Host promotion
  initPromote(runtime, defaultClient);

  // Step 3: Server message dispatch
  initDeps({
    runtime,
    initFromServer: sessionHelpers.initFromServer,
    restoreFullState: sessionHelpers.restoreFullState,
    showWaitingRoom: sessionHelpers.showWaitingRoom,
    transitionCtx,
    client: defaultClient,
  });

  document.addEventListener(GAME_EXIT_EVENT, () => {
    setMode(runtime.runtimeState, Mode.STOPPED);
    runtime.runtimeState.lobby.active = false;
    sessionHelpers.resetSession();
  });
}
